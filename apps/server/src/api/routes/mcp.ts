import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import type { AppConfig } from '../../config.js';
import type { McpAuthContext } from '../../domain/mcp-auth/mcp-auth-context.js';
import {
  assertValidMcpAuthContext,
  type McpAuthenticator,
} from '../../domain/mcp-auth/mcp-authenticator.js';
import { McpAuthenticationError } from '../../domain/mcp-auth/errors.js';
import { McpSessionRegistry } from '../../mcp/mcp-sessions.js';
import type { McpLogger } from '../../mcp/mcp-server.js';

export interface McpRouteOptions {
  config: AppConfig;
  sessions: McpSessionRegistry;
  /**
   * 可选 Bearer 认证器。注入后无论环境都必须执行认证；未注入时保留仅限
   * 本地开发 / 自动化测试的匿名只读模式，且 production 一律返回 503
   * mcp_auth_not_configured（fail-closed）。
   */
  authenticator?: McpAuthenticator;
}

/** 认证 / 绑定校验失败的受控结果：HTTP 状态码 + 稳定错误码 + 固定文案。 */
interface McpAuthRejection {
  status: number;
  code: string;
  message: string;
}

const MCP_METHODS = new Set(['POST', 'GET', 'DELETE']);
const ALLOW_METHODS = 'GET, POST, DELETE, OPTIONS';

/** 从 Host 头提取主机名（去掉端口、处理 IPv6 中括号字面量）。 */
function extractHostname(hostHeader: string): string | null {
  const h = hostHeader.trim();
  if (h.length === 0) {
    return null;
  }
  if (h.startsWith('[')) {
    const end = h.indexOf(']');
    if (end === -1) {
      return null;
    }
    return h.slice(1, end).toLowerCase();
  }
  const segments = h.split(':');
  if (segments.length === 2) {
    const [host, port] = segments as [string, string];
    if (/^\d+$/.test(port)) {
      return host.toLowerCase();
    }
  }
  // 无括号 IPv6 裸地址或单段 hostname：整个视为主机名。
  return h.toLowerCase();
}

/** 从 Origin 头提取主机名；无法解析时返回 null。 */
function originHostname(originHeader: string): string | null {
  const value = originHeader.trim();
  if (value.length === 0) {
    return null;
  }
  try {
    return new URL(value).hostname.toLowerCase();
  } catch {
    return null;
  }
}

interface GuardRejection {
  status: number;
  code: string;
  message: string;
  host: string;
}

/**
 * Host/Origin 白名单校验（防 DNS rebinding）：
 * - Host 缺失、无法解析或不在白名单 → 拒绝；
 * - Origin 缺失 → 允许；Origin 存在但无法解析（含字面量 "null"）或主机名不在
 *   白名单 → 一律拒绝；
 * - 日志只记录规范化后的 hostname 或固定占位符（<missing> / <unparseable>），
 *   绝不记录原始 header、完整请求头或客户端提交的秘密。
 */
function guardHostOrigin(
  request: FastifyRequest,
  allowedHosts: string[],
): GuardRejection | null {
  const hostHeader = request.headers.host;
  if (typeof hostHeader !== 'string' || hostHeader.trim() === '') {
    return {
      status: 403,
      code: 'mcp_host_not_allowed',
      message: 'Host not allowed',
      host: '<missing>',
    };
  }
  const host = extractHostname(hostHeader);
  if (host === null || !allowedHosts.includes(host)) {
    return {
      status: 403,
      code: 'mcp_host_not_allowed',
      message: 'Host not allowed',
      host: host ?? '<unparseable>',
    };
  }
  const originHeader = request.headers.origin;
  if (typeof originHeader === 'string' && originHeader.trim() !== '') {
    const originHost = originHostname(originHeader);
    if (originHost === null || !allowedHosts.includes(originHost)) {
      return {
        status: 403,
        code: 'mcp_origin_not_allowed',
        message: 'Origin not allowed',
        host: originHost ?? '<unparseable>',
      };
    }
  }
  return null;
}

/**
 * 严格解析 `Authorization: Bearer <token>`：
 * - 缺失（无头 / 非字符串）→ null；
 * - 多个 Authorization 头（数组）→ null（拒绝多值）；
 * - 非 Bearer scheme（如 Basic）→ null；
 * - `Bearer` 后必须恰好一个空格，token 必须非空且不含任意空白字符（含 tab 等），
 *   否则 → null。
 * 只解析 token，不记录、不返回任何 Authorization 头内容。
 */
