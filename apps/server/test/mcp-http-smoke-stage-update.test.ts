import { describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { StageUpdateRequest } from '@mingwu/contracts';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { AUTH_FIXTURES, makeAuthenticator } from './mcp-auth-fixtures.js';
import { makeServices, uuid } from './helpers.js';

type App = ReturnType<typeof buildApp>;

/**
 * 真实 HTTP 冒烟（带 Bearer 认证）：服务真实监听 127.0.0.1 临时端口，
 * 用官方 MCP 客户端（StreamableHTTPClientTransport，真实 socket，requestInit
 * 携带 Authorization）经 initialize → project_submit_stage_update 提交申请，
 * 再通过共享服务 / 仓储读回申请，确认正式 Stage 在成功前后完全未变化。
 * 结束后释放端口并关闭服务。
 */
describe('MCP project_submit_stage_update real-HTTP smoke (127.0.0.1, ephemeral port)', () => {
  async function startServer(): Promise<{
    app: App;
    baseUrl: string;
    services: ReturnType<typeof makeServices>;
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
      studyReportService: services.studyReportService,
      stageUpdateRequestService: services.stageUpdateRequestService,
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
      services,
      close: async () => {
        await app.close();
      },
    };
  }

  async function connectClient(
    mcpUrl: string,
    token: string,
  ): Promise<{ client: Client; transport: StreamableHTTPClientTransport }> {
    const client = new Client({ name: 'smoke-stage-update-client', version: '0.0.1' });
    const transport = new StreamableHTTPClientTransport(new URL(mcpUrl), {
      requestInit: { headers: { authorization: `Bearer ${token}` } },
    });
    await client.connect(transport);
    return { client, transport };
  }

  /** 取工具调用的首个文本内容块。 */
  function toolText(result: {
    [key: string]: unknown;
    content?: ReadonlyArray<{ type: string; text?: string }>;
  }): string {
    const block = result.content?.[0];
    if (!block || block.type !== 'text' || typeof block.text !== 'string') {
      throw new Error('expected text content block');
    }
    return block.text;
  }

  it('real socket: submit a stage update request under the bound identity and read it back via the shared service', async () => {
    const { app, baseUrl, services, close } = await startServer();
    try {
      // 用 App HTTP API 建项目与关卡（MCP 与 App 共享同一仓储）。
      const projectRes = await fetch(`${baseUrl}/api/v1/projects`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id: uuid(), name: '申请冒烟项目' }),
      });
      expect(projectRes.status).toBe(201);
      const project = (await projectRes.json()) as { id: string };

      const stageRes = await fetch(`${baseUrl}/api/v1/projects/${project.id}/stages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id: uuid(), name: '第一关', position: 1 }),
      });
      expect(stageRes.status).toBe(201);
      const stage = (await stageRes.json()) as { id: string; version: number; status: string };

      // 记录提交前的正式 Stage 快照。
      const before = await services.stageRepository.findById(stage.id);
      if (!before) {
        throw new Error('stage should exist');
      }
      const snapshot = { status: before.status, version: before.version };

      // 客户端 A（actorA）：经真实 socket + Bearer 提交申请。
      const a = await connectClient(`${baseUrl}/mcp`, AUTH_FIXTURES.connection1.token);
      const requestId = uuid();
      const submit = await a.client.callTool({
        name: 'project_submit_stage_update',
        arguments: {
          request_id: requestId,
          stage_id: stage.id,
          expected_stage_version: before.version,
          proposed_status: 'in_progress',
          reason: '真实 HTTP 冒烟：申请进入下一阶段',
        },
      });
      expect(submit.isError).not.toBe(true);
      const request = JSON.parse(toolText(submit)) as StageUpdateRequest;
      expect(request.id).toBe(requestId);
      expect(request.stageId).toBe(stage.id);
      expect(request.projectId).toBe(project.id);
      expect(request.requesterActorId).toBe(AUTH_FIXTURES.actorA.actorId);
      expect(request.status).toBe('pending');

      // 通过共享服务读回申请，确认写入归属与内容一致。
      const read = await services.stageUpdateRequestService.getById(requestId);
      expect(read).toEqual(request);
      const listed = await services.stageUpdateRequestService.listByStage(stage.id);
      expect(listed).toHaveLength(1);
      expect(listed[0]!.id).toBe(requestId);

      // 正式 Stage 在申请成功前后完全未变化。
      const after = await services.stageRepository.findById(stage.id);
      expect(after && { status: after.status, version: after.version }).toEqual(snapshot);

      await a.transport.terminateSession();
      await a.client.close();
      expect((app as unknown as { mcpSessions: { size: number } }).mcpSessions.size).toBe(0);
    } finally {
      await close();
    }
  });
});
