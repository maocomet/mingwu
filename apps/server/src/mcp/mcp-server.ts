import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import {
  AI_TASK_DESCRIPTION_MAX_LENGTH,
  AI_TASK_TITLE_MAX_LENGTH,
  countCodePoints,
  PROJECT_STAGE_STATUSES,
  STAGE_UPDATE_REASON_MAX_LENGTH,
  STUDY_REPORT_CONTENT_MAX_LENGTH,
} from '@mingwu/contracts';
import type { AiTaskService } from '../application/ai-task/ai-task-service.js';
import type { ProjectStatusService } from '../application/project-status/project-status-service.js';
import type { StageService } from '../application/stage/stage-service.js';
import type { StageUpdateRequestService } from '../application/stage-update-request/stage-update-request-service.js';
import type { StudySessionCurrentService } from '../application/study-session-current/study-session-current-service.js';
import type { StudySessionDetailService } from '../application/study-session-detail/study-session-detail-service.js';
import type { StudyReportService } from '../application/study-report/study-report-service.js';
import type { ProjectWorkReportService } from '../application/project-work-report/project-work-report-service.js';
import {
  AiTaskArchivedError,
  AiTaskDescriptionInvalidError,
  AiTaskIdempotencyConflictError,
  AiTaskIdInvalidError,
  AiTaskNotFoundError,
  AiTaskParentNotFoundError,
  AiTaskProjectTaskInvalidError,
  AiTaskScopeConflictError,
  AiTaskTitleInvalidError,
  AiTaskTreeCorruptError,
  AiTaskUpdateInvalidError,
  AiTaskVersionConflictError,
} from '../domain/ai-task/errors.js';
import { ProjectNotFoundError } from '../domain/project/errors.js';
import { StageNotFoundError, StageVersionConflictError } from '../domain/stage/errors.js';
import { ProjectWorkReportScopeCorruptError } from '../domain/project-work-report/errors.js';
import {
  StageUpdateRequestExpectedVersionInvalidError,
  StageUpdateRequestIdInvalidError,
  StageUpdateRequestIdempotencyConflictError,
  StageUpdateRequestProposedStatusInvalidError,
  StageUpdateRequestReasonInvalidError,
} from '../domain/stage-update-request/errors.js';
import { StudyParticipantUpdateError } from '../domain/study-participant/errors.js';
import {
  StudyReportContentInvalidError,
  StudyReportIdInvalidError,
  StudyReportIdempotencyConflictError,
  StudyReportSessionNotActiveError,
} from '../domain/study-report/errors.js';
import { StudySessionNotFoundError } from '../domain/study-session/errors.js';
import type { McpAuthContext } from '../domain/mcp-auth/mcp-auth-context.js';
import { canCreateAiTask, canListMyTasks, canUpdateOwnTask } from './ai-task-policy.js';
import { canSubmitStageUpdate } from './stage-update-policy.js';
import { canAppendStudyReport } from './study-report-policy.js';

/**
 * 服务日志最小接口。只记录脱敏信息，绝不输出完整请求头或客户端提交的秘密。
 */
export interface McpLogger {
  error(...args: unknown[]): void;
}

export interface McpServerDeps {
  aiTaskService: AiTaskService;
  projectStatusService: ProjectStatusService;
  stageService: StageService;
  studySessionDetailService: StudySessionDetailService;
  studySessionCurrentService: StudySessionCurrentService;
  studyReportService: StudyReportService;
  stageUpdateRequestService: StageUpdateRequestService;
  projectWorkReportService: ProjectWorkReportService;
  serviceName: string;
  serviceVersion: string;
  logger: McpLogger;
  /**
   * 该 MCP Server 实例私有的只读绑定身份：initialize 时由服务端 Bearer 凭据解析、
   * 经统一校验并复制 / 冻结后的 session 私有对象；本地开发 / 自动化测试的匿名只读
   * 模式为 null。每次连接各持有自己的实例，绝不放进共享可变全局变量。现有六个
   * 只读工具不得输出本身份，也不新增 whoami 工具；供后续写工具按服务端身份落账。
   */
  readonly authContext: McpAuthContext | null;
}

