import type { CreateProjectTaskInput } from '@mingwu/contracts';
import {
  createProjectTaskBodySchema,
  progressTreeJsonSchema,
  projectIdParamsSchema,
  projectTaskJsonSchema,
  stageTaskParamsSchema,
  taskParamsSchema,
} from '@mingwu/contracts';
import type { FastifyPluginAsync } from 'fastify';
import type { ProjectTaskService } from '../../application/project-task/project-task-service.js';

export const taskRoutes: FastifyPluginAsync<{ taskService: ProjectTaskService }> = async (
  app,
  opts,
) => {
  const { taskService } = opts;

  app.post(
    '/projects/:projectId/stages/:stageId/tasks',
    {
      schema: {
        params: stageTaskParamsSchema,
        body: createProjectTaskBodySchema,
        response: { 201: projectTaskJsonSchema, 200: projectTaskJsonSchema },
      },
    },
    async (request, reply) => {
      const { projectId, stageId } = request.params as { projectId: string; stageId: string };
      const input = request.body as CreateProjectTaskInput;
      const { task, created } = await taskService.createTask(projectId, stageId, input);
      return reply.status(created ? 201 : 200).send(task);
    },
  );

  app.get(
    '/tasks/:id',
    {
      schema: {
        params: taskParamsSchema,
        response: { 200: projectTaskJsonSchema },
      },
    },
    async (request) => {
      const { id } = request.params as { id: string };
      return taskService.getTask(id);
    },
  );

  app.get(
    '/projects/:projectId/progress-tree',
    {
      schema: {
        params: projectIdParamsSchema,
        response: { 200: progressTreeJsonSchema },
      },
    },
    async (request) => {
      const { projectId } = request.params as { projectId: string };
      return taskService.getProgressTree(projectId);
    },
  );
};
