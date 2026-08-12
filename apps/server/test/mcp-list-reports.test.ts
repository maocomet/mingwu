import { describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { LATEST_PROTOCOL_VERSION } from '@modelcontextprotocol/sdk/types.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ProjectStage } from '@mingwu/contracts';
import { buildApp } from '../src/app.js';
import type { ProjectWorkReportService } from '../src/application/project-work-report/project-work-report-service.js';
import { ProjectWorkReportScopeCorruptError } from '../src/domain/project-work-report/errors.js';
import { loadConfig } from '../src/config.js';
import { buildMcpServer, type McpLogger } from '../src/mcp/mcp-server.js';
import { makeProjectWorkReport, makeServices, makeStage, uuid } from './helpers.js';

type Services = ReturnType<typeof makeServices>;

interface BuildOptions {
  services?: Services;
  projectWorkReportService?: ProjectWorkReportService;
  logger?: McpLogger;
}

/** 匿名只读上下文（null）：project_list_reports 是只读工具，不要求 Actor 身份。 */
function buildTestServer(opts: BuildOptions = {}) {
  const services = opts.services ?? makeServices();
  const server = buildMcpServer({
    aiTaskService: services.aiTaskService,
    projectStatusService: services.projectStatusService,
    stageService: services.stageService,
    studySessionDetailService: services.studySessionDetailService,
    studySessionCurrentService: services.studySessionCurrentService,
    studyReportService: services.studyReportService,
    stageUpdateRequestService: services.stageUpdateRequestService,
    projectWorkReportService: opts.projectWorkReportService ?? services.projectWorkReportService,
    serviceName: 'mingwu-server',
    serviceVersion: '0.1.0',
    logger: opts.logger ?? { error: () => undefined },
    authContext: null,
  });
  return { server, services };
}

/** 用官方 Client + SDK 内存 transport 建立真实协议连接（自动完成 initialize 握手）。 */
async function connectClient(server: McpServer): Promise<Client> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'list-reports-test-client', version: '0.0.1' });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return client;
}

/** callTool 未提供 resultSchema 时返回联合类型；这里只取其中的文本内容块。 */
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

/** 捕获 McpLogger.error 的全部日志文本，用于断言脱敏与范围腐败明细只进日志。 */
function createLogCapture() {
  const lines: string[] = [];
  const logger: McpLogger = {
    error: (...args: unknown[]) => {
      lines.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '));
    },
  };
  const text = () => lines.join('\n');
  return { logger, text };
}

/** 在共享仓储中落一条真实 Stage，返回完整对象（报告 seed 必须沿用其 projectId）。 */
async function seedStage(services: Services): Promise<ProjectStage> {
  const stage = makeStage({});
  await services.stageRepository.createIfAbsent(stage);
  return stage;
}

