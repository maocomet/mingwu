import Fastify, {
  type FastifyError,
  type FastifyInstance,
  type FastifyServerOptions,
} from 'fastify';
import type { AppConfig } from './config.js';
import type { ProjectService } from './application/project/project-service.js';
import type { StageService } from './application/stage/stage-service.js';
import type { ProjectTaskService } from './application/project-task/project-task-service.js';
import type { ProjectStatusService } from './application/project-status/project-status-service.js';
import type { StudySessionService } from './application/study-session/study-session-service.js';
import {
  healthRoutes,
  type ReadinessCheck,
} from './api/routes/health.js';
import { mcpRoutes } from './api/routes/mcp.js';
import { McpSessionRegistry } from './mcp/mcp-sessions.js';
import { projectRoutes } from './api/routes/projects.js';
import { stageRoutes } from './api/routes/stages.js';
import { studySessionRoutes } from './api/routes/study-sessions.js';
import { taskRoutes } from './api/routes/tasks.js';
import {
  ProjectConflictError,
  ProjectIdempotencyConflictError,
  ProjectNotFoundError,
} from './domain/project/errors.js';
import {
  StageIdempotencyConflictError,
  StageNotFoundError,
  StagePositionConflictError,
  StageVersionConflictError,
} from './domain/stage/errors.js';
import {
  ProjectTaskIdempotencyConflictError,
  ProjectTaskNotFoundError,
  ProjectTaskParentNotFoundError,
  ProjectTaskPositionConflictError,
  ProjectTaskScopeConflictError,
  ProjectTaskTreeCorruptionError,
} from './domain/project-task/errors.js';
import {
  StudySessionIdempotencyConflictError,
  StudySessionNotFoundError,
  StudySessionPlannedDurationInvalidError,
  StudySessionStatusConflictError,
  StudySessionTaskTextInvalidError,
  StudySessionTimerModeConflictError,
  StudySessionVersionConflictError,
} from './domain/study-session/errors.js';

export interface AppDeps {
  config: AppConfig;
  projectService: ProjectService;
  stageService: StageService;
  taskService: ProjectTaskService;
  projectStatusService: ProjectStatusService;
  studySessionService: StudySessionService;
  readinessChecks?: ReadinessCheck[];
  /** readyz 单项检查超时毫秒数，默认 2000，测试可注入小值。 */
  readyzTimeoutMs?: number;
  /** 覆盖 Fastify logger 选项（测试可注入捕获 stream 断言日志脱敏）；默认按 nodeEnv 选择。 */
  logger?: FastifyServerOptions['logger'];
}

export function buildApp(deps: AppDeps): FastifyInstance {
  const app = Fastify({
    logger:
      deps.logger ?? {
        level: deps.config.nodeEnv === 'test' ? 'silent' : 'info',
      },
    ajv: {
      customOptions: {
        // 严格校验：未知字段直接拒绝（400），而不是被静默删除。
        // 防止字段拼写错误悄悄丢失数据。
        removeAdditional: false,
        // 关闭类型强制转换：JSON 请求体必须使用 schema 声明的类型（严格整数契约）。
        // 例如 plannedDurationSeconds 必须是 JSON 数字，字符串 "600" 直接 400，
        // 不会被悄悄改写成数字落库。
        coerceTypes: false,
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
  app.register(projectRoutes, {
    prefix: '/api/v1',
    projectService: deps.projectService,
    projectStatusService: deps.projectStatusService,
  });
  app.register(stageRoutes, { prefix: '/api/v1', stageService: deps.stageService });
  app.register(taskRoutes, { prefix: '/api/v1', taskService: deps.taskService });
  app.register(studySessionRoutes, {
    prefix: '/api/v1',
    studySessionService: deps.studySessionService,
  });

  // MCP Streamable HTTP 挂在根路径 /mcp（不在 /api/v1 下），本地测试专用。
  // session registry 在根实例上创建并装饰，便于测试/运维观察生命周期；
  // 仅进程内可见，不对外暴露任何路由或数据。MCP session 只是临时连接，绝非 AI Actor 身份。
  const mcpSessions = new McpSessionRegistry({
    projectStatusService: deps.projectStatusService,
    stageService: deps.stageService,
    serviceName: deps.config.serviceName,
    serviceVersion: deps.config.serviceVersion,
    logger: app.log,
  });
  app.decorate('mcpSessions', mcpSessions);
  app.register(mcpRoutes, {
    config: deps.config,
    sessions: mcpSessions,
  });

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
    if (error instanceof StageVersionConflictError) {
      return reply.status(409).send({
        error: 'stage_version_conflict',
        message: error.message,
      });
    }
    if (error instanceof ProjectTaskNotFoundError) {
      return reply.status(404).send({ error: 'project_task_not_found', message: error.message });
    }
    if (error instanceof ProjectTaskParentNotFoundError) {
      return reply.status(404).send({ error: 'parent_task_not_found', message: error.message });
    }
    if (error instanceof ProjectTaskScopeConflictError) {
      return reply.status(409).send({
        error: 'project_task_scope_conflict',
        message: error.message,
      });
    }
    if (error instanceof ProjectTaskPositionConflictError) {
      return reply.status(409).send({
        error: 'project_task_position_conflict',
        message: error.message,
      });
    }
    if (error instanceof ProjectTaskIdempotencyConflictError) {
      return reply.status(409).send({
        error: 'project_task_idempotency_conflict',
        message: error.message,
      });
    }
    // 任务树数据完整性错误属于服务端数据问题（孤儿父引用 / 自引用 / 循环），
    // 返回 500 与受控错误码；细节只进服务日志，不把内部任务/关卡 id 放进响应。
    if (error instanceof ProjectTaskTreeCorruptionError) {
      request.log.error({ err: error }, 'project task tree corruption detected');
      return reply.status(500).send({
        error: 'project_task_tree_corrupt',
        message: 'project task tree is inconsistent',
      });
    }
    if (error instanceof StudySessionNotFoundError) {
      return reply.status(404).send({ error: 'study_session_not_found', message: error.message });
    }
    if (error instanceof StudySessionIdempotencyConflictError) {
      return reply.status(409).send({
        error: 'study_session_idempotency_conflict',
        message: error.message,
      });
    }
    if (error instanceof StudySessionVersionConflictError) {
      return reply.status(409).send({
        error: 'study_session_version_conflict',
        message: error.message,
      });
    }
    if (error instanceof StudySessionTimerModeConflictError) {
      return reply.status(409).send({
        error: 'study_session_timer_mode_conflict',
        message: error.message,
      });
    }
    if (error instanceof StudySessionStatusConflictError) {
      return reply.status(409).send({
        error: 'study_session_status_conflict',
        message: error.message,
      });
    }
    if (error instanceof StudySessionTaskTextInvalidError) {
      return reply.status(400).send({
        error: 'study_session_task_text_invalid',
        message: error.message,
      });
    }
    if (error instanceof StudySessionPlannedDurationInvalidError) {
      return reply.status(400).send({
        error: 'study_session_planned_duration_invalid',
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
