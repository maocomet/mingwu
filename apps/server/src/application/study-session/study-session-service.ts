import type {
  CreateStudySessionInput,
  SetCountdownInput,
  SetTaskInput,
  StudySession,
} from '@mingwu/contracts';
import {
  MAX_PLANNED_DURATION_SECONDS,
  MIN_PLANNED_DURATION_SECONDS,
  TASK_TEXT_MAX_LENGTH,
} from '@mingwu/contracts';
import {
  StudySessionIdempotencyConflictError,
  StudySessionNotFoundError,
  StudySessionPlannedDurationInvalidError,
  StudySessionStatusConflictError,
  StudySessionTaskTextInvalidError,
  StudySessionTimerModeConflictError,
  StudySessionVersionConflictError,
} from '../../domain/study-session/errors.js';
import type { StudySessionRepository } from '../../domain/study-session/repository.js';

export interface CreateStudySessionResult {
  studySession: StudySession;
  created: boolean;
}

/** 学习任务正文规范化：undefined / null / 去除首尾空白后为空 → null。 */
function normalizeTaskText(taskText: string | null | undefined): string | null {
  if (taskText === undefined || taskText === null) {
    return null;
  }
  const trimmed = taskText.trim();
  return trimmed.length === 0 ? null : trimmed;
}

function normalizePlannedDurationSeconds(value: number | null | undefined): number | null {
  return value === undefined || value === null ? null : value;
}

/**
 * 校验倒计时设定时长：必须是 1..86400 范围内的整数。
 * null / undefined（草稿阶段尚未设置）允许通过；创建与设置路径共用同一规则。
 * 非法时长抛 StudySessionPlannedDurationInvalidError，消息不回显非法值。
 */
function assertValidPlannedDurationSeconds(
  studySessionId: string,
  value: number | null | undefined,
): void {
  if (value === null || value === undefined) {
    return;
  }
  if (
    !Number.isInteger(value) ||
    value < MIN_PLANNED_DURATION_SECONDS ||
    value > MAX_PLANNED_DURATION_SECONDS
  ) {
    throw new StudySessionPlannedDurationInvalidError(studySessionId);
  }
}

/**
 * 参与幂等语义比较的业务字段。比较使用规范化后的值（taskText 已去除首尾空白），
 * 客户端重试时的排版差异不会误判为冲突。
 */
function sameCreateSemantics(
  input: CreateStudySessionInput,
  taskText: string | null,
  plannedDurationSeconds: number | null,
  existing: StudySession,
): boolean {
  return (
    input.timerMode === existing.timerMode &&
    taskText === existing.taskText &&
    plannedDurationSeconds === existing.plannedDurationSeconds &&
    existing.status === 'created'
  );
}

/**
 * StudySession 草稿配置：创建、设置学习任务、设置倒计时时长。
 * 本批只允许 status = created 的 Session，startedAt / endedAt 恒为空，
 * actualDurationSeconds / pausedDurationSeconds 恒为 0，不实现任何计时器行为。
 *
 * 并发正确性由仓储级 createIfAbsent / updateIfVersion 保证：
 * - 幂等创建：相同 id + 相同语义 → 返回已有 Session（created=false）；
 *   相同 id + 不同内容 → StudySessionIdempotencyConflictError（409）。
 * - 乐观并发：expectedVersion 与当前 version 不一致 → StudySessionVersionConflictError（409）。
 * - 写操作可安全重试，不会因重试产生重复 Session 或覆盖新状态。
 */
export class StudySessionService {
  constructor(private readonly repository: StudySessionRepository) {}

