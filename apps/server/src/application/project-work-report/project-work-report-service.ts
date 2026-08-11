import type { ProjectWorkReport } from '@mingwu/contracts';
import { StageNotFoundError } from '../../domain/stage/errors.js';
import type { StageRepository } from '../../domain/stage/repository.js';
import { ProjectWorkReportScopeCorruptError } from '../../domain/project-work-report/errors.js';
import type { ProjectWorkReportRepository } from '../../domain/project-work-report/repository.js';

/**
 * 项目工作报告只读服务（本批唯一入口：`GET /stages/:stageId/reports`）。
 *
 * 职责：
 * 1. 关卡存在性校验——未知关卡抛 StageNotFoundError（404 stage_not_found），不把
 *    “空列表”当作不存在的关卡；
 * 2. 读取该关卡的报告列表（顺序由仓储保证：submittedAt 新到旧，同时间 id 升序），
 *    只返回直接关联该关卡的报告；
 * 3. 数据完整性防线——对仓储返回的每条报告校验 `stageId` 与请求关卡一致、且
 *    `projectId` 与正式 Stage 的 `projectId` 一致；任一不匹配说明存储脏数据 /
 *    跨项目串档，抛 ProjectWorkReportScopeCorruptError（500 project_work_report_
 *    scope_corrupt），响应不泄露任何内部 ID，明细由 app.ts 错误分支写入日志。
 *
 * 返回的对象来自仓储深拷贝，调用方修改不得污染仓储内部状态；本服务不做二次排序。
 */
export class ProjectWorkReportService {
  constructor(
    private readonly reportRepository: ProjectWorkReportRepository,
    private readonly stageRepository: StageRepository,
  ) {}

  async listByStage(stageId: string): Promise<ProjectWorkReport[]> {
    const stage = await this.stageRepository.findById(stageId);
    if (!stage) {
      throw new StageNotFoundError(stageId);
    }

    const reports = await this.reportRepository.listByStageId(stageId);
    for (const report of reports) {
      // 防线：按关卡读到的报告必须直接关联该关卡且归属同一项目，否则视为脏数据。
      // 校验失败时抛受控错误；报告 / 关卡 / 项目 / Actor 的 ID 只进日志，不进响应。
      if (report.stageId !== stageId || report.projectId !== stage.projectId) {
        throw new ProjectWorkReportScopeCorruptError(
          report.id,
          stageId,
          stage.projectId,
          report.stageId,
          report.projectId,
        );
      }
    }
    return reports;
  }
}
