import {
  stageWorkReportListJsonSchema,
  stageWorkReportParamsSchema,
} from '@mingwu/contracts';
import type { FastifyPluginAsync } from 'fastify';
import type { ProjectWorkReportService } from '../../application/project-work-report/project-work-report-service.js';

/**
 * 关卡工作报告的只读入口（实现“获取关卡报告”）。本批不提供任何报告写入口：
 * 报告经测试装配 / seed 路径注入，生产 HTTP 只暴露读取。
 *
 * 语义：
 * - 未知关卡 → 404 stage_not_found；
 * - 已有关卡但无报告 → 200 与空数组；
 * - 只返回直接关联该关卡的 ProjectWorkReport，不混入其他关卡、其他项目或 StudyReport；
 * - 排序固定：submittedAt 新到旧，同一时间按 id 升序兜底（仓储保证）；
 * - 响应走严格 JSON Schema（additionalProperties:false，字段与数组项不允许未声明内容）。
 * 本接口是单用户 App API 原型，正式用户认证留后续安全批次。
 */
export const projectWorkReportRoutes: FastifyPluginAsync<{
  projectWorkReportService: ProjectWorkReportService;
}> = async (app, opts) => {
  const { projectWorkReportService } = opts;

  app.get(
    '/stages/:stageId/reports',
    {
      schema: {
        params: stageWorkReportParamsSchema,
        response: { 200: stageWorkReportListJsonSchema },
      },
    },
    async (request) => {
      const { stageId } = request.params as { stageId: string };
      const reports = await projectWorkReportService.listByStage(stageId);
      return { reports };
    },
  );
};
