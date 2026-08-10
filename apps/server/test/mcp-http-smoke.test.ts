import { describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { makeServices, uuid } from './helpers.js';

type App = ReturnType<typeof buildApp>;

/**
 * 真实 HTTP 冒烟：把 Fastify 服务真正监听在 127.0.0.1 的临时端口上，
 * 用官方 MCP 客户端（StreamableHTTPClientTransport，走真实 socket）完成
 * initialize / tools/list / tools/call / 双客户端 session 隔离 / DELETE 清理。
 * 结束后释放端口并关闭服务。
 */
describe('MCP Streamable HTTP real-HTTP smoke (127.0.0.1, ephemeral port)', () => {
  async function startServer(): Promise<{ app: App; baseUrl: string; close: () => Promise<void> }> {
    const config = loadConfig({ NODE_ENV: 'test' });
    const services = makeServices();
    const app = buildApp({
      config,
      projectService: services.projectService,
      stageService: services.stageService,
      taskService: services.taskService,
      projectStatusService: services.projectStatusService,
      studySessionService: services.studySessionService,
    studySummaryService: services.studySummaryService,
    });
    await app.listen({ host: '127.0.0.1', port: 0 });
    const address = app.server.address();
    if (address === null || typeof address === 'string') {
      throw new Error('expected a TCP address object from app.server.address()');
    }
    const port = address.port;
    const baseUrl = `http://127.0.0.1:${port}`;
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
  ): Promise<{ client: Client; transport: StreamableHTTPClientTransport }> {
    const client = new Client({ name: 'smoke-client', version: '0.0.1' });
    const transport = new StreamableHTTPClientTransport(new URL(mcpUrl));
    await client.connect(transport);
    return { client, transport };
  }

  /** 取工具调用的第一个文本内容块（callTool 返回联合类型，这里只取文本）。 */
  function firstText(result: {
    [key: string]: unknown;
    content?: ReadonlyArray<{ type: string; text?: string }>;
  }): string {
    const block = result.content?.[0];
    if (!block || block.type !== 'text' || typeof block.text !== 'string') {
      throw new Error('expected text content block');
    }
    return block.text;
  }

  it('real socket: initialize + tools/list + tools/call match the App API; sessions isolated; DELETE cleans up', async () => {
    const { app, baseUrl, close } = await startServer();
    try {
      // 用真实 HTTP 建数据并读取 App API 状态。
      const projectRes = await fetch(`${baseUrl}/api/v1/projects`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id: uuid(), name: '冒烟项目' }),
      });
      expect(projectRes.status).toBe(201);
      const project = (await projectRes.json()) as { id: string };

      const stageRes = await fetch(`${baseUrl}/api/v1/projects/${project.id}/stages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id: uuid(), name: '第一关', position: 1 }),
      });
      expect(stageRes.status).toBe(201);
      const stage = (await stageRes.json()) as { id: string };

      const mcpUrl = `${baseUrl}/mcp`;

      // 客户端 A：真实协议握手，读取工具列表与数据。
      const a = await connectClient(mcpUrl);
      const aSessionId = a.transport.sessionId;
      expect(typeof aSessionId).toBe('string');

      const { tools } = await a.client.listTools();
      expect(tools.map((t) => t.name).sort()).toEqual([
        'project_get_stage',
        'project_get_status',
        'project_list_stages',
      ]);

      const statusResult = await a.client.callTool({
        name: 'project_get_status',
        arguments: { project_id: project.id },
      });
      const statusText = firstText(statusResult);
      const status = JSON.parse(statusText) as { project: { id: string } };
      expect(status.project.id).toBe(project.id);

      // 与 App API 的状态结果一致。
      const apiRes = await fetch(`${baseUrl}/api/v1/projects/${project.id}/status`);
      expect(apiRes.status).toBe(200);
      expect(status).toEqual(await apiRes.json());

      const listResult = await a.client.callTool({
        name: 'project_list_stages',
        arguments: { project_id: project.id },
      });
      const stages = JSON.parse(firstText(listResult)) as Array<{ name: string }>;
      expect(stages.map((s) => s.name)).toEqual(['第一关']);

      // 客户端 B：独立 session。
      const b = await connectClient(mcpUrl);
      const bSessionId = b.transport.sessionId;
      expect(typeof bSessionId).toBe('string');
      expect(bSessionId).not.toBe(aSessionId);
      expect((app as unknown as { mcpSessions: { size: number } }).mcpSessions.size).toBe(2);

      // B 可独立读取数据。
      const bList = await b.client.listTools();
      expect(bList.tools).toHaveLength(3);

      // DELETE 结束 A 的 session；A 立即失效，B 不受影响。
      await a.transport.terminateSession();
      await a.client.close();
      expect((app as unknown as { mcpSessions: { size: number } }).mcpSessions.size).toBe(1);

      const bAfter = await b.client.listTools();
      expect(bAfter.tools).toHaveLength(3);

      await b.client.close();
    } finally {
      await close();
      // 应用关闭后所有 session 被清理。
      expect((app as unknown as { mcpSessions: { size: number } }).mcpSessions.size).toBe(0);
    }
  });
});
