import type { CreateProjectInput, UpdateProjectInput } from '@mingwu/contracts';
import {
  createProjectBodySchema,
  projectIdParamsSchema,
  projectJsonSchema,
  projectParamsSchema,
  projectStatusJsonSchema,
  updateProjectBodySchema,
} from '@mingwu/contracts';
import type { FastifyPluginAsync } from 'fastify';
import type { ProjectService } from '../../application/project/project-service.js';
import type { ProjectStatusService } from '../../application/project-status/project-status-service.js';

export const projectRoutes: FastifyPluginAsync<{
  projectService: ProjectService;
  projectStatusService: ProjectStatusService;
}> = async (app, opts) => {
  const { projectService, projectStatusService } = opts;

  app.post(
    '/projects',
    {
      schema: {
        body: createProjectBodySchema,
        response: { 201: projectJsonSchema, 200: projectJsonSchema },
      },
    },
    async (request, reply) => {
      const input = request.body as CreateProjectInput;
      const { project, created } = await projectService.createProject(input);
      return reply.status(created ? 201 : 200).send(project);
    },
  );

  app.get(
    '/projects/:id',
    {
      schema: {
        params: projectParamsSchema,
        response: { 200: projectJsonSchema },
      },
    },
    async (request) => {
      const { id } = request.params as { id: string };
      return projectService.getProject(id);
    },
  );

  app.patch(
    '/projects/:id',
    {
      schema: {
        params: projectParamsSchema,
        body: updateProjectBodySchema,
        response: { 200: projectJsonSchema },
      },
    },
    async (request) => {
      const { id } = request.params as { id: string };
      const input = request.body as UpdateProjectInput;
      return projectService.updateProject(id, input);
    },
  );

  // 只读聚合：项目当前状态。无请求体、不接收 actorId 或任何可修改参数；
  // 结果从共享仓储实时计算，不缓存、不修改任何数据。
  app.get(
    '/projects/:projectId/status',
    {
      schema: {
        params: projectIdParamsSchema,
        response: { 200: projectStatusJsonSchema },
      },
    },
    async (request) => {
      const { projectId } = request.params as { projectId: string };
      return projectStatusService.getStatus(projectId);
    },
  );
};
