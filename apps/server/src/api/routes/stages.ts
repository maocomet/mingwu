import type {
  CreateStageInput,
  SetStageStatusInput,
  UpdateStageInput,
} from '@mingwu/contracts';
import {
  createStageBodySchema,
  projectIdParamsSchema,
  setStageStatusBodySchema,
  stageJsonSchema,
  stageParamsSchema,
  updateStageBodySchema,
} from '@mingwu/contracts';
import type { FastifyPluginAsync } from 'fastify';
import type { StageService } from '../../application/stage/stage-service.js';

export const stageRoutes: FastifyPluginAsync<{ stageService: StageService }> = async (
  app,
  opts,
) => {
  const { stageService } = opts;

  app.post(
    '/projects/:projectId/stages',
    {
      schema: {
        params: projectIdParamsSchema,
        body: createStageBodySchema,
        response: { 201: stageJsonSchema, 200: stageJsonSchema },
      },
    },
    async (request, reply) => {
      const { projectId } = request.params as { projectId: string };
      const input = request.body as CreateStageInput;
      const { stage, created } = await stageService.createStage(projectId, input);
      return reply.status(created ? 201 : 200).send(stage);
    },
  );

  app.get(
    '/stages/:id',
    {
      schema: {
        params: stageParamsSchema,
        response: { 200: stageJsonSchema },
      },
    },
    async (request) => {
      const { id } = request.params as { id: string };
      return stageService.getStage(id);
    },
  );

  // 修改关卡基础信息：只允许 name / description / completionCriteria / position。
  app.patch(
    '/stages/:id',
    {
      schema: {
        params: stageParamsSchema,
        body: updateStageBodySchema,
        response: { 200: stageJsonSchema },
      },
    },
    async (request) => {
      const { id } = request.params as { id: string };
      const input = request.body as UpdateStageInput;
      return stageService.updateStage(id, input);
    },
  );

  // 设置关卡状态：只允许 status 与 expectedVersion，禁止携带任何身份字段。
  app.patch(
    '/stages/:id/status',
    {
      schema: {
        params: stageParamsSchema,
        body: setStageStatusBodySchema,
        response: { 200: stageJsonSchema },
      },
    },
    async (request) => {
      const { id } = request.params as { id: string };
      const input = request.body as SetStageStatusInput;
      return stageService.setStageStatus(id, input);
    },
  );
};
