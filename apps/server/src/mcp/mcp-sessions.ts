import { randomUUID } from 'node:crypto';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { buildMcpServer, type McpServerDeps } from './mcp-server.js';

export interface McpSession {
  server: McpServer;
  transport: StreamableHTTPServerTransport;
}

/**
 * 内存 session registry：为每个 MCP 连接维护独立的 transport + Server 实例。
 *
 * - session id 在 initialize 时由 transport 生成，通过 onsessioninitialized 回调注册；
 * - 两个客户端必然得到不同的 session，绝不共享临时协议状态（SDK 的 Server 一次只
 *   安全连接一个 transport）；
 * - DELETE 触发 onsessionclosed 清理，应用关闭时 closeAll 清理全部；
 * - MCP session 只是临时连接会话，绝不当作 AI Actor 身份。
 */
export class McpSessionRegistry {
  private readonly sessions = new Map<string, McpSession>();

  constructor(private readonly deps: McpServerDeps) {}

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
   * 为一个尚未完成 initialize 的新连接准备 transport + server。
   * 此时 session id 未知；收到 initialize 后 transport 生成 id 并通过
   * onsessioninitialized 把本 session 注册进 registry。
   */
  prepare(): McpSession {
    let server: McpServer;
    let transport: StreamableHTTPServerTransport;
    transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      enableJsonResponse: true,
      onsessioninitialized: (sessionId) => {
        this.sessions.set(sessionId, { server, transport });
      },
      onsessionclosed: (sessionId) => {
        void this.delete(sessionId);
      },
    });
    server = buildMcpServer(this.deps);
    return { server, transport };
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