/** 严格 UUID 输入；禁止未知字段（zod .strict 在运行时拒绝多余键）。 */
const uuidField = (description: string) => z.string().uuid().describe(description);
const statusInputSchema = z.object({ project_id: uuidField('项目 UUID') }).strict();
const listStagesInputSchema = z.object({ project_id: uuidField('项目 UUID') }).strict();
const getStageInputSchema = z.object({ stage_id: uuidField('关卡 UUID') }).strict();
/**
 * project_list_reports 严格白名单：只允许 stage_id。.strict() 在运行时拒绝任何额外
 * 字段，尤其拒绝 project_id / actor_id / actorId / submittedActorId / connectionId /
 * session 等身份、归属或受保护字段——报告读取的服务端防线会校验报告与正式 Stage
 * 的归属一致性，身份与 session 信息一律不进响应。
 */
const listReportsInputSchema = z.object({ stage_id: uuidField('关卡 UUID') }).strict();
const getStudySessionInputSchema = z.object({ session_id: uuidField('学习会话 UUID') }).strict();
/** 当前 Session 工具不需要任何输入参数：严格空对象，任何多余字段（含身份字段）都被拒绝。 */
const getCurrentStudySessionInputSchema = z.object({}).strict();
/**
 * study_append_report 严格白名单：只允许 report_id / session_id / content。
 * .strict() 在运行时拒绝任何额外字段，尤其拒绝 actorId / actor_id / actorCode /
 * author / connectionId / permissionProfile / sequenceNumber / submittedAt 等身份、
 * 序号或受保护字段——身份只能由该连接的服务端认证上下文注入。
 */
const appendReportInputSchema = z
  .object({
    report_id: uuidField('报告幂等键（调用方生成的 UUID）'),
    session_id: uuidField('学习会话 UUID'),
    content: z
      .string()
      // 长度上限与服务层完全统一：先 trim 再按 Unicode code point 计数
      // （countCodePoints 与 JSON Schema maxLength 语义一致），而不是按 UTF-16
      // code unit 计数的 .max()，否则恰好上限个 astral emoji 会被错误拒绝。
      // 空字符串 / 纯空白正文不在此拦截，交给 StudyReportService 的规范化与
      // 受控业务错误（trim 后为空 → 报告正文不合法），保持单一校验来源。
      .refine(
        (value) => countCodePoints(value.trim()) <= STUDY_REPORT_CONTENT_MAX_LENGTH,
        '报告正文超长',
      )
      .describe('报告正文'),
  })
  .strict();

/**
 * project_submit_stage_update 严格白名单：只允许 request_id / stage_id /
 * expected_stage_version / proposed_status / reason。.strict() 在运行时拒绝任何
 * 额外字段，尤其拒绝 projectId / actorId / actor_code / requesterActorId / status /
 * approvedBy / decidedAt 等身份、决定或受保护字段——projectId 由服务端读取真实
 * Stage 确定，requesterActorId 只由该连接的服务端认证上下文注入，决定字段本批
 * 尚未实现、禁止伪造。
 */
const submitStageUpdateInputSchema = z
  .object({
    request_id: uuidField('申请幂等键（调用方生成的 UUID）'),
    stage_id: uuidField('目标关卡 UUID'),
    expected_stage_version: z
      .number()
      .int()
      .positive()
      .describe('申请所依据的关卡版本（正整数）'),
    proposed_status: z
      .enum([...PROJECT_STAGE_STATUSES])
      .describe('申请变更到的合法关卡状态'),
    reason: z
      .string()
      // 长度上限与服务层完全统一：先 trim 再按 Unicode code point 计数
      // （countCodePoints 与 JSON Schema maxLength 语义一致），而不是按 UTF-16
      // code unit 计数的 .max()，否则恰好上限个 astral emoji 会被错误拒绝。
      // 空字符串 / 纯空白理由不在此拦截，交给 StageUpdateRequestService 的规范化
      // 与受控业务错误（trim 后为空 → 申请理由不合法），保持单一校验来源。
      .refine(
        (value) => countCodePoints(value.trim()) <= STAGE_UPDATE_REASON_MAX_LENGTH,
        '申请理由超长',
      )
      .describe('变更理由'),
  })
  .strict();

