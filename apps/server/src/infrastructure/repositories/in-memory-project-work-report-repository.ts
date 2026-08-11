import type { ProjectWorkReport } from '@mingwu/contracts';
import type { ProjectWorkReportRepository } from '../../domain/project-work-report/repository.js';
import {
  createInMemoryStore,
  type InMemoryStore,
} from '../stores/in-memory-store.js';

/**
 * 第三关接口开发用的只读内存仓储。报告按 id 存在共享 store 的
 * `projectWorkReports` Map 中（与 Stage / 申请共享同一状态源，为未来报告提交模块
 * 预留同一份数据），`listByStageId` 过滤、排序、深拷贝都在同一同步块内完成。
 *
 * 本批无写入口：`seed` 是测试装配 / 种子路径，不属于 `ProjectWorkReportRepository`
 * 接口，也不被任何 HTTP 路由调用；写入时深拷贝，避免外部对象污染内部状态。
 *
 * 排序固定：`submittedAt` 新到旧，同一时间按 `id` 升序兜底（稳定、确定性）。
 *
 * 第六关替换为 PostgreSQL 实现时：
 * - 按 `stage_id` 过滤，配合 `(stage_id, submitted_at DESC, id ASC)` 索引；
 * - 所有返回仍使用结构化拷贝，调用方修改不得污染存储；
 * - 报告写入由未来的提交模块负责，本批只读。
 */
export class InMemoryProjectWorkReportRepository implements ProjectWorkReportRepository {
  private readonly reports: Map<string, ProjectWorkReport>;

  constructor(store: InMemoryStore = createInMemoryStore()) {
    this.reports = store.projectWorkReports;
  }

  /** 测试装配路径：把一份报告写入共享 store（深拷贝）。不属于仓储接口，不暴露 HTTP。 */
  seed(report: ProjectWorkReport): void {
    this.reports.set(report.id, structuredClone(report));
  }

  async listByStageId(stageId: string): Promise<ProjectWorkReport[]> {
    return [...this.reports.values()]
      .filter((r) => r.stageId === stageId)
      .sort((a, b) => {
        // submittedAt 新到旧；同一时间按 id 升序兜底，保证确定性顺序。
        if (a.submittedAt !== b.submittedAt) {
          return a.submittedAt < b.submittedAt ? 1 : -1;
        }
        if (a.id !== b.id) {
          return a.id < b.id ? -1 : 1;
        }
        return 0;
      })
      .map((r) => structuredClone(r));
  }
}
