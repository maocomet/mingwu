import type {
  RequestChangesInput,
  StageUpdateRequest,
} from '@mingwu/contracts';
import {
  requestChangesBodySchema,
  stageUpdateRequestJsonSchema,
  stageUpdateRequestParamsSchema,
} from '@mingwu/contracts';
import type { FastifyPluginAsync } from 'fastify';
import type { StageUpdateRequestService } from '../../application/stage-update-request/stage-update-request-service.js';

/**
 * 关卡更新申请的用户决定入口（实现“要求 AI 补充说明”、“拒绝更新申请”与
 * “批准更新申请”）。批准入口是唯一触碰正式 Stage 的路径：在同一原子仓储操作内
 * 把申请标记为 approved 并按申请语义（proposedStatus + expectedStageVersion）
 * 更新正式 Stage，两处写入要么都发生、要么都不发生。
 *
 * 请求体严格白名单：只允许 expectedRevision + note。params 严格 UUID。
 * 拒绝 status / decision / decidedAt / updatedAt / actorId / requesterActorId /
 * Stage 字段等额外或受保护字段；决定结果、时间与 revision 由服务端写入。
 * 实际执行的决定类型由路由固定的服务方法决定：request-changes → needs_changes，
 * reject → rejected，approve → approved，请求体无法指定。
 * 本接口是单用户 App API 原型，正式用户认证留后续安全批次。
 */
export const stageUpdateRequestRoutes: FastifyPluginAsync<{
  stageUpdateRequestService: StageUpdateRequestService;
}> = async (app, opts) => {
  const { stageUpdateRequestService } = opts;

  // 用户要求 AI 补充说明：只把 pending 申请标记为 needs_changes 并保存决定说明。
  // 不批准申请、不修改正式 Stage，也不覆盖申请者最初提交的 Stage / Actor /
  // proposedStatus / reason / createdAt。
  app.post(
    '/stage-update-requests/:id/request-changes',
    {
      schema: {
        params: stageUpdateRequestParamsSchema,
        body: requestChangesBodySchema,
        response: { 200: stageUpdateRequestJsonSchema },
      },
    },
    async (request): Promise<StageUpdateRequest> => {
      const { id } = request.params as { id: string };
      const input = request.body as RequestChangesInput;
      return stageUpdateRequestService.requestChanges(id, input);
    },
  );

  // 用户拒绝更新申请：只把 pending 申请标记为 rejected 并保存拒绝说明。
  // 不批准申请、不修改正式 Stage，也不覆盖申请者最初提交的 Stage / Actor /
  // proposedStatus / reason / createdAt。
  app.post(
    '/stage-update-requests/:id/reject',
    {
      schema: {
        params: stageUpdateRequestParamsSchema,
        body: requestChangesBodySchema,
        response: { 200: stageUpdateRequestJsonSchema },
      },
    },
    async (request): Promise<StageUpdateRequest> => {
      const { id } = request.params as { id: string };
      const input = request.body as RequestChangesInput;
      return stageUpdateRequestService.reject(id, input);
    },
  );

  // 用户批准更新申请：在同一个原子仓储操作内把 pending 申请标记为 approved 并按
  // 申请语义更新正式 Stage。批准目标（stageId / projectId / proposedStatus /
  // expectedStageVersion）完全来自已保存申请，请求体无法指定；批准前 Stage 版本
  // 与申请 expectedStageVersion 不一致等冲突返回稳定 409、申请保持 pending。
  app.post(
    '/stage-update-requests/:id/approve',
    {
      schema: {
        params: stageUpdateRequestParamsSchema,
        body: requestChangesBodySchema,
        response: { 200: stageUpdateRequestJsonSchema },
      },
    },
    async (request): Promise<StageUpdateRequest> => {
      const { id } = request.params as { id: string };
      const input = request.body as RequestChangesInput;
      return stageUpdateRequestService.approve(id, input);
    },
  );
};