/**
 * task_create 严格白名单：只允许 task_id / project_id / 可选 project_task_id /
 * 可选 parent_task_id / title / 可选 description。.strict() 在运行时拒绝任何额外字段，
 * 尤其拒绝 ownerActorId / actor_id / actorCode / status / progressPercent / notes /
 * position / createdAt / updatedAt / version 等身份、状态或受保护字段——ownerActorId
 * 只由该连接的服务端认证上下文注入，其余字段由服务端初始化。标题 / 描述长度上限与
 * 服务层完全统一：先 trim 再按 Unicode code point 计数，不产生 JSON Schema 与服务层
 * 长度语义分叉；空字符串 / 纯空白标题不在此拦截，交给 AiTaskService 的规范化与受控
 * 业务错误（trim 后为空 → 任务标题不合法），保持单一校验来源。
 */
const taskCreateInputSchema = z
  .object({
    task_id: uuidField('任务幂等键（调用方生成的 UUID）'),
    project_id: uuidField('项目 UUID'),
    project_task_id: z
      .string()
      .uuid()
      .optional()
      .nullable()
      .describe('可选：关联的正式主任务 UUID（必须属于同一项目）'),
    parent_task_id: z
      .string()
      .uuid()
      .optional()
      .nullable()
      .describe('可选：父 AI 任务 UUID（必须属于同一项目且同一 owner）'),
    title: z
      .string()
      .refine(
        (value) => countCodePoints(value.trim()) <= AI_TASK_TITLE_MAX_LENGTH,
        '任务标题超长',
      )
      .describe('任务标题（trim 后必须非空，由服务层校验）'),
    description: z
      .string()
      .refine(
        (value) => countCodePoints(value.trim()) <= AI_TASK_DESCRIPTION_MAX_LENGTH,
        '任务描述超长',
      )
      .optional()
      .nullable()
      .describe('任务描述（可空；trim 后为空规范化为 null）'),
  })
  .strict();

/**
 * task_list_my_tasks 严格白名单：只允许 project_id（UUID）。.strict() 在运行时拒绝
 * 任何额外字段，尤其拒绝 ownerActorId / actor_id / actorCode / connectionId /
 * permissionProfile / status 等身份、归属、连接或筛选字段——身份只由该连接的服务端
 * 认证上下文决定，状态筛选不在本批能力范围内，防止通过伪造字段探测他人任务。
 */
const taskListMyTasksInputSchema = z
  .object({
    project_id: uuidField('项目 UUID'),
  })
  .strict();

/**
 * task_update 严格白名单：只允许 task_id / expected_version / 可选 title / 可选
 * description。.strict() 在运行时拒绝任何额外字段，尤其拒绝 ownerActorId / actor_id /
 * actorCode / projectId / projectTaskId / parentTaskId / status / progressPercent / notes /
 * position / version / createdAt / updatedAt / completedAt / archivedAt 等身份、归属、状态
 * 或受保护字段——owner 只由该连接的服务端认证上下文决定，归属与状态字段本批不可修改。
 * expected_version 是 z.number()（不强制转换），字符串数值会被拒绝。标题 / 描述长度上限
 * 与服务层完全统一：先 trim 再按 Unicode code point 计数；"至少提供一个修改字段"由服务层
 * 与工具回调统一校验（保持单一校验来源），空标题交给 AiTaskService 规范化拒绝。
 */
