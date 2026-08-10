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
import type { StudySessionCurrentService } from './application/study-session-current/study-session-current-service.js';
import type { StudySessionDetailService } from './application/study-session-detail/study-session-detail-service.js';
import type { StudySummaryService } from './application/study-summary/study-summary-service.js';
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
  StudySessionHistoryCursorInvalidError,
  StudySessionHistoryDataCorruptError,
  StudySessionHistoryLimitInvalidError,
  StudySessionIdempotencyConflictError,
  StudySessionNotFoundError,
  StudySessionPlannedDurationInvalidError,
  StudySessionStartPreconditionError,
  StudySessionStatusConflictError,
  StudySessionTaskTextInvalidError,
  StudySessionTimeCorruptionError,
  StudySessionTimerModeConflictError,
  StudySessionVersionConflictError,
} from './domain/study-session/errors.js';
import {
  StudySummaryContentInvalidError,
  StudySummaryExpectedRevisionInvalidError,
  StudySummaryIdempotencyConflictError,
  StudySummaryNotFoundError,
  StudySummaryRevisionConflictError,
  StudySummarySessionNotTerminalError,
} from './domain/study-summary/errors.js';

export interface AppDeps {
  config: AppConfig;
  projectService: ProjectService;
  stageService: StageService;
  taskService: ProjectTaskService;
  projectStatusService: ProjectStatusService;
  studySessionService: StudySessionService;
  studySessionDetailService: StudySessionDetailService;
  studySessionCurrentService: StudySessionCurrentService;
  studySummaryService: StudySummaryService;
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
    studySummaryService: deps.studySummaryService,
  });

  // MCP Streamable HTTP 挂在根路径 /mcp（不在 /api/v1 下），本地测试专用。
  // session registry 在根实例上创建并装饰，便于测试/运维观察生命周期；
  // 仅进程内可见，不对外暴露任何路由或数据。MCP session 只是临时连接，绝非 AI Actor 身份。
  const mcpSessions = new McpSessionRegistry({
    projectStatusService: deps.projectStatusService,
    stageService: deps.stageService,
    studySessionDetailService: deps.studySessionDetailService,
    studySessionCurrentService: deps.studySessionCurrentService,
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
    if (error instanceof StudySessionStartPreconditionError) {
      return reply.status(409).send({
        error: 'study_session_start_precondition_failed',
        message: error.message,
        reason: error.reason,
      });
    }
    // Session 内部时间状态损坏（startedAt / pausedAt 无法解析或倒退）属于服务端数据问题，
    // 返回 500 与受控错误码；细节只进服务日志，不把原始时间或 Session 内容放进响应。
    if (error instanceof StudySessionTimeCorruptionError) {
      request.log.error({ err: error }, 'study session time state corruption detected');
      return reply.status(500).send({
        error: 'study_session_time_corrupt',
        message: 'study session time state is inconsistent',
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
    // 历史分页游标 / limit 非法属于客户端输入错误，返回受控 400。
    // 游标错误消息不含原始 cursor，避免把内部编码细节或用户内容反弹给调用方。
    if (error instanceof StudySessionHistoryCursorInvalidError) {
      return reply.status(400).send({
        error: 'study_session_history_cursor_invalid',
        message: error.message,
      });
    }
    if (error instanceof StudySessionHistoryLimitInvalidError) {
      return reply.status(400).send({
        error: 'study_session_history_limit_invalid',
        message: error.message,
      });
    }
    // 历史所需的终态数据损坏（endedAt 缺失 / 非规范、分页 ID 非法）属于服务端数据问题，
    // 返回 500 与受控错误码；细节只进服务日志，不把记录内容或 Session id 放进响应，
    // 也不得静默截断历史。
    if (error instanceof StudySessionHistoryDataCorruptError) {
      request.log.error({ err: error }, 'study session history data corruption detected');
      return reply.status(500).send({
        error: 'study_session_history_data_corrupt',
        message: 'study session history data is inconsistent',
      });
    }
    // StudySummary：404 区分 Session 与 Summary 不存在；409 区分非终态 / revision /
    // 幂等冲突；400 区分正文与 expectedRevision 不合法。所有消息不回显用户正文、
    // 总结内容、受保护字段或时间，避免把用户数据反弹给调用方。
    if (error instanceof StudySummaryNotFoundError) {
      return reply.status(404).send({ error: 'study_summary_not_found', message: error.message });
    }
    if (error instanceof StudySummarySessionNotTerminalError) {
      return reply.status(409).send({
        error: 'study_summary_session_not_terminal',
        message: error.message,
      });
    }
    if (error instanceof StudySummaryRevisionConflictError) {
      return reply.status(409).send({
        error: 'study_summary_revision_conflict',
        message: error.message,
      });
    }
    if (error instanceof StudySummaryIdempotencyConflictError) {
      return reply.status(409).send({
        error: 'study_summary_idempotency_conflict',
        message: error.message,
      });
    }
    if (error instanceof StudySummaryContentInvalidError) {
      return reply.status(400).send({
        error: 'study_summary_content_invalid',
        message: error.message,
      });
    }
    if (error instanceof StudySummaryExpectedRevisionInvalidError) {
      return reply.status(400).send({
        error: 'study_summary_expected_revision_invalid',
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
