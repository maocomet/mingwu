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
 * 关卡更新申请的用户决定入口（本批只实现“要求 AI 补充说明”）。
 *
 * 请求体严格白名单：只允许 expectedRevision + note。params 严格 UUID。
 * 拒绝 status / decision / decidedAt / updatedAt / actorId / requesterActorId /
 * Stage 字段等额外或受保护字段；决定结果、时间与 revision 由服务端写入。
 * 本接口是单用户 App API 原型，正式用户认证留后续安全批次；决定前后正式 Stage
 * 由服务层保证零修改。
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
};
