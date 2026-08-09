import type { CreateStageInput } from '@mingwu/contracts';
import {
  createStageBodySchema,
  projectIdParamsSchema,
  stageJsonSchema,
  stageParamsSchema,
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
};
