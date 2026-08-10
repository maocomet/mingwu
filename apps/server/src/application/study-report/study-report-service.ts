import type {
  AppendStudyReportInput,
  AuthenticatedAiActorContext,
  StudyParticipant,
  StudyReport,
} from '@mingwu/contracts';
import {
  AI_ACTOR_CODE_MAX_LENGTH,
  AI_ACTOR_TYPES,
  HISTORY_TERMINAL_STATUSES,
  STUDY_REPORT_CONTENT_MAX_LENGTH,
  UUID_PATTERN,
  countCodePoints,
} from '@mingwu/contracts';
import { StudyActorContextInvalidError } from '../../domain/study-actor/errors.js';
import { StudyParticipantUpdateError } from '../../domain/study-participant/errors.js';
import type { StudyParticipantRepository } from '../../domain/study-participant/repository.js';
import {
  StudyReportContentInvalidError,
  StudyReportIdInvalidError,
  StudyReportSessionNotActiveError,
} from '../../domain/study-report/errors.js';
import type { StudyReportRepository } from '../../domain/study-report/repository.js';
import { StudySessionNotFoundError } from '../../domain/study-session/errors.js';
import type { StudySessionRepository } from '../../domain/study-session/repository.js';

const UUID_REGEX = new RegExp(UUID_PATTERN);

/**
 * 允许追加报告的 Session 状态：已开始（running / paused）或任意终态；
 * created 草稿 Session 拒绝。
 */
const REPORT_APPENDABLE_STATUSES = new Set<string>([
  'running',
  'paused',
  ...HISTORY_TERMINAL_STATUSES,
]);

/**
 * StudyReport 追加式学习报告服务。只提供“追加 + 只读列表”能力，不提供修改、
 * 覆盖或删除报告的方法。身份边界：
 * - 公开 input 只包含 id / studySessionId / content；
 * - actorId 只从 AuthenticatedAiActorContext 读取（未来由认证中间件 / MCP 授权层
 *   构造），不新增可由客户端指定的身份字段；
 * - 测试构造的受信上下文不意味真实认证已完成。
 *
 * 身份防线：
 * - 受信上下文必须在写入前通过防守性校验：actorId 是合法 UUID、actorCode 非空
 *   且不超过受控长度、actorType 在既定三种类型内；非法上下文抛
 *   StudyActorContextInvalidError（不泄露身份值），不得写入任何报告或 Participant；
 * - 本批不对 actorType 做权限过滤——权限由未来 permission profile / 授权层决定。
 *
 * 并发与幂等：
 * - 序号分配与插入由仓储原子完成，20 个同 Actor 不同 id 并发追加全部成功、
 *   序号唯一连续；
 * - 同 id + 同 Session + 同认证 Actor + 同规范化正文重试 → 幂等返回已有报告；
 *   同 id 不同语义 → 仓储抛受控冲突，绝不覆盖。
 *
 * Participant 时间语义：
 * - 活动时间以仓储返回的真实 report.submittedAt 为准（新报告 = 本次提交时间，
 *   幂等命中 = 原报告提交时间），绝不用“重试请求时间”伪造活跃；
 * - upsert 时 lastActiveAt 由仓储取现值与传入时间的较晚者，旧报告重试不倒退。
 *
 * 跨仓储一致性（内存阶段）：报告先写入，成功后 upsert Participant（首次写
 * joinedAt，后续只刷新 lastActiveAt）；若 Participant 更新失败，如实抛
 * StudyParticipantUpdateError（接口返回失败，不假装全部成功），内存阶段已写入的
 * 报告不回滚。恢复约定：调用方收到 Participant 失败后必须使用同一幂等 id 重试，
 * 重试命中已有报告后以原 report.submittedAt 补建 Participant，报告仍只有一份、
 * 序号不推进；PostgreSQL 阶段必须把“分配序号 + 插入报告 + upsert Participant”
 * 放进同一事务，失败整体回滚。
 */