function parseBearerToken(request: FastifyRequest): string | null {
  const raw = request.headers.authorization;
  if (Array.isArray(raw) || typeof raw !== 'string') {
    return null;
  }
  // [^\s] 是空白字符（空格 / tab / 换行等）的补集：token 内出现任意空白都不匹配。
  const match = /^Bearer ([^\s]+)$/i.exec(raw.trim());
  if (match === null) {
    return null;
  }
  const token = match[1]!;
  if (token.length === 0) {
    return null;
  }
  return token;
}

/**
 * 用注入的认证器解析当前请求的 Bearer token：
 * - 缺失 / 格式错误 / 无效 / 撤销 / 过期统一返回受控 401（不区分原因、不泄露秘密）；
 * - 认证器抛出未知异常（未来 OAuth / 数据库认证器可能带连接串、Token 或密码）时，
 *   在本边界内捕获并脱敏：日志只记录稳定 errType，响应返回受控 500
 *   mcp_auth_internal_error，绝不交给会记录完整异常的通用错误路径；
 * - 认证成功后统一调用防守性校验，并复制 / 冻结成 session 私有只读对象再绑定，
 *   避免外部认证器实现随后修改同一对象；上下文非法同样返回受控脱敏内部错误，
 *   不建立 session。
 */
async function resolveAuthContext(
  request: FastifyRequest,
  authenticator: McpAuthenticator,
  logger: McpLogger,
): Promise<McpAuthContext | McpAuthRejection> {
  const token = parseBearerToken(request);
  if (token === null) {
    return {
      status: 401,
      code: 'mcp_auth_required',
      message: 'MCP authentication required',
    };
  }
  let context: McpAuthContext;
  try {
    context = await authenticator.authenticate(token);
  } catch (err) {
    if (err instanceof McpAuthenticationError) {
      return {
        status: 401,
        code: 'mcp_auth_required',
        message: 'MCP authentication required',
      };
    }
    logger.error(
      { errType: err instanceof Error ? err.name : typeof err },
      'mcp authenticator internal error',
    );
    return {
      status: 500,
      code: 'mcp_auth_internal_error',
      message: 'MCP authentication internal error',
    };
  }
  try {
    assertValidMcpAuthContext(context);
  } catch {
    logger.error({ errType: 'McpAuthConfigurationError' }, 'mcp auth context invalid');
    return {
      status: 500,
      code: 'mcp_auth_internal_error',
      message: 'MCP authentication internal error',
    };
  }
  // 复制并冻结成 session 私有的只读对象：外部实现不再能修改同一引用。
  // 只显式拷贝五个身份白名单字段，绝不展开任意认证器返回对象——McpAuthenticator
  // 是可替换接口，运行时返回值可能带 TypeScript 类型之外的可枚举字段（如 token /
  // tokenHash / authorization / secret），展开会把秘密夹带进 session 与 Server 依赖。
  return Object.freeze({
    actorId: context.actorId,
    actorCode: context.actorCode,
    actorType: context.actorType,
    connectionId: context.connectionId,
    permissionProfile: context.permissionProfile,
  });
}

/**
 * MCP Streamable HTTP 入口（挂在现有 Fastify 模块化单体，不另开端口）。
 *
 * - 通过 SDK 的 Node 原始 request/response 接入（StreamableHTTPServerTransport
 *   内部用 @hono/node-server 做 Node ↔ Web Standard 转换），正确处理 POST/GET/DELETE；
 * - 内存 session registry：initialize 创建独立 session/transport，后续请求按
 *   Mcp-Session-Id 路由；DELETE 与应用关闭时清理；
 * - 未认证仅限本地开发与自动化测试：production 模式对 /mcp 一律返回受控 503
 *   mcp_auth_not_configured，registry 保持 0，杜绝未认证构建被误部署到公网。
 */
