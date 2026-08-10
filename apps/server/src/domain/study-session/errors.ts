import type { StudySessionStatus, TimerMode } from '@mingwu/contracts';

export class StudySessionNotFoundError extends Error {
  constructor(readonly studySessionId: string) {
    super(`Study session not found: ${studySessionId}`);
    this.name = 'StudySessionNotFoundError';
  }
}

/**
 * 同一个幂等标识（Session id）被再次使用，但请求内容与已存在 Session 不一致。
 */
export class StudySessionIdempotencyConflictError extends Error {
  constructor(readonly studySessionId: string) {
    super(`Study session id ${studySessionId} already exists with different content`);
    this.name = 'StudySessionIdempotencyConflictError';
  }
}

/**
 * 乐观并发冲突：expectedVersion 与 Session 当前 version 不一致。仓储级 CAS
 * 检测到版本已被其他写操作推进时抛出，防止旧状态静默覆盖新状态。
 */
export class StudySessionVersionConflictError extends Error {
  constructor(readonly studySessionId: string, readonly expectedVersion: number) {
    super(`Study session ${studySessionId} version conflict: expected ${expectedVersion}`);
    this.name = 'StudySessionVersionConflictError';
  }
}

/**
 * 计时模式冲突：count_up 不携带倒计时时长；对 count_up Session 设置
 * plannedDurationSeconds 属于模式错误，与 Session 是否存在无关。
 */
export class StudySessionTimerModeConflictError extends Error {
  constructor(readonly studySessionId: string, readonly timerMode: TimerMode) {
    super(
      `Study session ${studySessionId} timer mode ${timerMode} does not allow a countdown duration`,
    );
    this.name = 'StudySessionTimerModeConflictError';
  }
}

/**
 * 状态冲突：草稿配置（任务 / 倒计时时长）只允许在 created 状态修改。
 */
export class StudySessionStatusConflictError extends Error {
  constructor(readonly studySessionId: string, readonly status: StudySessionStatus) {
    super(`Study session ${studySessionId} is not editable in status ${status}`);
    this.name = 'StudySessionStatusConflictError';
  }
}

/**
 * 学习任务正文不合法：去除首尾空白后为空，或超过长度上限。
 */
export class StudySessionTaskTextInvalidError extends Error {
  constructor(readonly studySessionId: string) {
    super(`Study session ${studySessionId} task text is invalid`);
    this.name = 'StudySessionTaskTextInvalidError';
  }
}

/**
 * 倒计时设定时长不合法：不是整数，或超出 1..86400 范围。
 * 错误消息不回显非法值，避免把无效输入反弹给调用方。
 */
export class StudySessionPlannedDurationInvalidError extends Error {
  constructor(readonly studySessionId: string) {
    super(`Study session ${studySessionId} planned duration is invalid`);
    this.name = 'StudySessionPlannedDurationInvalidError';
  }
}

/** 开始 Session 的前置条件未满足，reason 是受控枚举，不泄露具体内容。 */
export type StudySessionStartPreconditionReason =
  | 'missing_task'
  | 'missing_duration'
  | 'invalid_duration'
  | 'count_up_duration_set';

/**
 * 开始前置条件不满足：草稿尚未补全（缺学习任务 / 倒计时缺设定时长），
 * 或 count_up 却带着时长（领域不变量破坏的防御分支，正常流程不可达）。
 * reason 为受控枚举，客户端可据此提示用户补全草稿，但不暴露草稿实际内容。
 */
export class StudySessionStartPreconditionError extends Error {
  constructor(
    readonly studySessionId: string,
    readonly reason: StudySessionStartPreconditionReason,
  ) {
    super(`Study session ${studySessionId} cannot start: ${reason}`);
    this.name = 'StudySessionStartPreconditionError';
  }
}

/**
 * Session 内部时间状态损坏：startedAt / pausedAt 无法解析、pausedAt 早于 startedAt、
 * 或服务器时间早于 pausedAt。属服务端数据问题，返回受控 500，消息不回显原始时间
 * 或 Session 内容，也不得修改仓储。
 */
export class StudySessionTimeCorruptionError extends Error {
  constructor(readonly studySessionId: string) {
    super(`Study session ${studySessionId} time state is corrupted`);
    this.name = 'StudySessionTimeCorruptionError';
  }
}
