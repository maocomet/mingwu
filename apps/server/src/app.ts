import Fastify, { type FastifyError, type FastifyInstance } from 'fastify';
import type { AppConfig } from './config.js';
import type { ProjectService } from './application/project/project-service.js';
import type { StageService } from './application/stage/stage-service.js';
import {
  healthRoutes,
  type ReadinessCheck,
} from './api/routes/health.js';
import { projectRoutes } from './api/routes/projects.js';
import { stageRoutes } from './api/routes/stages.js';
import {
  ProjectConflictError,
  ProjectIdempotencyConflictError,
  ProjectNotFoundError,
} from './domain/project/errors.js';
import {
  StageIdempotencyConflictError,
  StageNotFoundError,
  StagePositionConflictError,
} from './domain/stage/errors.js';

export interface AppDeps {
  config: AppConfig;
  projectService: ProjectService;
  stageService: StageService;
  readinessChecks?: ReadinessCheck[];
  /** readyz 单项检查超时毫秒数，默认 2000，测试可注入小值。 */
  readyzTimeoutMs?: number;
}

export function buildApp(deps: AppDeps): FastifyInstance {
  const app = Fastify({
    logger: {
      level: deps.config.nodeEnv === 'test' ? 'silent' : 'info',
    },
    ajv: {
      customOptions: {
        // 严格校验：未知字段直接拒绝（400），而不是被静默删除。
        // 防止字段拼写错误悄悄丢失数据。
        removeAdditional: false,
        coerceTypes: 'array',
        useDefaults: true,
      },
    },
  });

  // 第三关使用内存仓储，数据库 / Migration / 素材目录 / MCP 尚未配置。
  // readyz 如实返回 not_configured，直到第六关接入真实 PostgreSQL、素材目录与 MCP。
  const readinessChecks: ReadinessCheck[] = deps.readinessChecks ?? [
    { name: 'database', check: async () => ({ ok: false, message: 'not_configured' }) },
    { name: 'migrations', check: async () => ({ ok: false, message: 'not_configured' }) },
    { name: 'asset_storage', check: async () => ({ ok: false, message: 'not_configured' }) },
    { name: 'mcp', check: async () => ({ ok: false, message: 'not_configured' }) },
  ];

  app.register(healthRoutes, {
    config: deps.config,
    readinessChecks,
    readyzTimeoutMs: deps.readyzTimeoutMs ?? 2000,
  });
  app.register(projectRoutes, { prefix: '/api/v1', projectService: deps.projectService });
  app.register(stageRoutes, { prefix: '/api/v1', stageService: deps.stageService });

  app.setErrorHandler((error: FastifyError, request, reply) => {
    if (error instanceof ProjectNotFoundError) {
      return reply.status(404).send({ error: 'project_not_found', message: error.message });
    }
    if (error instanceof ProjectConflictError) {
      return reply.status(409).send({
        error: 'project_version_conflict',
        message: error.message,
        currentVersion: error.currentVersion,
      });
    }
    if (error instanceof ProjectIdempotencyConflictError) {
      return reply.status(409).send({
        error: 'project_idempotency_conflict',
        message: error.message,
      });
    }
    if (error instanceof StageNotFoundError) {
      return reply.status(404).send({ error: 'stage_not_found', message: error.message });
    }
    if (error instanceof StagePositionConflictError) {
      return reply.status(409).send({
        error: 'stage_position_conflict',
        message: error.message,
      });
    }
    if (error instanceof StageIdempotencyConflictError) {
      return reply.status(409).send({
        error: 'stage_idempotency_conflict',
        message: error.message,
      });
    }
    if (error.validation) {
      request.log.warn({ err: error }, 'request validation failed');
      return reply.status(400).send({ error: 'validation_failed', message: error.message });
    }
    request.log.error({ err: error }, 'unhandled error');
    return reply.status(500).send({ error: 'internal_error', message: 'unexpected server error' });
  });

  return app;
}
