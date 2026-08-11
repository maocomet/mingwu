import { describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import {
  makeProjectWorkReport,
  makeServices,
  makeStudyParticipant,
  makeStudySummary,
  uuid,
} from './helpers.js';

type App = ReturnType<typeof buildApp>;

/**
 * 真实 HTTP 冒烟：把 Fastify 服务真正监听在 127.0.0.1 的临时端口上，
 * 用官方 MCP 客户端（StreamableHTTPClientTransport，走真实 socket）完成
 * initialize / tools/list / tools/call / 双客户端 session 隔离 / DELETE 清理。
 * 结束后释放端口并关闭服务。
 */
describe('MCP Streamable HTTP real-HTTP smoke (127.0.0.1, ephemeral port)', () => {
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
    projectWorkReportService: services.projectWorkReportService,
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
      services,
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
    const { app, baseUrl, services, close } = await startServer();
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

      // 真实 HTTP 建学习会话（MCP 与 App 共享同一仓储）。创建后是 created 草稿，
      // 先经真实 socket 验证 study_get_current_session 返回 null；稍后再由服务启动
      // 为 running 并播种报告 / 参与 / 总结，验证聚合。
      const studyRes = await fetch(`${baseUrl}/api/v1/study-sessions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id: uuid(), timerMode: 'count_up' }),
      });
      expect(studyRes.status).toBe(201);
      const studySessionId = ((await studyRes.json()) as { id: string }).id;
      const actorA = uuid();

      const mcpUrl = `${baseUrl}/mcp`;

      // 客户端 A：真实协议握手，读取工具列表与数据。
      const a = await connectClient(mcpUrl);
      const aSessionId = a.transport.sessionId;
      expect(typeof aSessionId).toBe('string');

      const { tools } = await a.client.listTools();
      expect(tools.map((t) => t.name).sort()).toEqual([
        'project_get_stage',
        'project_get_status',
        'project_list_reports',
        'project_list_stages',
        'project_submit_stage_update',
        'study_append_report',
        'study_get_current_session',
        'study_get_session',
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

      // 播种一条直接关联该关卡的 Project Work Report，经真实 socket 读取
      // project_list_reports，并验证与 App HTTP 接口结果一致。
      services.projectWorkReportRepository.seed(
        makeProjectWorkReport({
          stageId: stage.id,
          projectId: project.id,
          submittedAt: '2026-08-11T02:00:00.000Z',
          roundGoal: '冒烟关卡报告',
        }),
      );
      const reportsResult = await a.client.callTool({
        name: 'project_list_reports',
        arguments: { stage_id: stage.id },
      });
      expect(reportsResult.isError).not.toBe(true);
      const reports = JSON.parse(firstText(reportsResult)) as {
        reports: Array<{ id: string; roundGoal: string }>;
      };
      expect(reports.reports).toHaveLength(1);
      expect(reports.reports[0]!.roundGoal).toBe('冒烟关卡报告');
      const apiReports = await fetch(`${baseUrl}/api/v1/stages/${stage.id}/reports`);
      expect(apiReports.status).toBe(200);
      expect(reports).toEqual(await apiReports.json());

      // 会话还是 created 草稿：study_get_current_session 返回 JSON null（正常结果）。
      const currentNull = await a.client.callTool({
        name: 'study_get_current_session',
        arguments: {},
      });
      expect(currentNull.isError).not.toBe(true);
      expect(firstText(currentNull)).toBe('null');

      // 通过应用服务启动为 running 并播种报告 / 参与 / 总结（与 App 共享同一仓储）。
      let smokeSession = await services.studySessionService.getById(studySessionId);
      smokeSession = await services.studySessionService.setTask(studySessionId, {
        expectedVersion: smokeSession.version,
        taskText: '冒烟学习任务',
      });
      await services.studySessionService.startStudySession(studySessionId, {
        expectedVersion: smokeSession.version,
      });
      await services.studyReportRepository.appendReport({
        id: uuid(),
        studySessionId,
        actorId: actorA,
        content: '冒烟学习报告',
        submittedAt: '2026-01-01T08:00:00.000Z',
      });
      await services.studyParticipantRepository.upsert(
        makeStudyParticipant({
          studySessionId,
          actorId: actorA,
          joinedAt: '2026-01-01T08:00:00.000Z',
          lastActiveAt: '2026-01-01T08:00:00.000Z',
        }),
      );
      await services.studySummaryRepository.createIfAbsent(
        makeStudySummary({ studySessionId, content: '冒烟正式总结' }),
      );

      // 经真实 MCP socket：study_get_current_session 现在返回 running 会话的四部分聚合。
      const currentResult = await a.client.callTool({
        name: 'study_get_current_session',
        arguments: {},
      });
      const current = JSON.parse(firstText(currentResult)) as {
        session: { id: string; status: string };
        summary: unknown;
        participants: unknown[];
        reports: unknown[];
      };
      expect(current.session.id).toBe(studySessionId);
      expect(current.session.status).toBe('running');
      expect(current.summary).toBeTruthy();
      expect(current.participants).toHaveLength(1);
      expect(current.reports).toHaveLength(1);

      // 经真实 MCP socket 读取指定会话聚合，App 写入的数据立刻可见。
      const studyResult = await a.client.callTool({
        name: 'study_get_session',
        arguments: { session_id: studySessionId },
      });
      const study = JSON.parse(firstText(studyResult)) as {
        session: { id: string };
        summary: unknown;
        participants: unknown[];
        reports: unknown[];
      };
      expect(study.session.id).toBe(studySessionId);
      expect(study.summary).toBeTruthy();
      expect(study.participants).toHaveLength(1);
      expect(study.reports).toHaveLength(1);

      // 客户端 B：独立 session。
      const b = await connectClient(mcpUrl);
      const bSessionId = b.transport.sessionId;
      expect(typeof bSessionId).toBe('string');
      expect(bSessionId).not.toBe(aSessionId);
      expect((app as unknown as { mcpSessions: { size: number } }).mcpSessions.size).toBe(2);

      // B 可独立读取数据。
      const bList = await b.client.listTools();
      expect(bList.tools).toHaveLength(8);

      // DELETE 结束 A 的 session；A 立即失效，B 不受影响。
      await a.transport.terminateSession();
      await a.client.close();
      expect((app as unknown as { mcpSessions: { size: number } }).mcpSessions.size).toBe(1);

      const bAfter = await b.client.listTools();
      expect(bAfter.tools).toHaveLength(8);

      await b.client.close();
    } finally {
      await close();
      // 应用关闭后所有 session 被清理。
      expect((app as unknown as { mcpSessions: { size: number } }).mcpSessions.size).toBe(0);
    }
  });
});
