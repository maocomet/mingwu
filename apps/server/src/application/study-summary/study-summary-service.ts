import { randomUUID } from 'node:crypto';
import type {
  HistoryTerminalStatus,
  StudySessionStatus,
  StudySummary,
  PutStudySummaryInput,
} from '@mingwu/contracts';
import {
  HISTORY_TERMINAL_STATUSES,
  SUMMARY_CONTENT_MAX_LENGTH,
  countCodePoints,
} from '@mingwu/contracts';
import {
  StudySummaryContentInvalidError,
  StudySummaryExpectedRevisionInvalidError,
  StudySummaryIdempotencyConflictError,
  StudySummaryNotFoundError,
  StudySummaryRevisionConflictError,
  StudySummarySessionNotTerminalError,
} from '../../domain/study-summary/errors.js';
import type { StudySummaryRepository } from '../../domain/study-summary/repository.js';
import { StudySessionNotFoundError } from '../../domain/study-session/errors.js';
import type { StudySessionRepository } from '../../domain/study-session/repository.js';

export interface PutStudySummaryResult {
  summary: StudySummary;
  created: boolean;
}

/** status 是否为历史 / 总结允许的终态（completed / cancelled / interrupted）。 */
function isTerminalStatus(status: StudySessionStatus): status is HistoryTerminalStatus {
  return HISTORY_TERMINAL_STATUSES.some((s) => s === status);
}

/**
 * StudySummary 正式学习总结：一个 Session 最多一份，可反复修改但不新增第二份。
 *
 * 重试与并发语义（不得产生第二份 Summary、不得静默覆盖新内容）：
 * - `expectedRevision=0` 创建路径：仓储 `createIfAbsent` 原子唯一。初次创建 201；
 *   并发 / 网络重试撞上已存在总结时，若请求的 content+source 与已有内容完全一致，
 *   视为同一请求的幂等重试，返回已有总结（created=false → 200），不再创建第二份、
 *   也不推进 revision；若内容不一致，抛 StudySummaryIdempotencyConflictError（409），
 *   绝不静默覆盖已确认内容。
 * - `expectedRevision>0` 更新路径：以 existing.revision+1 构造新值后走仓储 CAS
 *   `updateIfRevision(expectedRevision)`。revision 已被推进（陈旧版本 / 并发修改 /
 *   更新后重试）或总结不存在 → CAS 返回 null，抛 StudySummaryRevisionConflictError（409），
 *   revision 最多 +1 一次。20 个相同 expectedRevision 的并发修改最多一个成功。
 *
 * 服务端时间与身份边界：
 * - 每次用户确认保存时由服务端单次采样 now 写入 / 刷新 confirmedByUserAt 与 updatedAt，
 *   客户端不得提交这些字段；id 由服务端生成（randomUUID），createdAt 初次写入后不变。
 * - 本批统一用户认证尚未接入：本服务为未来“已认证用户路由”边界，不新增可由客户端
 *   指定的用户身份字段。
 */
export class StudySummaryService {
  constructor(
    private readonly summaryRepository: StudySummaryRepository,
    private readonly sessionRepository: StudySessionRepository,
    /**
     * 可注入时钟（返回 ISO 字符串）。默认取当前 UTC 时间；
     * 测试传入固定时钟以稳定断言 confirmedByUserAt 等服务端时间写入。
     */
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}

  /**
   * 读取 Session 的正式总结（只读）。Session 不存在抛 StudySessionNotFoundError（404，
   * 与 Summary 不存在的 404 使用不同错误码）；Summary 不存在抛 StudySummaryNotFoundError（404）。
   */
  async getBySessionId(studySessionId: string): Promise<StudySummary> {
    const session = await this.sessionRepository.findById(studySessionId);
    if (!session) {
      throw new StudySessionNotFoundError(studySessionId);
    }
    const summary = await this.summaryRepository.findByStudySessionId(studySessionId);
    if (!summary) {
      throw new StudySummaryNotFoundError(studySessionId);
    }
    return summary;
  }

  /**
   * 创建或修改正式学习总结（PUT）。返回 created 由路由层映射为 201 / 200。
   * - Session 不存在 → 404；Session 非终态 → 409（活动 / 草稿不得提交正式总结）；
   * - content 去除首尾空白后非空且按 Unicode code point 计数不超过
   *   SUMMARY_CONTENT_MAX_LENGTH（与 JSON Schema maxLength 语义一致），否则 400；
   * - expectedRevision 必须是非负整数（服务层自守，schema 已先行拦截）；
   * - 创建路径 expectedRevision=0；更新路径必须提供当前 revision。
   */
  async putBySessionId(
    studySessionId: string,
    input: PutStudySummaryInput,
  ): Promise<PutStudySummaryResult> {
    if (!Number.isInteger(input.expectedRevision) || input.expectedRevision < 0) {
      throw new StudySummaryExpectedRevisionInvalidError(studySessionId);
    }
    const content = input.content.trim();
    if (content === '' || countCodePoints(content) > SUMMARY_CONTENT_MAX_LENGTH) {
      throw new StudySummaryContentInvalidError(studySessionId);
    }
    const session = await this.sessionRepository.findById(studySessionId);
    if (!session) {
      throw new StudySessionNotFoundError(studySessionId);
    }
    if (!isTerminalStatus(session.status)) {
      throw new StudySummarySessionNotTerminalError(studySessionId);
    }

    if (input.expectedRevision === 0) {
      return this.create(studySessionId, content, input.source);
    }
    return this.update(studySessionId, content, input.source, input.expectedRevision);
  }

  /** 创建路径：仓储原子唯一，重试撞车按幂等或冲突处理，不产生第二份。 */
  private async create(
    studySessionId: string,
    content: string,
    source: PutStudySummaryInput['source'],
  ): Promise<PutStudySummaryResult> {
    const now = this.now();
    const summary: StudySummary = {
      id: randomUUID(),
      studySessionId,
      content,
      source,
      revision: 1,
      confirmedByUserAt: now,
      createdAt: now,
      updatedAt: now,
    };
    const { summary: existing, created } = await this.summaryRepository.createIfAbsent(summary);
    if (created) {
      return { summary, created: true };
    }
    // 已存在：内容完全一致视为同一请求的幂等重试；不一致 → 冲突，不得覆盖。
    if (existing.content === content && existing.source === source) {
      return { summary: existing, created: false };
    }
    throw new StudySummaryIdempotencyConflictError(studySessionId);
  }

  /** 更新路径：revision+1 后走仓储 CAS，陈旧 revision 或总结不存在 → 409。 */
  private async update(
    studySessionId: string,
    content: string,
    source: PutStudySummaryInput['source'],
    expectedRevision: number,
  ): Promise<PutStudySummaryResult> {
    const existing = await this.summaryRepository.findByStudySessionId(studySessionId);
    if (!existing) {
      // 期望 revision>0 但尚无总结：前置条件不满足，按 revision 冲突处理（409）。
      throw new StudySummaryRevisionConflictError(studySessionId, expectedRevision);
    }
    const now = this.now();
    const updated: StudySummary = {
      ...existing,
      content,
      source,
      revision: existing.revision + 1,
      confirmedByUserAt: now,
      updatedAt: now,
    };
    const saved = await this.summaryRepository.updateIfRevision(updated, expectedRevision);
    if (!saved) {
      throw new StudySummaryRevisionConflictError(studySessionId, expectedRevision);
    }
    return { summary: saved, created: false };
  }
}