  /**
   * 幂等创建 Session。客户端在发送前生成 UUID 作为幂等键。
   * - count_up 携带 plannedDurationSeconds → 模式冲突（409），与 Session 是否存在无关；
   * - count_down 允许先以空时长创建草稿，倒计时时长留待设置倒计时时长接口补全；
   * - 新建 Session：status='created'、version=1、startedAt/endedAt=null、实际与暂停时长=0。
   */
  async createStudySession(input: CreateStudySessionInput): Promise<CreateStudySessionResult> {
    const taskText = normalizeTaskText(input.taskText);
    const plannedDurationSeconds = normalizePlannedDurationSeconds(input.plannedDurationSeconds);
    // 服务层自守输入不变量：直接调用服务（绕过 HTTP）也不得把非法时长或超长任务写入领域状态。
    // 先校验值本身再校验模式约束，与 HTTP 严格 schema 的拒绝结果保持一致。
    assertValidPlannedDurationSeconds(input.id, plannedDurationSeconds);
    if (taskText !== null && taskText.length > TASK_TEXT_MAX_LENGTH) {
      throw new StudySessionTaskTextInvalidError(input.id);
    }
    if (input.timerMode === 'count_up' && plannedDurationSeconds !== null) {
      throw new StudySessionTimerModeConflictError(input.id, input.timerMode);
    }
    const now = new Date().toISOString();
    const studySession: StudySession = {
      id: input.id,
      taskText,
      timerMode: input.timerMode,
      plannedDurationSeconds,
      startedAt: null,
      endedAt: null,
      actualDurationSeconds: 0,
      pausedDurationSeconds: 0,
      status: 'created',
      version: 1,
      createdAt: now,
      updatedAt: now,
    };
    const { studySession: existing, created } = await this.repository.createIfAbsent(studySession);
    if (created) {
      return { studySession, created: true };
    }
    if (!sameCreateSemantics(input, taskText, plannedDurationSeconds, existing)) {
      throw new StudySessionIdempotencyConflictError(input.id);
    }
    return { studySession: existing, created: false };
  }

  /**
   * 设置学习任务（草稿配置）。
   * - Session 不存在 → 404；status 不是 created → 409；
   * - 去除首尾空白后为空，或超过长度上限 → 400（StudySessionTaskTextInvalidError）；
   * - 新值与当前值相同：版本仍匹配时原样返回，不推进 version / updatedAt；
   * - 新值与当前值不同：version + 1、刷新 updatedAt，仓储 CAS 失败 → 409。
   */
  async setTask(id: string, input: SetTaskInput): Promise<StudySession> {
    const existing = await this.repository.findById(id);
    if (!existing) {
      throw new StudySessionNotFoundError(id);
    }
    if (existing.status !== 'created') {
      throw new StudySessionStatusConflictError(id, existing.status);
    }
    const trimmed = input.taskText.trim();
    if (trimmed.length === 0 || trimmed.length > TASK_TEXT_MAX_LENGTH) {
      throw new StudySessionTaskTextInvalidError(id);
    }
    if (trimmed === existing.taskText) {
      // 值未改变：校验版本一致后原样返回，不推进 version / updatedAt。
      const result = await this.repository.updateIfVersion({ ...existing }, input.expectedVersion);
      if (!result) {
        throw new StudySessionVersionConflictError(id, input.expectedVersion);
      }
      return result;
    }
    const updated: StudySession = {
      ...existing,
      taskText: trimmed,
      version: existing.version + 1,
      updatedAt: new Date().toISOString(),
    };
    const result = await this.repository.updateIfVersion(updated, input.expectedVersion);
    if (!result) {
      throw new StudySessionVersionConflictError(id, input.expectedVersion);
    }
    return result;
  }

  /**
   * 设置倒计时时长（草稿配置）。
   * - Session 不存在 → 404；
   * - timerMode 不是 count_down → 模式冲突（409），对正计时 Session 设置倒计时属于模式错误；
   * - status 不是 created → 409；
   * - 新值与当前值相同：版本仍匹配时原样返回，不推进 version / updatedAt；
   * - 新值与当前值不同：version + 1、刷新 updatedAt，仓储 CAS 失败 → 409。
   */
  async setCountdown(id: string, input: SetCountdownInput): Promise<StudySession> {
    const existing = await this.repository.findById(id);
    if (!existing) {
      throw new StudySessionNotFoundError(id);
    }
    // 服务层自守输入不变量：非法时长直接拒绝，不写入仓储。
    assertValidPlannedDurationSeconds(id, input.plannedDurationSeconds);
    if (existing.timerMode !== 'count_down') {
      throw new StudySessionTimerModeConflictError(id, existing.timerMode);
    }
    if (existing.status !== 'created') {
      throw new StudySessionStatusConflictError(id, existing.status);
    }
    if (existing.plannedDurationSeconds === input.plannedDurationSeconds) {
      // 值未改变：校验版本一致后原样返回，不推进 version / updatedAt。
      const result = await this.repository.updateIfVersion({ ...existing }, input.expectedVersion);
      if (!result) {
        throw new StudySessionVersionConflictError(id, input.expectedVersion);
      }
      return result;
    }
    const updated: StudySession = {
      ...existing,
      plannedDurationSeconds: input.plannedDurationSeconds,
      version: existing.version + 1,
      updatedAt: new Date().toISOString(),
    };
    const result = await this.repository.updateIfVersion(updated, input.expectedVersion);
    if (!result) {
      throw new StudySessionVersionConflictError(id, input.expectedVersion);
    }
    return result;
  }
}
