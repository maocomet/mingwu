/**
 * ProjectWorkReport 领域错误。
 *
 * 本批只读，错误面很窄：唯一受控错误是“按关卡读取报告时的范围 / 归属不一致”。
 * 消息与响应一律不泄露报告、关卡、项目或 Actor 的内部 ID；明细只作为错误对象属性
 * 提供给服务端日志（app.ts 错误分支写入 request.log），绝不进入 HTTP 响应体。
 * 关卡不存在的 404 复用 StageNotFoundError（stage/errors.ts）。
 */

/**
 * 数据完整性防线（500）：按关卡读取到的报告 `stageId` 不匹配请求关卡，或报告
 * `projectId` 与正式 Stage 的 `projectId` 不一致（存储脏数据 / 跨项目串档）。
 * 返回受控 500 `project_work_report_scope_corrupt`；错误消息固定、不含任何 ID，
 * 明细（reportId / expectedStageId / expectedProjectId / actualStageId /
 * actualProjectId）只进服务端日志。
 */
export class ProjectWorkReportScopeCorruptError extends Error {
  constructor(
    readonly reportId: string,
    readonly expectedStageId: string,
    readonly expectedProjectId: string,
    readonly actualStageId: string | null,
    readonly actualProjectId: string,
  ) {
    super('project work report scope is inconsistent');
    this.name = 'ProjectWorkReportScopeCorruptError';
  }
}
