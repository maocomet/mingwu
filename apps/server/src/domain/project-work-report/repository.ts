import type { ProjectWorkReport } from '@mingwu/contracts';

/**
 * 仓储接口（只读基础）。本批不提供任何写入、修改、覆盖或删除报告的方法，
 * 报告经测试装配 / seed 路径注入；生产 HTTP 不暴露写入口。
 *
 * 返回约定：所有返回都必须使用深拷贝，调用方修改返回值不得污染仓储内部状态。
 *
 * PostgreSQL 阶段（第六关）落库要求：
 * - `project_work_reports` 表按 `stage_id` 关联关卡，并建索引
 *   `(stage_id, submitted_at DESC, id ASC)` 支撑按关卡的新到旧列表；
 * - 用外键 / 事务保证 project、stage 关联一致（报告 projectId 必须与所属 Stage /
 *   项目的 projectId 一致），防止跨项目串档；
 * - 本批只读，不创建 migration。
 */
export interface ProjectWorkReportRepository {
  /**
   * 按关卡列出直接关联该关卡的报告，返回深拷贝。
   * 排序固定：`submittedAt` 新到旧，同一时间按 `id` 升序兜底；
   * 该排序由仓储保证，应用服务不做二次排序。
   * 项目级报告（stageId 为 null）与其他关卡 / 其他项目的报告一律不混入。
   */
  listByStageId(stageId: string): Promise<ProjectWorkReport[]>;
}
