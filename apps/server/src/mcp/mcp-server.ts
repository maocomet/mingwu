import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { ProjectStatusService } from '../application/project-status/project-status-service.js';
import type { StageService } from '../application/stage/stage-service.js';
import type { StudySessionCurrentService } from '../application/study-session-current/study-session-current-service.js';
import type { StudySessionDetailService } from '../application/study-session-detail/study-session-detail-service.js';
import { ProjectNotFoundError } from '../domain/project/errors.js';
import { StageNotFoundError } from '../domain/stage/errors.js';
import { StudySessionNotFoundError } from '../domain/study-session/errors.js';
import type { McpAuthContext } from '../domain/mcp-auth/mcp-auth-context.js';

/**
 * 服务日志最小接口。只记录脱敏信息，绝不输出完整请求头或客户端提交的秘密。
 */
export interface McpLogger {
  error(...args: unknown[]): void;
}

export interface McpServerDeps {
  projectStatusService: ProjectStatusService;
  stageService: StageService;
  studySessionDetailService: StudySessionDetailService;
  studySessionCurrentService: StudySessionCurrentService;
  serviceName: string;
  serviceVersion: string;
  logger: McpLogger;
  /**
   * 该 MCP Server 实例私有的只读绑定身份：initialize 时由服务端 Bearer 凭据解析、
   * 经统一校验并复制 / 冻结后的 session 私有对象；本地开发 / 自动化测试的匿名只读
   * 模式为 null。每次连接各持有自己的实例，绝不放进共享可变全局变量。现有五个
   * 只读工具不得输出本身份，也不新增 whoami 工具；供后续写工具按服务端身份落账。
   */
  readonly authContext: McpAuthContext | null;
}

/** 严格 UUID 输入；禁止未知字段（zod .strict 在运行时拒绝多余键）。 */
const uuidField = (description: string) => z.string().uuid().describe(description);
const statusInputSchema = z.object({ project_id: uuidField('项目 UUID') }).strict();
const listStagesInputSchema = z.object({ project_id: uuidField('项目 UUID') }).strict();
const getStageInputSchema = z.object({ stage_id: uuidField('关卡 UUID') }).strict();
const getStudySessionInputSchema = z.object({ session_id: uuidField('学习会话 UUID') }).strict();
/** 当前 Session 工具不需要任何输入参数：严格空对象，任何多余字段（含身份字段）都被拒绝。 */
const getCurrentStudySessionInputSchema = z.object({}).strict();

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
 * 构建一个全新的 MCP Server 实例并注册本批四个只读工具。
 * 每个 MCP session 都必须使用独立的 Server 实例（SDK 的 Server 一次只安全地
 * 连接一个 transport，不能跨 session 共享临时协议状态）；本工厂只依赖共享的
 * 只读应用服务，不复制业务算法、不回调自身 HTTP 接口。
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

  return server;
}
