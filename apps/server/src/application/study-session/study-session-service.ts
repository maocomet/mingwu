import type {
  CreateStudySessionInput,
  EndStudySessionInput,
  PauseStudySessionInput,
  ResumeStudySessionInput,
  SetCountdownInput,
  SetTaskInput,
  StartStudySessionInput,
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
  StudySessionStartPreconditionError,
  StudySessionStatusConflictError,
  StudySessionTaskTextInvalidError,
  StudySessionTimeCorruptionError,
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

/** 时间字符串是否为可解析的有效时刻（null 视为无效）。 */
function isValidIsoTime(value: string | null): value is string {
  return value !== null && !Number.isNaN(Date.parse(value));
}

/** 倒计时设定时长是否合法：整数且在 1..86400 范围内。 */
function isValidPlannedDuration(value: number): boolean {
  return (
    Number.isInteger(value) &&
    value >= MIN_PLANNED_DURATION_SECONDS &&
    value <= MAX_PLANNED_DURATION_SECONDS
  );
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
  if (!isValidPlannedDuration(value)) {
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
  constructor(
    private readonly repository: StudySessionRepository,
    /**
     * 可注入时钟（返回 ISO 字符串）。默认取当前 UTC 时间；
     * 测试传入固定时钟以稳定断言 startedAt 等服务端时间写入。
     */
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}

  /**
   * 读取 Session 当前核心状态（只读）。不存在抛 StudySessionNotFoundError（404）。
   * 本批不返回用户总结 / AI 参与者 / AI 报告或音乐信息。
   */
  async getById(id: string): Promise<StudySession> {
    const existing = await this.repository.findById(id);
    if (!existing) {
      throw new StudySessionNotFoundError(id);
    }
    return existing;
  }

  /**
   * 开始 Session：把已配置好的草稿安全地启动为 running。
   * - Session 不存在 → 404；status 不是 created → 409（重复开始返回状态冲突，不重写 startedAt）；
   * - 开始前置条件：必须已设置非空学习任务；count_down 必须已设置合法时长；
   *   count_up 必须保持时长为空（领域不变量防御分支）；
   * - 成功时由服务端一次性写入 status=running、startedAt=now()、version+1、刷新 updatedAt；
   *   endedAt 仍为空、实际与暂停时长仍为 0；客户端无法提供或覆盖服务器时间；
   * - 仓储 CAS 失败（陈旧 expectedVersion）→ 409，20 路并发开始只有一次成功。
   */
  async startStudySession(id: string, input: StartStudySessionInput): Promise<StudySession> {
    const existing = await this.repository.findById(id);
    if (!existing) {
      throw new StudySessionNotFoundError(id);
    }
    if (existing.status !== 'created') {
      throw new StudySessionStatusConflictError(id, existing.status);
    }
    if (existing.taskText === null || existing.taskText.trim().length === 0) {
      throw new StudySessionStartPreconditionError(id, 'missing_task');
    }
    if (existing.timerMode === 'count_down') {
      if (existing.plannedDurationSeconds === null) {
        throw new StudySessionStartPreconditionError(id, 'missing_duration');
      }
      if (!isValidPlannedDuration(existing.plannedDurationSeconds)) {
        // 仓储中存在非法时长（正常流程不可达，防御分支）：不得启动，也不回显具体值。
        throw new StudySessionStartPreconditionError(id, 'invalid_duration');
      }
    }
    if (existing.timerMode === 'count_up' && existing.plannedDurationSeconds !== null) {
      throw new StudySessionStartPreconditionError(id, 'count_up_duration_set');
    }
    // 一次原子状态转换只采样一次服务器时间，同时写入 startedAt 与 updatedAt，
    // 避免真实时钟跨毫秒导致同一转换保存两个不同时间。
    const now = this.now();
    const updated: StudySession = {
      ...existing,
      status: 'running',
      startedAt: now,
      version: existing.version + 1,
      updatedAt: now,
    };
    const result = await this.repository.updateIfVersion(updated, input.expectedVersion);
    if (!result) {
      throw new StudySessionVersionConflictError(id, input.expectedVersion);
    }
    return result;
  }

  /**
   * 暂停 Session：running → paused。v0.1 暂停规则：
   * - Session 不存在 → 404；status 不是 running → 409（重复暂停 / 其他状态返回状态冲突）；
   * - 时间状态完整性：running 必须已有可解析 startedAt、pausedAt 必须为空，且
   *   服务器当前时间可解析且不早于 startedAt，否则视为内部时间状态损坏（受控 500，不改仓储）；
   * - 成功时用同一次服务器时间写 status=paused、pausedAt=now、updatedAt=now、version+1，
   *   其他业务字段不变；客户端不能提交时间或累计时长；
   * - 仓储 CAS 失败（陈旧 expectedVersion）→ 409，20 路并发暂停只有一次成功；
   *   成功后重复暂停返回状态冲突，不得重写 pausedAt。
   */
  async pauseStudySession(id: string, input: PauseStudySessionInput): Promise<StudySession> {
    const existing = await this.repository.findById(id);
    if (!existing) {
      throw new StudySessionNotFoundError(id);
    }
    if (existing.status !== 'running') {
      throw new StudySessionStatusConflictError(id, existing.status);
    }
    const now = this.now();
    // 服务器当前时间也必须有效且不早于开始时间：坏时钟不得把非法或倒退的
    // pausedAt 写进仓储制造新的损坏状态。now 参与比较前先确认可解析。
    if (
      !isValidIsoTime(existing.startedAt) ||
      existing.pausedAt !== null ||
      !isValidIsoTime(now) ||
      Date.parse(now) < Date.parse(existing.startedAt)
    ) {
      throw new StudySessionTimeCorruptionError(id);
    }
    const updated: StudySession = {
      ...existing,
      status: 'paused',
      pausedAt: now,
      updatedAt: now,
      version: existing.version + 1,
    };
    const result = await this.repository.updateIfVersion(updated, input.expectedVersion);
    if (!result) {
      throw new StudySessionVersionConflictError(id, input.expectedVersion);
    }
    return result;
  }

  /**
   * 恢复 Session：paused → running。v0.1 暂停规则：
   * - Session 不存在 → 404；status 不是 paused → 409（重复恢复 / 其他状态返回状态冲突）；
   * - 服务器单次采样 now，先确认 startedAt / pausedAt / now 均可解析（任何一处不可解析，
   *   Date.parse 返回 NaN，NaN 参与比较恒为 false，仅靠大小比较拦不住），再校验
   *   pausedAt >= startedAt、now >= pausedAt；任一不满足即视为内部时间状态损坏
   *   （受控 500，不改仓储，不回显时间）；
   * - 成功时写 status=running、pausedAt=null、本次暂停整秒数（floor((now - pausedAt) / 1000)，
   *   最小 0）累加到 pausedDurationSeconds、updatedAt=now、version+1；startedAt 保持首次开始时间不变；
   * - 仓储 CAS 失败（陈旧 expectedVersion）→ 409，20 路并发恢复只有一次成功。
   */
  async resumeStudySession(id: string, input: ResumeStudySessionInput): Promise<StudySession> {
    const existing = await this.repository.findById(id);
    if (!existing) {
      throw new StudySessionNotFoundError(id);
    }
    if (existing.status !== 'paused') {
      throw new StudySessionStatusConflictError(id, existing.status);
    }
    const nowIso = this.now();
    if (
      !isValidIsoTime(existing.startedAt) ||
      !isValidIsoTime(existing.pausedAt) ||
      !isValidIsoTime(nowIso)
    ) {
      throw new StudySessionTimeCorruptionError(id);
    }
    const startedAtMs = Date.parse(existing.startedAt);
    const pausedAtMs = Date.parse(existing.pausedAt);
    const nowMs = Date.parse(nowIso);
    if (pausedAtMs < startedAtMs || nowMs < pausedAtMs) {
      throw new StudySessionTimeCorruptionError(id);
    }
    const elapsedSeconds = Math.max(0, Math.floor((nowMs - pausedAtMs) / 1000));
    const updated: StudySession = {
      ...existing,
      status: 'running',
      pausedAt: null,
      pausedDurationSeconds: existing.pausedDurationSeconds + elapsedSeconds,
      updatedAt: nowIso,
      version: existing.version + 1,
    };
    const result = await this.repository.updateIfVersion(updated, input.expectedVersion);
    if (!result) {
      throw new StudySessionVersionConflictError(id, input.expectedVersion);
    }
    return result;
  }

  /**
   * 结束 Session：running → completed 或 paused → completed。v0.1 结束规则：
   * - Session 不存在 → 404；status 不是 running / paused → 409（created 尚未开始不能结束，
   *   已完成或其他状态重复调用返回状态冲突，不重写 endedAt / 时长结果）；
   * - 服务器单次采样 now，在任何算术与写入前校验时间与数据完整性：
   *   startedAt 与 now 均可解析且 now >= startedAt；running 必须 pausedAt = null；
   *   paused 必须有可解析 pausedAt 且 startedAt <= pausedAt <= now；
   *   已累计 pausedDurationSeconds 必须是非负整数；
   *   最终暂停秒数不得大于总墙钟秒数、最终实际学习秒数不得为负；
   *   任一不满足抛 StudySessionTimeCorruptionError（受控 500，不改仓储，不回显时间 / 时长）；
   *   不用 Math.max(0, ...) 静默掩盖损坏数据；
   * - 结算（整秒向下取整）：wallSeconds = floor((endedAt - startedAt) / 1000)；
   *   running 结束：pausedAt 必须为空，actualDurationSeconds = wallSeconds - pausedDurationSeconds；
   *   paused 结束：先把 floor((endedAt - pausedAt) / 1000) 加入 pausedDurationSeconds，
   *   再从 wallSeconds 中扣除，完成后清空 pausedAt；
   * - 成功保存 status=completed、endedAt=now、pausedAt=null、最终 pausedDurationSeconds、
   *   最终 actualDurationSeconds、version+1、刷新 updatedAt；startedAt 保持首次开始时间不变；
   * - 仓储 CAS 失败（陈旧 expectedVersion）→ 409，20 路并发结束只有一次成功。
   */
  async endStudySession(id: string, input: EndStudySessionInput): Promise<StudySession> {
    const existing = await this.repository.findById(id);
    if (!existing) {
      throw new StudySessionNotFoundError(id);
    }
    if (existing.status !== 'running' && existing.status !== 'paused') {
      throw new StudySessionStatusConflictError(id, existing.status);
    }
    const nowIso = this.now();
    // 第一步：基础时间可解析与先后顺序（任何算术之前）。
    if (!isValidIsoTime(existing.startedAt) || !isValidIsoTime(nowIso)) {
      throw new StudySessionTimeCorruptionError(id);
    }
    const startedAtMs = Date.parse(existing.startedAt);
    const nowMs = Date.parse(nowIso);
    if (nowMs < startedAtMs) {
      throw new StudySessionTimeCorruptionError(id);
    }
    // 第二步：已累计暂停秒数必须是非负整数，NaN / 负数 / 小数均视为损坏。
    if (!Number.isInteger(existing.pausedDurationSeconds) || existing.pausedDurationSeconds < 0) {
      throw new StudySessionTimeCorruptionError(id);
    }
    // 第三步：按状态校验 pausedAt。running 必须为空；paused 必须有可解析
    // pausedAt 且 startedAt <= pausedAt <= now。
    let pausedAtMs: number | null = null;
    if (existing.status === 'running') {
      if (existing.pausedAt !== null) {
        throw new StudySessionTimeCorruptionError(id);
      }
    } else if (!isValidIsoTime(existing.pausedAt)) {
      throw new StudySessionTimeCorruptionError(id);
    } else {
      pausedAtMs = Date.parse(existing.pausedAt);
      if (pausedAtMs < startedAtMs || nowMs < pausedAtMs) {
        throw new StudySessionTimeCorruptionError(id);
      }
    }
    // 结算：墙钟秒（整秒向下取整）。
    const wallSeconds = Math.floor((nowMs - startedAtMs) / 1000);
    let finalPausedSeconds = existing.pausedDurationSeconds;
    if (pausedAtMs !== null) {
      // 当前尚未累计的本次暂停秒数加入累计。
      finalPausedSeconds += Math.floor((nowMs - pausedAtMs) / 1000);
    }
    const actualSeconds = wallSeconds - finalPausedSeconds;
    // 最终一致性：暂停总数不得大于墙钟，实际学习秒数不得为负；不静默掩盖。
    if (finalPausedSeconds > wallSeconds || actualSeconds < 0) {
      throw new StudySessionTimeCorruptionError(id);
    }
    const updated: StudySession = {
      ...existing,
      status: 'completed',
      endedAt: nowIso,
      pausedAt: null,
      pausedDurationSeconds: finalPausedSeconds,
      actualDurationSeconds: actualSeconds,
      updatedAt: nowIso,
      version: existing.version + 1,
    };
    const result = await this.repository.updateIfVersion(updated, input.expectedVersion);
    if (!result) {
      throw new StudySessionVersionConflictError(id, input.expectedVersion);
    }
    return result;
  }

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
    const now = this.now();
    const studySession: StudySession = {
      id: input.id,
      taskText,
      timerMode: input.timerMode,
      plannedDurationSeconds,
      startedAt: null,
      pausedAt: null,
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
