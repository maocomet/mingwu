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