export const mcpRoutes: FastifyPluginAsync<McpRouteOptions> = async (app, opts) => {
  const sessions = opts.sessions;

  app.addHook('onClose', async () => {
    await sessions.closeAll();
  });

  app.all('/mcp', async (request, reply) => {
    // 安全门（fail-closed）：未注入认证器时，未认证的 MCP 只允许本地开发与自动化测试；
    // production 模式硬性拒绝一切 /mcp 请求（含 initialize），registry 保持 0，
    // 防止未认证构建被误部署到公网域名后直接读取项目数据。注入认证器后无论环境
    // 都必须执行认证，不能因 development / test 绕过。
    if (opts.config.nodeEnv === 'production' && opts.authenticator === undefined) {
      return reply.code(503).send({
        error: 'mcp_auth_not_configured',
        message: 'MCP is not configured for production until authentication is implemented',
      });
    }

    // Host/Origin 防护必须先于一切 MCP 处理，防止 DNS rebinding 探测。
    const guard = guardHostOrigin(request, opts.config.mcpAllowedHosts);
    if (guard) {
      app.log.warn({ code: guard.code, host: guard.host }, 'mcp host/origin rejected');
      return reply.code(guard.status).send({ error: guard.code, message: guard.message });
    }

    const method = request.method;

    if (method === 'OPTIONS') {
      return reply.code(204).header('allow', ALLOW_METHODS).send();
    }
    if (!MCP_METHODS.has(method)) {
      return reply
        .code(405)
        .header('allow', ALLOW_METHODS)
        .send({
          error: 'method_not_allowed',
          message: 'MCP Streamable HTTP only supports POST, GET, DELETE and OPTIONS',
        });
    }

    // 认证：注入认证器时，initialize 及后续 POST / GET / DELETE 都必须提供严格
    // Bearer 凭据；缺失 / 格式错误 / 无效 / 撤销 / 过期统一 401，不泄露具体原因。
    const authenticator = opts.authenticator;
    let authContext: McpAuthContext | null = null;
    if (authenticator !== undefined) {
      const resolved = await resolveAuthContext(request, authenticator, app.log);
      if ('status' in resolved) {
        app.log.warn({ code: resolved.code }, 'mcp authentication rejected');
        return reply.code(resolved.status).send({ error: resolved.code, message: resolved.message });
      }
      authContext = resolved;
    }

    const rawSessionId = request.headers['mcp-session-id'];
    const sessionId = Array.isArray(rawSessionId) ? rawSessionId[0] : rawSessionId;

    const session = sessionId !== undefined ? sessions.get(sessionId) : undefined;
    if (session === undefined && (method !== 'POST' || sessionId !== undefined)) {
      // GET/DELETE 必须携带已知 session；POST 携带无效/已删除 session id 时
      // 不复用、不静默新建，统一返回受控 404。
      return reply.code(404).send({
        error: 'mcp_session_not_found',
        message: 'MCP session not found',
      });
    }

    // 绑定校验：已知 session 的每个请求都必须重新验证凭据（撤销立即生效），并确认
    // 解析出的 actorId + connectionId 与该 session 在 initialize 时绑定的身份一致；
    // 换成另一条连接（即使属于同一 Actor）也不得接管旧 session，返回受控 403。
    // MCP Session ID 绝不参与推导 Actor 身份。
    if (session !== undefined && authenticator !== undefined && authContext !== null) {
      const bound = session.authContext;
      if (
        bound === null ||
        bound.actorId !== authContext.actorId ||
        bound.connectionId !== authContext.connectionId
      ) {
        app.log.warn({ code: 'mcp_session_identity_mismatch' }, 'mcp session identity mismatch');
        return reply.code(403).send({
          error: 'mcp_session_identity_mismatch',
          message: 'MCP session identity mismatch',
        });
      }
    }

    // 接管原始响应：由 transport 直接把 MCP 响应写到 Node 层。
    reply.hijack();
    const rawReq = request.raw;
    const rawRes = reply.raw;

    let freshSessionId: string | undefined;
    try {
      if (session === undefined) {
        // 新连接：prepare 预生成 session id 并预绑定 AuthContext（匿名模式为 null）；
        // initialize 到达后 transport 把该 session 注册进 registry。
        const fresh = sessions.prepare(authContext);
        freshSessionId = fresh.sessionId;
        await fresh.server.connect(fresh.transport);
        await fresh.transport.handleRequest(rawReq, rawRes, request.body);
        return;
      }
      await session.transport.handleRequest(rawReq, rawRes, request.body);
    } catch (err) {
      // 认证失败 / 身份不匹配 / transport 异常都不得创建或遗留 registry session：
      // 新连接尚未注册或刚注册即清理，已知 session 损坏也清理。
      if (freshSessionId !== undefined) {
        await sessions.delete(freshSessionId);
      } else if (session !== undefined) {
        await sessions.delete(session.sessionId);
      }
      // 只记录稳定错误分类，绝不记录原始异常 message / 堆栈 / 请求体。
      app.log.error(
        { errType: err instanceof Error ? err.name : typeof err },
        'mcp transport error',
      );
      if (!rawRes.headersSent) {
        rawRes.statusCode = 500;
        rawRes.setHeader('content-type', 'application/json');
        rawRes.end(JSON.stringify({ error: 'mcp_internal_error', message: 'MCP internal error' }));
      } else {
        rawRes.end();
      }
    }
  });
};
