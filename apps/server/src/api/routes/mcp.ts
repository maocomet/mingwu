import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import type { AppConfig } from '../../config.js';
import { McpSessionRegistry } from '../../mcp/mcp-sessions.js';

export interface McpRouteOptions {
  config: AppConfig;
  sessions: McpSessionRegistry;
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
    // 安全门：AuthContext/OAuth 尚未接入，未认证的 MCP 只允许本地开发与自动化测试。
    // production 模式硬性拒绝一切 /mcp 请求（含 initialize），registry 保持 0，
    // 防止当前未认证构建被误部署到公网域名后直接读取项目数据。
    if (opts.config.nodeEnv === 'production') {
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

    // 接管原始响应：由 transport 直接把 MCP 响应写到 Node 层。
    reply.hijack();
    const rawReq = request.raw;
    const rawRes = reply.raw;

    try {
      if (session === undefined) {
        // 新连接：initialize 到达时 transport 生成 session id 并注册进 registry。
        const fresh = sessions.prepare();
        await fresh.server.connect(fresh.transport);
        await fresh.transport.handleRequest(rawReq, rawRes, request.body);
        return;
      }
      await session.transport.handleRequest(rawReq, rawRes, request.body);
    } catch (err) {
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
