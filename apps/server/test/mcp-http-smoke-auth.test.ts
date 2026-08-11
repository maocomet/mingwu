import { describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { AUTH_FIXTURES, makeAuthenticator } from './mcp-auth-fixtures.js';
import { makeServices } from './helpers.js';

type App = ReturnType<typeof buildApp>;

/**
 * 真实 HTTP 冒烟（带 Bearer 认证）：服务真实监听 127.0.0.1 临时端口，
 * 用官方 MCP 客户端（StreamableHTTPClientTransport，真实 socket，requestInit
 * 携带 Authorization）完成带认证的 initialize / tools/list / tools/call、
 * 双连接 session 隔离 / DELETE 清理。结束后释放端口并关闭服务。
 */
describe('MCP Streamable HTTP real-HTTP auth smoke (127.0.0.1, ephemeral port)', () => {
  async function startServer(): Promise<{
    app: App;
    baseUrl: string;
    close: () => Promise<void>;
  }> {
    const config = loadConfig({ NODE_ENV: 'test' });
    const services = makeServices();
    const app = buildApp({
      config,
      projectService: services.projectService,
      stageService: services.stageService,
      taskService: services.taskService,
      projectStatusService: services.projectStatusService,
      studySessionService: services.studySessionService,
      studySessionDetailService: services.studySessionDetailService,
      studySessionCurrentService: services.studySessionCurrentService,
      studySummaryService: services.studySummaryService,
      mcpAuthenticator: makeAuthenticator(),
    });
    await app.listen({ host: '127.0.0.1', port: 0 });
    const address = app.server.address();
    if (address === null || typeof address === 'string') {
      throw new Error('expected a TCP address object from app.server.address()');
    }
    const baseUrl = `http://127.0.0.1:${address.port}`;
    return {
      app,
      baseUrl,
      close: async () => {
        await app.close();
      },
    };
  }

  async function connectClient(
    mcpUrl: string,
    token: string,
  ): Promise<{ client: Client; transport: StreamableHTTPClientTransport }> {
    const client = new Client({ name: 'smoke-auth-client', version: '0.0.1' });
    const transport = new StreamableHTTPClientTransport(new URL(mcpUrl), {
      requestInit: { headers: { authorization: `Bearer ${token}` } },
    });
    await client.connect(transport);
    return { client, transport };
  }

  it('real socket: authorized initialize + tools/list + isolated sessions + DELETE cleanup', async () => {
    const { app, baseUrl, close } = await startServer();
    try {
      // 客户端 A：连接 1（actorA）。无凭据的裸 initialize 应先被受控 401 拒绝。
      const noAuth = await fetch(`${baseUrl}/mcp`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: {
            protocolVersion: '2024-11-05',
            capabilities: {},
            clientInfo: { name: 'anon', version: '1' },
          },
        }),
      });
      expect(noAuth.status).toBe(401);

      const mcpUrl = `${baseUrl}/mcp`;
      const a = await connectClient(mcpUrl, AUTH_FIXTURES.connection1.token);
      const aSessionId = a.transport.sessionId;
      expect(typeof aSessionId).toBe('string');

      const { tools } = await a.client.listTools();
      expect(tools.map((t) => t.name).sort()).toEqual([
        'project_get_stage',
        'project_get_status',
        'project_list_stages',
        'study_get_current_session',
        'study_get_session',
      ]);

      // 经真实 socket 调用只读工具，身份由服务端凭据解析（工具不接收身份字段）。
      const project = await fetch(`${baseUrl}/api/v1/projects`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id: '00000000-0000-4000-8000-000000000010', name: '认证冒烟项目' }),
      });
      expect(project.status).toBe(201);
      const statusResult = await a.client.callTool({
        name: 'project_get_status',
        arguments: { project_id: '00000000-0000-4000-8000-000000000010' },
      });
      const firstBlock = Array.isArray(statusResult.content) ? statusResult.content[0] : undefined;
      const statusText =
        firstBlock && typeof firstBlock === 'object' && 'text' in firstBlock
          ? String((firstBlock as { text?: unknown }).text ?? '')
          : '';
      expect(statusText).not.toBe('');
      const statusJson = JSON.parse(statusText) as { project: { id: string } };
      expect(statusJson.project.id).toBe('00000000-0000-4000-8000-000000000010');

      // 客户端 B：连接 2（同一 Actor 的另一条连接），独立 session。
      const b = await connectClient(mcpUrl, AUTH_FIXTURES.connection2.token);
      const bSessionId = b.transport.sessionId;
      expect(typeof bSessionId).toBe('string');
      expect(bSessionId).not.toBe(aSessionId);
      expect(
        (app as unknown as { mcpSessions: { size: number } }).mcpSessions.size,
      ).toBe(2);

      // B 的连接不能接管 A 的 session：直接复用 A 的 sessionId 发请求会被 403 拒绝。
      const takeOver = await fetch(`${baseUrl}/mcp`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          'mcp-session-id': aSessionId,
          'mcp-protocol-version': '2024-11-05',
          authorization: `Bearer ${AUTH_FIXTURES.connection2.token}`,
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }),
      });
      expect(takeOver.status).toBe(403);
      const takeOverBody = (await takeOver.json()) as { error?: string };
      expect(takeOverBody.error).toBe('mcp_session_identity_mismatch');

      // 关闭 A（DELETE），B 不受影响。
      await a.transport.terminateSession();
      await a.client.close();
      expect(
        (app as unknown as { mcpSessions: { size: number } }).mcpSessions.size,
      ).toBe(1);

      const bList = await b.client.listTools();
      expect(bList.tools).toHaveLength(5);

      // B 也通过 DELETE 显式清理（client.close 不保证发送 DELETE）。
      await b.transport.terminateSession();
      await b.client.close();
      expect(
        (app as unknown as { mcpSessions: { size: number } }).mcpSessions.size,
      ).toBe(0);
    } finally {
      await close();
    }
  });
});