const taskUpdateInputSchema = z
  .object({
    task_id: uuidField('要修改的任务 UUID'),
    expected_version: z
      .number()
      .int()
      .positive()
      .describe('调用方依据的任务版本（正整数，乐观并发）'),
    title: z
      .string()
      .refine(
        (value) => countCodePoints(value.trim()) <= AI_TASK_TITLE_MAX_LENGTH,
        '任务标题超长',
      )
      .optional()
      .describe('新标题（trim 后必须非空，由服务层校验）'),
    description: z
      .string()
      .refine(
        (value) => countCodePoints(value.trim()) <= AI_TASK_DESCRIPTION_MAX_LENGTH,
        '任务描述超长',
      )
      .optional()
      .nullable()
      .describe('新描述（可空 / 空白清空规范化为 null）'),
  })
  .strict();

/** 业务错误转换为稳定、不泄露堆栈/内部配置/请求头的 MCP 错误结果。 */
function toolErrorResult(message: string) {
  return { content: [{ type: 'text' as const, text: message }], isError: true as const };
}

/**
 * 把未知异常归一化为受控错误结果：日志只记录稳定错误分类（error name / type），
 * 绝不记录原始异常 message、堆栈或客户端提交的内容；响应只返回通用“内部错误”。
 */
function unexpectedError(deps: McpServerDeps, err: unknown): ReturnType<typeof toolErrorResult> {
  deps.logger.error(
    { errType: err instanceof Error ? err.name : typeof err },
    'mcp tool internal error',
  );
  return toolErrorResult('内部错误');
}

/** 返回单个关卡的 JSON 文本内容。 */
function textContent(value: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(value) }] };
}

/**
 * 构建一个全新的 MCP Server 实例：六个只读工具 + 三个写工具
 * （study_append_report / project_submit_stage_update / task_create）。
 * 每个 MCP session 都必须使用独立的 Server 实例（SDK 的 Server 一次只安全地
 * 连接一个 transport，不能跨 session 共享临时协议状态）；本工厂只依赖共享的
 * 只读应用服务与 Session 私有 authContext，不复制业务算法、不回调自身 HTTP 接口。
 * 写工具按服务端认证身份落账：authContext 为空（匿名只读模式）时工具可见但写入
 * fail-closed 拒绝；授权策略分别集中在 study-report-policy.ts、
 * stage-update-policy.ts 与 ai-task-policy.ts。
 */