describe('MCP project_list_reports read-only tool', () => {
  it('is listed by tools/list with a precise read-only description and a strict single-field schema', async () => {
    const { server } = buildTestServer();
    const client = await connectClient(server);
    try {
      const { tools } = await client.listTools();
      const tool = tools.find((t) => t.name === 'project_list_reports');
      expect(tool).toBeDefined();
      // 明确只读、明确排序与隔离语义、明确不混入 Study Report、明确不改数据。
      expect(tool!.description).toContain('只读');
      expect(tool!.description).toContain('submittedAt');
      expect(tool!.description).toContain('id');
      expect(tool!.description).toContain('Study Report');
      expect(tool!.description).toContain('不会修改');
      // 严格 schema：仅 stage_id（UUID），禁止未知字段。
      expect(tool!.inputSchema.type).toBe('object');
      expect(tool!.inputSchema.additionalProperties).toBe(false);
      expect([...(tool!.inputSchema.required ?? [])].sort()).toEqual(['stage_id']);
      const prop = tool!.inputSchema.properties?.stage_id as Record<string, unknown> | undefined;
      expect(prop?.type).toBe('string');
      expect(prop?.format).toBe('uuid');
    } finally {
      await client.close();
      await server.close();
    }
  });

  it('anonymous read-only: returns an empty list for an existing stage with no reports', async () => {
    const { server, services } = buildTestServer();
    const stage = await seedStage(services);
    const client = await connectClient(server);
    try {
      const result = await client.callTool({
        name: 'project_list_reports',
        arguments: { stage_id: stage.id },
      });
      expect(result.isError).not.toBe(true);
      expect(JSON.parse(firstText(result))).toEqual({ reports: [] });
    } finally {
      await client.close();
      await server.close();
    }
  });

  it('returns only directly-associated reports in stable order (submittedAt DESC, id ASC) and matches the service', async () => {
    const { server, services } = buildTestServer();
    const stage = await seedStage(services);
    const otherStage = await seedStage(services);
    const lowId = makeProjectWorkReport({
      id: '00000000-0000-4000-8000-000000000001',
      stageId: stage.id,
      projectId: stage.projectId,
      submittedAt: '2026-08-11T05:00:00.000Z',
      roundGoal: 'low-id',
    });
    const highId = makeProjectWorkReport({
      id: '00000000-0000-4000-8000-000000000002',
      stageId: stage.id,
      projectId: stage.projectId,
      submittedAt: '2026-08-11T05:00:00.000Z',
      roundGoal: 'high-id',
    });
    const newest = makeProjectWorkReport({
      stageId: stage.id,
      projectId: stage.projectId,
      submittedAt: '2026-08-11T08:00:00.000Z',
      roundGoal: 'newest',
    });
    services.projectWorkReportRepository.seed(lowId);
    services.projectWorkReportRepository.seed(highId);
    services.projectWorkReportRepository.seed(newest);
    // 其他关卡与项目级报告不混入。
    services.projectWorkReportRepository.seed(
      makeProjectWorkReport({
        stageId: otherStage.id,
        projectId: otherStage.projectId,
        submittedAt: '2026-08-11T09:00:00.000Z',
      }),
    );
    services.projectWorkReportRepository.seed(
      makeProjectWorkReport({ stageId: null, submittedAt: '2026-08-11T09:00:00.000Z' }),
    );

    const client = await connectClient(server);
    try {
      const result = await client.callTool({
        name: 'project_list_reports',
        arguments: { stage_id: stage.id },
      });
      expect(result.isError).not.toBe(true);
      const { reports } = JSON.parse(firstText(result)) as {
        reports: Array<{ id: string; roundGoal: string }>;
      };
      expect(reports.map((r) => r.id)).toEqual([newest.id, lowId.id, highId.id]);
      expect(reports.map((r) => r.roundGoal)).toEqual(['newest', 'low-id', 'high-id']);
      // 与 ProjectWorkReportService.listByStage 语义完全一致（顺序 + 内容 + 空列表）。
      expect({ reports }).toEqual({
        reports: await services.projectWorkReportService.listByStage(stage.id),
      });
    } finally {
      await client.close();
      await server.close();
    }
  });

  it('returns the controlled error for an unknown stage', async () => {
    const { server } = buildTestServer();
    const client = await connectClient(server);
    try {
      const result = await client.callTool({
        name: 'project_list_reports',
        arguments: { stage_id: uuid() },
      });
      expect(result.isError).toBe(true);
      expect(firstText(result)).toBe('关卡不存在');
    } finally {
      await client.close();
      await server.close();
    }
  });

  it('rejects unknown fields, forged identity / ownership fields, and non-uuid stage_id (strict schema)', async () => {
    const { server } = buildTestServer();
    const client = await connectClient(server);
    try {
      // .strict() 拒绝任何额外字段：归属字段与伪造身份字段一律被拒。
      const forgedCases: Array<Record<string, unknown>> = [
        { stage_id: uuid(), project_id: uuid() },
        { stage_id: uuid(), actor_id: 'forged' },
        { stage_id: uuid(), actorId: 'forged' },
        { stage_id: uuid(), submittedActorId: 'forged' },
        { stage_id: uuid(), connectionId: 'forged' },
        { stage_id: uuid(), session_id: uuid() },
        { stage_id: uuid(), bogus: 'x' },
      ];
      for (const args of forgedCases) {
        const result = await client.callTool({ name: 'project_list_reports', arguments: args });
        expect(result.isError).toBe(true);
        expect(firstText(result)).toContain('Unrecognized key');
      }
      // 非 UUID → 受控拒绝。
      const invalid = await client.callTool({
        name: 'project_list_reports',
        arguments: { stage_id: 'not-a-uuid' },
      });
      expect(invalid.isError).toBe(true);
      expect(firstText(invalid)).toContain('Invalid uuid');
    } finally {
      await client.close();
      await server.close();
    }
  });

  it('scope corruption returns a controlled error without leaking internal IDs (details only in the log)', async () => {
    const services = makeServices();
    const capture = createLogCapture();
    const DIRTY_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const throwingService = {
      listByStage: async () => {
        throw new ProjectWorkReportScopeCorruptError(
          DIRTY_ID,
          'leak-stage-1',
          'leak-project-1',
          'leak-stage-2',
          'leak-project-1',
        );
      },
    } as unknown as ProjectWorkReportService;
    const { server } = buildTestServer({
      services,
      projectWorkReportService: throwingService,
      logger: capture.logger,
    });
    const client = await connectClient(server);
    try {
      const result = await client.callTool({
        name: 'project_list_reports',
        arguments: { stage_id: uuid() },
      });
      expect(result.isError).toBe(true);
      expect(firstText(result)).toBe('关卡报告数据不一致');
      // 响应不含任何内部 ID。
      const serialized = firstText(result);
      expect(serialized).not.toContain(DIRTY_ID);
      expect(serialized).not.toContain('leak-stage-1');
      expect(serialized).not.toContain('leak-stage-2');
      expect(serialized).not.toContain('leak-project-1');
    } finally {
      await client.close();
      await server.close();
    }
    // 范围腐败明细（报告 / 关卡 / 项目 ID）只进服务端日志。
    const logText = capture.text();
    expect(logText).toContain('project_list_reports scope corruption detected');
    expect(logText).toContain(DIRTY_ID);
    expect(logText).toContain('leak-stage-1');
  });

  it('two independent MCP sessions reuse the same service and read consistently with isolated protocol state', async () => {
    const services = makeServices();
    const stage = await seedStage(services);
    services.projectWorkReportRepository.seed(
      makeProjectWorkReport({
        stageId: stage.id,
        projectId: stage.projectId,
        submittedAt: '2026-08-11T01:00:00.000Z',
        roundGoal: '共享报告',
      }),
    );
    const a = buildTestServer({ services });
    const b = buildTestServer({ services });
    const ca = await connectClient(a.server);
    const cb = await connectClient(b.server);
    try {
      // 两个 session 读到一致数据（共享同一业务服务，不复制读取 / 排序算法）。
      const ra = await ca.callTool({
        name: 'project_list_reports',
        arguments: { stage_id: stage.id },
      });
      const rb = await cb.callTool({
        name: 'project_list_reports',
        arguments: { stage_id: stage.id },
      });
      expect(ra.isError).not.toBe(true);
      expect(rb.isError).not.toBe(true);
      expect(firstText(ra)).toBe(firstText(rb));
      const { reports } = JSON.parse(firstText(ra)) as {
        reports: Array<{ roundGoal: string }>;
      };
      expect(reports).toHaveLength(1);
      expect(reports[0]!.roundGoal).toBe('共享报告');
      // 协议状态隔离：关闭 A 的 session 不影响 B 继续读取。
      await ca.close();
      const rbAfter = await cb.callTool({
        name: 'project_list_reports',
        arguments: { stage_id: stage.id },
      });
      expect(rbAfter.isError).not.toBe(true);
      expect(JSON.parse(firstText(rbAfter))).toEqual({ reports });
    } finally {
      await ca.close();
      await cb.close();
      await a.server.close();
      await b.server.close();
    }
  });

  it('sanitizes an unknown exception: generic result, log without the raw message or secret', async () => {
    const capture = createLogCapture();
    const throwingService = {
      listByStage: async () => {
        throw new Error('database password=LIST_SECRET leaked');
      },
    } as unknown as ProjectWorkReportService;
    const { server } = buildTestServer({
      projectWorkReportService: throwingService,
      logger: capture.logger,
    });
    const client = await connectClient(server);
    try {
      const result = await client.callTool({
        name: 'project_list_reports',
        arguments: { stage_id: uuid() },
      });
      expect(result.isError).toBe(true);
      expect(firstText(result)).toBe('内部错误');
      expect(firstText(result)).not.toContain('LIST_SECRET');
    } finally {
      await client.close();
      await server.close();
    }
    const logText = capture.text();
    expect(logText).toContain('mcp tool internal error');
    expect(logText).not.toContain('LIST_SECRET');
    expect(logText).not.toContain('database password=');
  });
});

