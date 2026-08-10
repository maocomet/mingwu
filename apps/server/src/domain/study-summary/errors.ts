/**
 * StudySummary 领域错误。所有错误消息不回显用户正文 / 原始 revision 之外的
 * 不必要内容；受保护字段（id / createdAt / confirmedByUserAt 等）永不进入消息。
 */

/**
 * 总结不存在：GET 或 PUT 更新时 Session 存在但没有正式总结。返回受控 404，
 * 与 Session 不存在的 404（study_session_not_found）使用不同错误码。
 */
export class StudySummaryNotFoundError extends Error {
  constructor(readonly studySessionId: string) {
    super(`Study summary not found for session ${studySessionId}`);
    this.name = 'StudySummaryNotFoundError';
  }
}

/**
 * 提交 / 修改总结只允许终态 Session（completed / cancelled / interrupted）。
 * 活动或草稿 Session 返回稳定 409；消息不回显 Session 内容。
 */
export class StudySummarySessionNotTerminalError extends Error {
  constructor(readonly studySessionId: string) {
    super(`Study summary requires a terminal study session ${studySessionId}`);
    this.name = 'StudySummarySessionNotTerminalError';
  }
}

/**
 * 乐观并发冲突：expectedRevision 与 Summary 当前 revision 不一致。
 * 仓储级 CAS 检测到版本已被其他写操作推进时抛出，防止旧状态静默覆盖新状态。
 * 更新路径 / 期望 revision 大于 0 但尚无总结时也抛此错误。
 */
export class StudySummaryRevisionConflictError extends Error {
  constructor(readonly studySessionId: string, readonly expectedRevision: number) {
    super(
      `Study summary ${studySessionId} revision conflict: expected ${expectedRevision}`,
    );
    this.name = 'StudySummaryRevisionConflictError';
  }
}

/**
 * 创建路径的幂等冲突：expectedRevision=0 重试但 Summary 已存在，且请求内容
 * 与已存在内容不一致。不得静默覆盖已确认内容，返回稳定 409。
 * 重试语义：内容与 source 完全一致时按幂等返回已有总结；不一致才算冲突。
 */
export class StudySummaryIdempotencyConflictError extends Error {
  constructor(readonly studySessionId: string) {
    super(`Study summary ${studySessionId} already exists with different content`);
    this.name = 'StudySummaryIdempotencyConflictError';
  }
}

/**
 * 总结正文不合法：去除首尾空白后为空，或按 Unicode code point 计数超过
 * SUMMARY_CONTENT_MAX_LENGTH（与 JSON Schema maxLength 语义一致，非 UTF-16
 * code unit 计数，避免 emoji 等非 BMP 字符被多算）。
 * 消息不回显原始正文，避免把用户内容反弹给调用方。
 */
export class StudySummaryContentInvalidError extends Error {
  constructor(readonly studySessionId: string) {
    super(`Study summary content is invalid for session ${studySessionId}`);
    this.name = 'StudySummaryContentInvalidError';
  }
}

/**
 * expectedRevision 不合法：不是非负整数（schema 已拦截非整数 / 负数，此处为
 * 服务层自守输入不变量，直接调用服务绕过 HTTP 也不得传入非法值）。
 */
export class StudySummaryExpectedRevisionInvalidError extends Error {
  constructor(readonly studySessionId: string) {
    super(`Study summary expected revision is invalid for session ${studySessionId}`);
    this.name = 'StudySummaryExpectedRevisionInvalidError';
  }
}
