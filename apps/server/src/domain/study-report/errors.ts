/**
 * StudyReport 领域错误。所有错误消息不回显用户正文、报告内容或受保护字段。
 * Session 不存在的 404 复用 StudySessionNotFoundError（study_session_not_found）。
 */

/**
 * 报告只能追加到“已开始”的 Session：running / paused / completed / cancelled /
 * interrupted 允许，created 草稿拒绝。返回稳定 409，消息不回显 Session 内容。
 */
export class StudyReportSessionNotActiveError extends Error {
  constructor(readonly studySessionId: string) {
    super(`Study report requires an active or terminal session ${studySessionId}`);
    this.name = 'StudyReportSessionNotActiveError';
  }
}

/**
 * 幂等键冲突：id 已存在但与本次请求的 (studySessionId, actorId, content) 语义不同。
 * 返回稳定 409，绝不覆盖已有报告；同 id 同语义的重试应幂等返回已有报告。
 */
export class StudyReportIdempotencyConflictError extends Error {
  constructor(readonly reportId: string) {
    super(`Study report ${reportId} already exists with different semantics`);
    this.name = 'StudyReportIdempotencyConflictError';
  }
}

/**
 * 报告正文不合法：去除首尾空白后为空，或按 Unicode code point 计数超过
 * STUDY_REPORT_CONTENT_MAX_LENGTH（与 JSON Schema maxLength 语义一致）。
 * 消息不回显原始正文，避免把用户内容反弹给调用方。
 */
export class StudyReportContentInvalidError extends Error {
  constructor(readonly studySessionId: string) {
    super(`Study report content is invalid for session ${studySessionId}`);
    this.name = 'StudyReportContentInvalidError';
  }
}

/**
 * 幂等键 id 不是 UUID（schema 已先行拦截，此处为服务层自守输入不变量，
 * 直接调用服务绕过 HTTP 也不得传入非法 id）。
 */
export class StudyReportIdInvalidError extends Error {
  constructor(readonly reportId: string) {
    super(`Study report id is invalid: ${reportId}`);
    this.name = 'StudyReportIdInvalidError';
  }
}
