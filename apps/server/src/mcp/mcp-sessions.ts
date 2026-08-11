import { randomUUID } from 'node:crypto';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { buildMcpServer, type McpServerDeps } from './mcp-server.js';
import type { McpAuthContext } from '../domain/mcp-auth/mcp-auth-context.js';

export interface McpSession {
  server: McpServer;
  transport: StreamableHTTPServerTransport;
  /** 预生成的 session id；initialize 成功注册后即等于 registry key。 */
  readonly sessionId: string;
  /**
   * 该连接在 initialize 时由服务端凭据解析、经统一校验并复制 / 冻结后只读绑定的
   * AuthContext；本地开发 / 自动化测试的匿名只读模式为 null。绝不包含 Token 或其
   * 摘要。此对象同时被注入该 session 自己的 MCP Server 依赖（server 实例私有）。
   */
  readonly authContext: McpAuthContext | null;
}

/**
 * 内存 session registry：为每个 MCP 连接维护独立的 transport + Server 实例，
 * 并把 initialize 时解析出的只读 AuthContext 绑定到该 session。
 *
 * - session id 在 prepare 时预生成，initialize 到达后通过 onsessioninitialized 注册；
 * - 两个客户端必然得到不同的 session，绝不共享临时协议状态（SDK 的 Server 一次只
 *   安全连接一个 transport）；
 * - DELETE 触发 onsessionclosed 清理，应用关闭时 closeAll 清理全部；
 * - MCP session 只是临时连接会话，绝不当作 AI Actor 身份：身份只来自服务端
 *   Bearer 凭据解析出的 AuthContext，且后续每个请求都会重新验证并校验
 *   actorId + connectionId 与绑定一致。
 */
export class McpSessionRegistry {
  private readonly sessions = new Map<string, McpSession>();

  /** 共享服务依赖不含身份：AuthContext 只由 prepare 按连接注入到各 server 实例。 */
  constructor(
    private readonly deps: Omit<McpServerDeps, 'authContext'>,
  ) {}

  get size(): number {
    return this.sessions.size;
  }

  has(sessionId: string): boolean {
    return this.sessions.has(sessionId);
  }

  get(sessionId: string): McpSession | undefined {
    return this.sessions.get(sessionId);
  }

  /**
   * 为一个尚未完成 initialize 的新连接准备 transport + server，并把本次绑定的只读
   * AuthContext 注入该次新建的 MCP Server 依赖（匿名只读模式为 null），同时预绑定
   * 到该 session。session id 在此预生成，方便认证 / transport 异常时按 id 幂等清理。
   * 身份是该 server 实例私有、只读的，不进共享全局变量，也不得输出到现有工具。
   */
  prepare(authContext: McpAuthContext | null): McpSession {
    const sessionId = randomUUID();
    let server: McpServer;
    let transport: StreamableHTTPServerTransport;
    transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => sessionId,
      enableJsonResponse: true,
      onsessioninitialized: () => {
        this.sessions.set(sessionId, { server, transport, sessionId, authContext });
      },
      onsessionclosed: (closedSessionId) => {
        void this.delete(closedSessionId);
      },
    });
    server = buildMcpServer({ ...this.deps, authContext });
    return { server, transport, sessionId, authContext };
  }

  /** 关闭并移除一个 session（幂等）。transport.close / server.close 均可重入。 */
  async delete(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return;
    }
    this.sessions.delete(sessionId);
    await session.server.close();
    await session.transport.close();
  }

  /** 应用关闭时清理全部 session。 */
  async closeAll(): Promise<void> {
    const ids = [...this.sessions.keys()];
    for (const id of ids) {
      await this.delete(id);
    }
  }
}