export class StudyReportService {
  constructor(
    private readonly reportRepository: StudyReportRepository,
    private readonly participantRepository: StudyParticipantRepository,
    private readonly sessionRepository: StudySessionRepository,
    /**
     * 可注入时钟（返回 ISO 字符串）。默认取当前 UTC 时间；
     * 测试传入固定时钟以稳定断言 submittedAt / joinedAt / lastActiveAt。
     */
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}

  /**
   * 追加一份 AI 学习报告。
   * - id 非 UUID、content trim 后为空或超长 → 400；
   * - 受信上下文非法（非 UUID actorId / 空或超长 actorCode / 非法 actorType）→
   *   内部受控错误，不写入任何报告或 Participant；
   * - Session 不存在 → 404（study_session_not_found）；
   * - created 草稿 Session → 409（study_report_session_not_active）；
   * - 追加成功后返回完整报告（含服务端分配的 sequenceNumber 与 submittedAt）。
   */
  async appendReport(
    authContext: AuthenticatedAiActorContext,
    input: AppendStudyReportInput,
  ): Promise<StudyReport> {
    if (!UUID_REGEX.test(input.id)) {
      throw new StudyReportIdInvalidError(input.id);
    }
    const content = input.content.trim();
    if (content === '' || countCodePoints(content) > STUDY_REPORT_CONTENT_MAX_LENGTH) {
      throw new StudyReportContentInvalidError(input.studySessionId);
    }
    this.assertValidActorContext(authContext);
    const session = await this.sessionRepository.findById(input.studySessionId);
    if (!session) {
      throw new StudySessionNotFoundError(input.studySessionId);
    }
    if (!REPORT_APPENDABLE_STATUSES.has(session.status)) {
      throw new StudyReportSessionNotActiveError(input.studySessionId);
    }
    const now = this.now();
    const { report } = await this.reportRepository.appendReport({
      id: input.id,
      studySessionId: input.studySessionId,
      actorId: authContext.actorId,
      content,
      submittedAt: now,
    });
    // 活动时间以仓储返回的真实 report.submittedAt 为准：真正新增 = 本次提交时间；
    // 幂等命中已有报告 = 原报告提交时间，绝不使用“重试请求时间”。lastActiveAt
    // 单调由仓储取较晚者，旧报告重试不使时间倒退。
    try {
      await this.participantRepository.upsert({
        studySessionId: input.studySessionId,
        actorId: authContext.actorId,
        joinedAt: report.submittedAt,
        lastActiveAt: report.submittedAt,
      });
    } catch {
      throw new StudyParticipantUpdateError(input.studySessionId, authContext.actorId);
    }
    return report;
  }

  /**
   * 对受信上下文做写入前防守性校验（第二关 AIActor 模型对齐）。校验失败抛
   * StudyActorContextInvalidError，消息不泄露 actorId / actorCode 等身份值。
   */
  private assertValidActorContext(authContext: AuthenticatedAiActorContext): void {
    const valid =
      UUID_REGEX.test(authContext.actorId) &&
      authContext.actorCode.trim() !== '' &&
      authContext.actorCode.length <= AI_ACTOR_CODE_MAX_LENGTH &&
      (AI_ACTOR_TYPES as readonly string[]).includes(authContext.actorType);
    if (!valid) {
      throw new StudyActorContextInvalidError();
    }
  }

  /** 列出 Session 的全部 AI 参与者，按 joinedAt ASC, actorId ASC 稳定排序。 */
  async listParticipants(studySessionId: string): Promise<StudyParticipant[]> {
    const participants = await this.participantRepository.listBySession(studySessionId);
    participants.sort(
      (a, b) => a.joinedAt.localeCompare(b.joinedAt) || a.actorId.localeCompare(b.actorId),
    );
    return participants;
  }

  /** 列出 Session 的全部报告，按 submittedAt ASC, actorId ASC, sequenceNumber ASC 稳定排序。 */
  async listReports(studySessionId: string): Promise<StudyReport[]> {
    const reports = await this.reportRepository.listBySession(studySessionId);
    reports.sort(
      (a, b) =>
        a.submittedAt.localeCompare(b.submittedAt) ||
        a.actorId.localeCompare(b.actorId) ||
        a.sequenceNumber - b.sequenceNumber,
    );
    return reports;
  }
}