export function buildMcpServer(deps: McpServerDeps): McpServer {
  const server = new McpServer({ name: deps.serviceName, version: deps.serviceVersion });

  server.registerTool(
    'project_get_status',
    {
      title: 'Get project current status',
      description:
        '只读：获取项目当前状态聚合（项目信息、当前关卡、关卡/任务统计、整体进度与活跃任务）。不会修改任何正式进度。',
      inputSchema: statusInputSchema,
    },
    async ({ project_id }) => {
      try {
        const status = await deps.projectStatusService.getStatus(project_id);
        return textContent(status);
      } catch (err) {
        if (err instanceof ProjectNotFoundError) {
          return toolErrorResult('项目不存在');
        }
        return unexpectedError(deps, err);
      }
    },
  );

  server.registerTool(
    'project_list_stages',
    {
      title: 'List project stages',
      description:
        '只读：返回某项目按 position 排序的全部关卡列表。项目不存在时明确报错。不会修改任何正式进度。',
      inputSchema: listStagesInputSchema,
    },
    async ({ project_id }) => {
      try {
        const stages = await deps.stageService.listStages(project_id);
        return textContent(stages);
      } catch (err) {
        if (err instanceof ProjectNotFoundError) {
          return toolErrorResult('项目不存在');
        }
        return unexpectedError(deps, err);
      }
    },
  );

  server.registerTool(
    'project_get_stage',
    {
      title: 'Get project stage',
      description: '只读：获取单个关卡的完整信息。关卡不存在时明确报错。不会修改任何正式进度。',
      inputSchema: getStageInputSchema,
    },
    async ({ stage_id }) => {
      try {
        const stage = await deps.stageService.getStage(stage_id);
        return textContent(stage);
      } catch (err) {
        if (err instanceof StageNotFoundError) {
          return toolErrorResult('关卡不存在');
        }
        return unexpectedError(deps, err);
      }
    },
  );

  server.registerTool(
    'project_list_reports',
    {
      title: 'List project work reports for a stage',
      description:
        '只读：返回直接关联指定关卡的全部项目工作报告（Project Work Report），' +
        '不混入其他关卡、项目或自习室学习报告（Study Report）。排序为 submittedAt ' +
        '新到旧、同一时间按 id 升序兜底；已有关卡无报告时返回空列表。' +
        '未知关卡明确报错。不会修改任何项目数据。',
      inputSchema: listReportsInputSchema,
    },
    async ({ stage_id }) => {
      try {
        const reports = await deps.projectWorkReportService.listByStage(stage_id);
        return textContent({ reports });
      } catch (err) {
        if (err instanceof StageNotFoundError) {
          return toolErrorResult('关卡不存在');
        }
        if (err instanceof ProjectWorkReportScopeCorruptError) {
          // 范围腐败：报告 / 关卡 / 项目 ID 只进服务端日志，响应固定脱敏文本。
          deps.logger.error(
            {
              errType: 'ProjectWorkReportScopeCorruptError',
              reportId: err.reportId,
              expectedStageId: err.expectedStageId,
              expectedProjectId: err.expectedProjectId,
              actualStageId: err.actualStageId,
              actualProjectId: err.actualProjectId,
            },
            'project_list_reports scope corruption detected',
          );
          return toolErrorResult('关卡报告数据不一致');
        }
        return unexpectedError(deps, err);
      }
    },
  );

  server.registerTool(
    'study_get_session',
    {
      title: 'Get study session detail',
      description:
        '只读：返回单次学习会话的当前数据聚合（会话、用户总结、参与 AI 参与者、AI 学习报告）。' +
        '会话不存在时明确报错；尚无总结时 summary 为 null，无参与者 / 无报告时为空数组。不会修改任何学习数据。',
      inputSchema: getStudySessionInputSchema,
    },
    async ({ session_id }) => {
      try {
        const detail = await deps.studySessionDetailService.getDetail(session_id);
        return textContent(detail);
      } catch (err) {
        if (err instanceof StudySessionNotFoundError) {
          return toolErrorResult('自习记录不存在');
        }
        return unexpectedError(deps, err);
      }
    },
  );

  server.registerTool(
    'study_get_current_session',
    {
      title: 'Get current study session detail',
      description:
        '只读：返回当前正在进行的学习会话（running / paused）的四部分数据聚合' +
        '（会话、用户总结、参与 AI 参与者、AI 学习报告）。' +
        '当前没有进行中的学习会话时返回 null（正常结果，不是错误）。不会修改任何学习数据。',
      inputSchema: getCurrentStudySessionInputSchema,
    },
    async () => {
      try {
        const detail = await deps.studySessionCurrentService.getCurrentDetail();
        return textContent(detail);
      } catch (err) {
        return unexpectedError(deps, err);
      }
    },
  );

  server.registerTool(
    'study_append_report',
    {
      title: 'Append study report',
      description:
        '写：以服务端认证身份向指定学习会话追加一份学习报告。report_id 为调用方生成的 ' +
        'UUID 幂等键；同一 report_id + 同一会话 + 同一身份 + 同一正文重试为幂等成功，' +
        '不同语义为受控冲突，绝不覆盖旧报告。身份只能由服务端 Bearer 凭据决定，' +
        '不接受任何身份字段；匿名连接或未获授权的身份会被拒绝。',
      inputSchema: appendReportInputSchema,
    },
    async ({ report_id, session_id, content }) => {
      const authContext = deps.authContext;
      // 匿名只读上下文 fail-closed：工具可见，但任何写入都拒绝，报告与 Participant 均不产生。
      if (authContext === null) {
        deps.logger.error(
          { errType: 'McpAuthContextMissing' },
          'study_append_report denied: no bound identity',
        );
        return toolErrorResult('当前连接未授权写操作');
      }
      if (!canAppendStudyReport(authContext)) {
        deps.logger.error(
          { errType: 'McpReportPermissionDenied' },
          'study_append_report denied: policy rejected',
        );
        return toolErrorResult('当前身份无权追加学习报告');
      }
      try {
        const report = await deps.studyReportService.appendReport(authContext, {
          id: report_id,
          studySessionId: session_id,
          content,
        });
        return textContent(report);
      } catch (err) {
        if (err instanceof StudyReportIdInvalidError) {
          return toolErrorResult('报告 ID 不合法');
        }
        if (err instanceof StudyReportContentInvalidError) {
          return toolErrorResult('报告正文不合法');
        }
        if (err instanceof StudySessionNotFoundError) {
          return toolErrorResult('自习记录不存在');
        }
        if (err instanceof StudyReportSessionNotActiveError) {
          return toolErrorResult('自习记录尚未开始，无法追加报告');
        }
        if (err instanceof StudyReportIdempotencyConflictError) {
          return toolErrorResult('报告已存在且语义冲突，不覆盖旧报告');
        }
        if (err instanceof StudyParticipantUpdateError) {
          return toolErrorResult('参与者更新失败，请使用相同报告 ID 重试');
        }
        return unexpectedError(deps, err);
      }
    },
  );

  server.registerTool(
    'project_submit_stage_update',
    {
      title: 'Submit stage update request',
      description:
        '写：以服务端认证身份提交关卡状态更新申请。request_id 为调用方生成的 UUID ' +
        '幂等键；同一 request_id + 同一关卡 + 同一身份 + 同 expectedStageVersion + ' +
        '同 proposedStatus + 同规范化理由重试为幂等成功，不同语义为受控冲突，绝不覆盖。' +
        '系统只新增一条待处理申请，绝不修改正式关卡进度；批准 / 拒绝 / 要求补充由' +
        '后续用户接口批次处理。身份只能由服务端 Bearer 凭据决定，不接受任何身份字段；' +
        '匿名连接或未获授权的身份会被拒绝。',
      inputSchema: submitStageUpdateInputSchema,
    },
    async ({ request_id, stage_id, expected_stage_version, proposed_status, reason }) => {
      const authContext = deps.authContext;
      // 匿名只读上下文 fail-closed：工具可见，但任何写入都拒绝，不产生申请。
      if (authContext === null) {
        deps.logger.error(
          { errType: 'McpAuthContextMissing' },
          'project_submit_stage_update denied: no bound identity',
        );
        return toolErrorResult('当前连接未授权写操作');
      }
      if (!canSubmitStageUpdate(authContext)) {
        deps.logger.error(
          { errType: 'McpStageUpdatePermissionDenied' },
          'project_submit_stage_update denied: policy rejected',
        );
        return toolErrorResult('当前身份无权提交关卡更新申请');
      }
      try {
        const request = await deps.stageUpdateRequestService.submit(authContext, {
          id: request_id,
          stageId: stage_id,
          expectedStageVersion: expected_stage_version,
          proposedStatus: proposed_status,
          reason,
        });
        return textContent(request);
      } catch (err) {
        if (err instanceof StageUpdateRequestIdInvalidError) {
          return toolErrorResult('申请 ID 不合法');
        }
        if (err instanceof StageUpdateRequestReasonInvalidError) {
          return toolErrorResult('申请理由不合法');
        }
        if (err instanceof StageUpdateRequestProposedStatusInvalidError) {
          return toolErrorResult('目标状态不合法');
        }
        if (err instanceof StageUpdateRequestExpectedVersionInvalidError) {
          return toolErrorResult('版本号不合法');
        }
        if (err instanceof StageNotFoundError) {
          return toolErrorResult('关卡不存在');
        }
        if (err instanceof StageVersionConflictError) {
          return toolErrorResult('关卡版本已变化，请刷新后重试');
        }
        if (err instanceof StageUpdateRequestIdempotencyConflictError) {
          return toolErrorResult('申请已存在且语义冲突，不覆盖旧申请');
        }
        return unexpectedError(deps, err);
      }
    },
  );

  server.registerTool(
    'task_create',
    {
      title: 'Create own AI task',
      description:
        '写：以服务端认证身份创建自己的 AI 私人任务（AITask），与正式主进度任务完全独立，' +
        '绝不修改任何 ProjectTask / Stage 正式进度。task_id 为调用方生成的 UUID 幂等键；' +
        '同一 task_id + 同一项目 + 同一身份 + 同规范化标题 / 描述重试为幂等成功，不同语义' +
        '为受控冲突，绝不覆盖。ownerActorId 只由服务端 Bearer 凭据决定，不接受任何身份字段；' +
        'status / progressPercent / notes / position / version / 时间由服务端初始化，' +
        '客户端不得提交。可选 project_task_id 必须属于同一项目，可选 parent_task_id 必须属于' +
        '同一项目且同一身份。匿名连接或非 resident_ai 身份会被拒绝。',
      inputSchema: taskCreateInputSchema,
    },
    async ({ task_id, project_id, project_task_id, parent_task_id, title, description }) => {
      const authContext = deps.authContext;
      // 匿名只读上下文 fail-closed：工具可见，但任何写入都拒绝，不创建任务。
      if (authContext === null) {
        deps.logger.error(
          { errType: 'McpAuthContextMissing' },
          'task_create denied: no bound identity',
        );
        return toolErrorResult('当前连接未授权写操作');
      }
      if (!canCreateAiTask(authContext)) {
        deps.logger.error(
          { errType: 'McpAiTaskPermissionDenied' },
          'task_create denied: policy rejected',
        );
        return toolErrorResult('当前身份无权创建 AI 任务');
      }
      try {
        const { task } = await deps.aiTaskService.create(authContext, {
          id: task_id,
          projectId: project_id,
          projectTaskId: project_task_id ?? null,
          parentTaskId: parent_task_id ?? null,
          title,
          description: description ?? null,
        });
        return textContent(task);
      } catch (err) {
        if (err instanceof AiTaskIdInvalidError) {
          return toolErrorResult('任务 ID 不合法');
        }
        if (err instanceof AiTaskTitleInvalidError) {
          return toolErrorResult('任务标题不合法');
        }
        if (err instanceof AiTaskDescriptionInvalidError) {
          return toolErrorResult('任务描述不合法');
        }
        if (err instanceof ProjectNotFoundError) {
          return toolErrorResult('项目不存在');
        }
        if (err instanceof AiTaskProjectTaskInvalidError) {
          return toolErrorResult('关联的正式任务不合法');
        }
        if (err instanceof AiTaskParentNotFoundError) {
          return toolErrorResult('父任务不存在');
        }
        if (err instanceof AiTaskScopeConflictError) {
          return toolErrorResult('父任务必须属于同一项目和同一身份');
        }
        if (err instanceof AiTaskIdempotencyConflictError) {
          return toolErrorResult('任务已存在且语义冲突，不覆盖旧任务');
        }
        return unexpectedError(deps, err);
      }
    },
  );

  server.registerTool(
    'task_update',
    {
      title: 'Update own AI task content',
      description:
        '写：以服务端认证身份修改自己的 AI 私人任务标题 / 描述（本批只支持 title / ' +
        'description，不改变状态 / 进度 / 备注 / 阻塞 / position / 归属）。expected_version ' +
        '为乐观并发依据，必须与任务当前版本一致，陈旧版本稳定冲突；规范化后与现有内容相同 ' +
        '为 no-op，不推进版本。任务不存在与属于其他 AI 返回同一受控错误，禁止跨 Actor 探测。' +
        'ownerActorId 只由服务端 Bearer 凭据决定，不接受任何身份字段；绝不改变 ProjectTask / ' +
        'Stage 或任何正式项目进度。匿名连接或非 resident_ai 身份会被拒绝。',
      inputSchema: taskUpdateInputSchema,
    },
    async ({ task_id, expected_version, title, description }) => {
      const authContext = deps.authContext;
      // 匿名只读上下文 fail-closed：工具可见，但任何写入都拒绝，不修改任务。
      if (authContext === null) {
        deps.logger.error(
          { errType: 'McpAuthContextMissing' },
          'task_update denied: no bound identity',
        );
        return toolErrorResult('当前连接未授权写操作');
      }
      if (!canUpdateOwnTask(authContext)) {
        deps.logger.error(
          { errType: 'McpAiTaskUpdatePermissionDenied' },
          'task_update denied: policy rejected',
        );
        return toolErrorResult('当前身份无权修改 AI 任务');
      }
      // "至少提供一个修改字段"：MCP 入口与 AiTaskService 统一校验，保持单一语义来源。
      if (title === undefined && description === undefined) {
        return toolErrorResult('至少提供一个修改字段');
      }
      try {
        const task = await deps.aiTaskService.updateOwnTask(authContext, {
          taskId: task_id,
          expectedVersion: expected_version,
          title,
          // 保持 undefined（未提供=不改）与 null（显式清空）的区别，不能把未提供折叠成 null。
          description,
        });
        return textContent(task);
      } catch (err) {
        if (err instanceof AiTaskIdInvalidError) {
          return toolErrorResult('任务 ID 不合法');
        }
        if (err instanceof AiTaskUpdateInvalidError) {
          return toolErrorResult('至少提供一个修改字段');
        }
        if (err instanceof AiTaskTitleInvalidError) {
          return toolErrorResult('任务标题不合法');
        }
        if (err instanceof AiTaskDescriptionInvalidError) {
          return toolErrorResult('任务描述不合法');
        }
        if (err instanceof AiTaskNotFoundError) {
          return toolErrorResult('任务不存在');
        }
        if (err instanceof AiTaskArchivedError) {
          return toolErrorResult('任务已归档，无法修改');
        }
        if (err instanceof AiTaskVersionConflictError) {
          return toolErrorResult('任务版本已变化，请刷新后重试');
        }
        return unexpectedError(deps, err);
      }
    },
  );

  server.registerTool(
    'task_list_my_tasks',
    {
      title: 'List my own AI task tree',
      description:
        '只读：返回当前身份在指定项目中的完整个人 AI 任务树（AiTaskNode 递归结构，' +
        '每层按 position 升序、相同 position 按 id 升序稳定排序）。项目不存在时明确报错；' +
        '当前身份无任务时返回空数组（正常结果）。身份只能由服务端 Bearer 凭据决定，' +
        '不接受任何身份字段；响应不回显 session / connection / permissionProfile / 凭据' +
        '等任何身份信息。匿名连接或非 resident_ai 身份会被拒绝。绝不修改任何任务或正式进度。',
      inputSchema: taskListMyTasksInputSchema,
    },
    async ({ project_id }) => {
      const authContext = deps.authContext;
      // 匿名只读上下文 fail-closed：工具可见，但任何读取都拒绝，不返回任务数据。
      if (authContext === null) {
        deps.logger.error(
          { errType: 'McpAuthContextMissing' },
          'task_list_my_tasks denied: no bound identity',
        );
        return toolErrorResult('当前连接未授权读操作');
      }
      if (!canListMyTasks(authContext)) {
        deps.logger.error(
          { errType: 'McpAiTaskReadPermissionDenied' },
          'task_list_my_tasks denied: policy rejected',
        );
        return toolErrorResult('当前身份无权读取任务树');
      }
      try {
        const tree = await deps.aiTaskService.listMyTaskTree(authContext, project_id);
        return textContent(tree);
      } catch (err) {
        if (err instanceof ProjectNotFoundError) {
          return toolErrorResult('项目不存在');
        }
        if (err instanceof AiTaskTreeCorruptError) {
          // 树完整性失败：细节只进服务端日志，响应固定脱敏文本，不泄露任务 / 项目 / Actor ID。
          deps.logger.error(
            { errType: 'AiTaskTreeCorruptError' },
            'task_list_my_tasks tree integrity failure',
          );
          return toolErrorResult('任务树数据不一致');
        }
        return unexpectedError(deps, err);
      }
    },
  );

  return server;
}