describe('MCP project_list_reports over Streamable HTTP (/mcp)', () => {
  const BASE_HEADERS: Record<string, string> = {
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
  };

  function setup() {
    const config = loadConfig({ NODE_ENV: 'test' });
    const services = makeServices();
    const app = buildApp({
      config,
      aiTaskService: services.aiTaskService,
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
    return { app, services };
  }

  async function initialize(
    app: ReturnType<typeof buildApp>,
  ): Promise<{ sessionId: string; protocolVersion: string }> {
    const res = await app.inject({
      method: 'POST',
      url: '/mcp',
      headers: BASE_HEADERS,
      payload: {
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: LATEST_PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: { name: 'http-list-reports-client', version: '0.0.1' },
        },
      },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    const protocolVersion = body.result.protocolVersion as string;
    const sidHeader = res.headers['mcp-session-id'];
    const sessionId = Array.isArray(sidHeader) ? sidHeader[0] : sidHeader;
    if (typeof sessionId !== 'string' || sessionId.length === 0) {
      throw new Error('expected a Mcp-Session-Id header on the initialize response');
    }
    const notif = await mcpPost(app, sessionId, protocolVersion, {
      jsonrpc: '2.0',
      method: 'notifications/initialized',
    });
    expect(notif.statusCode).toBe(202);
    return { sessionId, protocolVersion };
  }

  async function mcpPost(
    app: ReturnType<typeof buildApp>,
    sessionId: string | undefined,
    protocolVersion: string | undefined,
    payload: Record<string, unknown>,
  ) {
    const headers: Record<string, string> = { ...BASE_HEADERS };
    if (sessionId !== undefined) headers['mcp-session-id'] = sessionId;
    if (protocolVersion !== undefined) headers['mcp-protocol-version'] = protocolVersion;
    return app.inject({ method: 'POST', url: '/mcp', headers, payload });
  }

  it('lists reports with the same content, order, and empty-list semantics as the App API', async () => {
    const { app, services } = setup();
    try {
      const stage = makeStage({});
      await services.stageRepository.createIfAbsent(stage);
      const lowId = makeProjectWorkReport({
        id: '00000000-0000-4000-8000-000000000001',
        stageId: stage.id,
        projectId: stage.projectId,
        submittedAt: '2026-08-11T05:00:00.000Z',
        roundGoal: 'low-id',
      });
      const highId = makeProjectWorkReport({
        id: '00000000-0000-4000-8000-000000000002',
        stageId: stage.id,
        projectId: stage.projectId,
        submittedAt: '2026-08-11T05:00:00.000Z',
        roundGoal: 'high-id',
      });
      const newest = makeProjectWorkReport({
        stageId: stage.id,
        projectId: stage.projectId,
        submittedAt: '2026-08-11T08:00:00.000Z',
        roundGoal: 'newest',
      });
      services.projectWorkReportRepository.seed(lowId);
      services.projectWorkReportRepository.seed(highId);
      services.projectWorkReportRepository.seed(newest);

      const { sessionId, protocolVersion } = await initialize(app);

      // 空列表语义与 App API 一致。
      const emptyStage = makeStage({});
      await services.stageRepository.createIfAbsent(emptyStage);
      const empty = await mcpPost(app, sessionId, protocolVersion, {
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: { name: 'project_list_reports', arguments: { stage_id: emptyStage.id } },
      });
      expect(empty.statusCode).toBe(200);
      expect(empty.json().result.isError).not.toBe(true);
      expect(empty.json().result.content[0].text).toBe(JSON.stringify({ reports: [] }));

      // 稳定排序与 App API 完全一致。
      const list = await mcpPost(app, sessionId, protocolVersion, {
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: { name: 'project_list_reports', arguments: { stage_id: stage.id } },
      });
      const { reports } = JSON.parse(list.json().result.content[0].text) as {
        reports: Array<{ id: string; roundGoal: string }>;
      };
      expect(reports.map((r) => r.id)).toEqual([newest.id, lowId.id, highId.id]);
      const api = await app.inject({ method: 'GET', url: `/api/v1/stages/${stage.id}/reports` });
      expect(api.statusCode).toBe(200);
      expect({ reports }).toEqual(api.json());

      // 未知关卡 → 受控错误。
      const unknown = await mcpPost(app, sessionId, protocolVersion, {
        jsonrpc: '2.0',
        id: 4,
        method: 'tools/call',
        params: { name: 'project_list_reports', arguments: { stage_id: uuid() } },
      });
      expect(unknown.json().result.isError).toBe(true);
      expect(unknown.json().result.content[0].text).toBe('关卡不存在');

      // 严格 schema：伪造身份 / 归属字段被拒，响应无内部 ID 回显。
      const forged = await mcpPost(app, sessionId, protocolVersion, {
        jsonrpc: '2.0',
        id: 5,
        method: 'tools/call',
        params: {
          name: 'project_list_reports',
          arguments: { stage_id: stage.id, submittedActorId: 'forged' },
        },
      });
      expect(forged.json().result.isError).toBe(true);
      expect(forged.json().result.content[0].text).toContain('Unrecognized key');
      expect(forged.body).not.toContain('forged');
    } finally {
      await app.close();
    }
  });
});
