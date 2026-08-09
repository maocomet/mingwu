import type { CreateProjectInput, UpdateProjectInput } from '@mingwu/contracts';
import {
  createProjectBodySchema,
  projectJsonSchema,
  projectParamsSchema,
  updateProjectBodySchema,
} from '@mingwu/contracts';
import type { FastifyPluginAsync } from 'fastify';
import type { ProjectService } from '../../application/project/project-service.js';

export const projectRoutes: FastifyPluginAsync<{ projectService: ProjectService }> = async (
  app,
  opts,
) => {
  const { projectService } = opts;

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
};
