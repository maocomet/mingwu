import { describe, expect, it } from 'vitest';
import { Writable } from 'node:stream';
import { LATEST_PROTOCOL_VERSION } from '@modelcontextprotocol/sdk/types.js';
import { buildApp, type AppDeps } from '../src/app.js';
import type { ProjectStatusService } from '../src/application/project-status/project-status-service.js';
import { loadConfig } from '../src/config.js';
import type { McpSessionRegistry } from '../src/mcp/mcp-sessions.js';
import { makeServices, uuid } from './helpers.js';

type App = ReturnType<typeof buildApp>;

const BASE_HEADERS: Record<string, string> = {
  'content-type': 'application/json',
  accept: 'application/json, text/event-stream',
};

function setup(logger?: AppDeps['logger']) {
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
    logger,
  });
  return { app, ...services };
}

function registryOf(app: App): McpSessionRegistry {
  return (app as unknown as { mcpSessions: McpSessionRegistry }).mcpSessions;
}

/** 用 pino 同步 stream 捕获 Fastify 日志，用于断言 MCP 日志脱敏。 */
function createLogCapture() {
  const chunks: Buffer[] = [];
  const stream = new Writable({
    write(chunk: Buffer, _enc: BufferEncoding, callback: (error?: Error | null) => void) {
      chunks.push(Buffer.from(chunk));
      callback();
    },
  });
  // pino 10 对普通 Writable 同步写入，不需要 sync 选项。
  const logger: AppDeps['logger'] = { level: 'info', stream };
  const text = () => Buffer.concat(chunks).toString('utf8');
  return { logger, text };
}

async function mcpPost(
  app: App,
  sessionId: string | undefined,
  protocolVersion: string | undefined,
  payload: Record<string, unknown>,
  extraHeaders: Record<string, string> = {},
) {
  const headers: Record<string, string> = { ...BASE_HEADERS, ...extraHeaders };
  if (sessionId !== undefined) headers['mcp-session-id'] = sessionId;
  if (protocolVersion !== undefined) headers['mcp-protocol-version'] = protocolVersion;
  return app.inject({ method: 'POST', url: '/mcp', headers, payload });
}

/** 通过真实 MCP 协议在 HTTP 层建立 session（initialize + initialized 通知）。 */
async function initialize(app: App): Promise<{ sessionId: string; protocolVersion: string }> {
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
        clientInfo: { name: 'http-test-client', version: '0.0.1' },
      },
    },
  });
  expect(res.statusCode).toBe(200);
  const body = res.json();
  const protocolVersion = body.result.protocolVersion as string;
  expect(typeof protocolVersion).toBe('string');
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

async function createProjectWithData(app: App): Promise<{ projectId: string; stageId: string }> {
  const project = await app.inject({
    method: 'POST',
    url: '/api/v1/projects',
    payload: { id: uuid(), name: 'MCP HTTP 项目' },
  });
  expect(project.statusCode).toBe(201);
  const projectId = project.json().id;
  const stage = await app.inject({
    method: 'POST',
    url: `/api/v1/projects/${projectId}/stages`,
    payload: { id: uuid(), name: '第一关', position: 1 },
  });
  expect(stage.statusCode).toBe(201);
  return { projectId, stageId: stage.json().id };
}

describe('MCP Streamable HTTP via /mcp', () => {
  it('initialize establishes a session; tools/list exposes exactly three read-only tools', async () => {
    const { app } = setup();
    try {
      const { sessionId, protocolVersion } = await initialize(app);
      expect(registryOf(app).size).toBe(1);

      const res = await mcpPost(app, sessionId, protocolVersion, {
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/list',
        params: {},
      });
      expect(res.statusCode).toBe(200);
      const tools = res.json().result.tools as Array<{
        name: string;
        description: string;
        inputSchema: { type: string; additionalProperties: boolean; required: string[] };
      }>;
      expect(tools.map((t) => t.name).sort()).toEqual([
        'project_get_stage',
        'project_get_status',
        'project_list_stages',
      ]);
      for (const tool of tools) {
        expect(tool.description).toContain('只读');
        expect(tool.inputSchema.type).toBe('object');
        expect(tool.inputSchema.additionalProperties).toBe(false);
        expect(tool.inputSchema.required).toHaveLength(1);
      }
    } finally {
      await app.close();
    }
  });

  it('tools/call returns the same project status as the App API', async () => {
    const { app } = setup();
    try {
      const { projectId } = await createProjectWithData(app);
      const { sessionId, protocolVersion } = await initialize(app);
      const res = await mcpPost(app, sessionId, protocolVersion, {
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: { name: 'project_get_status', arguments: { project_id: projectId } },
      });
      expect(res.statusCode).toBe(200);
      const call = res.json().result;
      const text = call.content[0].text as string;
      const parsed = JSON.parse(text) as { project: { id: string } };
      expect(parsed.project.id).toBe(projectId);

      const api = await app.inject({
        method: 'GET',
        url: `/api/v1/projects/${projectId}/status`,
      });
      expect(api.statusCode).toBe(200);
      expect(parsed).toEqual(api.json());
    } finally {
      await app.close();
    }
  });

  it('project_list_stages and project_get_stage return correct data over HTTP', async () => {
    const { app } = setup();
    try {
      const { projectId, stageId } = await createProjectWithData(app);
      const { sessionId, protocolVersion } = await initialize(app);

      const list = await mcpPost(app, sessionId, protocolVersion, {
        jsonrpc: '2.0',
        id: 4,
        method: 'tools/call',
        params: { name: 'project_list_stages', arguments: { project_id: projectId } },
      });
      const stages = JSON.parse(list.json().result.content[0].text) as Array<{
        id: string;
        name: string;
      }>;
      expect(stages.map((s) => s.name)).toEqual(['第一关']);

      const get = await mcpPost(app, sessionId, protocolVersion, {
        jsonrpc: '2.0',
        id: 5,
        method: 'tools/call',
        params: { name: 'project_get_stage', arguments: { stage_id: stageId } },
      });
      const stage = JSON.parse(get.json().result.content[0].text) as { id: string };
      expect(stage.id).toBe(stageId);
    } finally {
      await app.close();
    }
  });

  it('returns controlled isError results for unknown resources and invalid UUIDs', async () => {
    const { app } = setup();
    try {
      const { sessionId, protocolVersion } = await initialize(app);

      const unknown = await mcpPost(app, sessionId, protocolVersion, {
        jsonrpc: '2.0',
        id: 6,
        method: 'tools/call',
        params: { name: 'project_get_status', arguments: { project_id: uuid() } },
      });
      expect(unknown.json().result.isError).toBe(true);
      expect(unknown.json().result.content[0].text).toBe('项目不存在');

      const invalid = await mcpPost(app, sessionId, protocolVersion, {
        jsonrpc: '2.0',
        id: 7,
        method: 'tools/call',
        params: { name: 'project_get_status', arguments: { project_id: 'not-a-uuid' } },
      });
      expect(invalid.json().result.isError).toBe(true);
      expect(invalid.json().result.content[0].text).toContain('Invalid uuid');
    } finally {
      await app.close();
    }
  });

  it('two independent clients get different sessions and do not share protocol state', async () => {
    const { app } = setup();
    try {
      const a = await initialize(app);
      const b = await initialize(app);
      expect(a.sessionId).not.toBe(b.sessionId);
      expect(registryOf(app).size).toBe(2);

      // A 正常，B 正常，各自互不影响。
      const aList = await mcpPost(app, a.sessionId, a.protocolVersion, {
        jsonrpc: '2.0',
        id: 8,
        method: 'tools/list',
        params: {},
      });
      expect(aList.statusCode).toBe(200);
      const bList = await mcpPost(app, b.sessionId, b.protocolVersion, {
        jsonrpc: '2.0',
        id: 9,
        method: 'tools/list',
        params: {},
      });
      expect(bList.statusCode).toBe(200);

      // 删除 A 后，B 仍然可用（互不复用、互不清理）。
      const del = await app.inject({
        method: 'DELETE',
        url: '/mcp',
        headers: { 'mcp-session-id': a.sessionId, accept: 'application/json, text/event-stream' },
      });
      expect(del.statusCode).toBe(200);
      expect(registryOf(app).size).toBe(1);
      const bAfter = await mcpPost(app, b.sessionId, b.protocolVersion, {
        jsonrpc: '2.0',
        id: 10,
        method: 'tools/list',
        params: {},
      });
      expect(bAfter.statusCode).toBe(200);
    } finally {
      await app.close();
    }
  });

  it('an unknown or deleted session is never reused (404)', async () => {
    const { app } = setup();
    try {
      const { sessionId, protocolVersion } = await initialize(app);

      // 未知名 session id。
      const unknown = await mcpPost(app, uuid(), protocolVersion, {
        jsonrpc: '2.0',
        id: 11,
        method: 'tools/list',
        params: {},
      });
      expect(unknown.statusCode).toBe(404);

      // 删除后原 session id 立即失效。
      const del = await app.inject({
        method: 'DELETE',
        url: '/mcp',
        headers: { 'mcp-session-id': sessionId, accept: 'application/json, text/event-stream' },
      });
      expect(del.statusCode).toBe(200);
      const after = await mcpPost(app, sessionId, protocolVersion, {
        jsonrpc: '2.0',
        id: 12,
        method: 'tools/list',
        params: {},
      });
      expect(after.statusCode).toBe(404);
      expect(registryOf(app).size).toBe(0);
    } finally {
      await app.close();
    }
  });

  it('GET requires a known session and returns controlled 404 otherwise', async () => {
    const { app } = setup();
    try {
      const { sessionId } = await initialize(app);
      const noSession = await app.inject({
        method: 'GET',
        url: '/mcp',
        headers: { accept: 'text/event-stream' },
      });
      expect(noSession.statusCode).toBe(404);

      const unknownSession = await app.inject({
        method: 'GET',
        url: '/mcp',
        headers: { accept: 'text/event-stream', 'mcp-session-id': uuid() },
      });
      expect(unknownSession.statusCode).toBe(404);
      void sessionId;
    } finally {
      await app.close();
    }
  });

  it('unsupported methods return controlled 405 with an Allow header', async () => {
    const { app } = setup();
    try {
      for (const method of ['PUT', 'PATCH', 'HEAD'] as const) {
        const res = await app.inject({ method, url: '/mcp', payload: {} });
        expect(res.statusCode).toBe(405);
        expect(res.headers.allow).toContain('POST');
      }
    } finally {
      await app.close();
    }
  });

  it('rejects a Host outside the allowlist and an Origin outside the allowlist', async () => {
    const { app } = setup();
    try {
      const evilHost = await app.inject({
        method: 'POST',
        url: '/mcp',
        headers: { ...BASE_HEADERS, host: 'evil.example.com' },
        payload: { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} },
      });
      expect(evilHost.statusCode).toBe(403);
      expect(evilHost.json().error).toBe('mcp_host_not_allowed');

      const evilOrigin = await app.inject({
        method: 'POST',
        url: '/mcp',
        headers: { ...BASE_HEADERS, origin: 'https://evil.example.com' },
        payload: { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} },
      });
      expect(evilOrigin.statusCode).toBe(403);
      expect(evilOrigin.json().error).toBe('mcp_origin_not_allowed');
      // 拒绝响应不得泄露任何请求头或 Token。
      expect(evilOrigin.body).not.toContain('token');
    } finally {
      await app.close();
    }
  });

  it('allows a missing Origin and a whitelisted localhost Origin', async () => {
    const { app } = setup();
    try {
      // 缺少 Origin（BASE_HEADERS 未带 origin）→ 允许。
      const { sessionId } = await initialize(app);
      expect(registryOf(app).size).toBe(1);
      void sessionId;

      const withOrigin = await app.inject({
        method: 'POST',
        url: '/mcp',
        headers: { ...BASE_HEADERS, origin: 'http://localhost:5173' },
        payload: {
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: { protocolVersion: LATEST_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 'c', version: '1' } },
        },
      });
      expect(withOrigin.statusCode).toBe(200);
    } finally {
      await app.close();
    }
  });

  it('rejects the literal null Origin and unparseable Origins with 403', async () => {
    const { app } = setup();
    try {
      const nullOrigin = await app.inject({
        method: 'POST',
        url: '/mcp',
        headers: { ...BASE_HEADERS, origin: 'null' },
        payload: { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} },
      });
      expect(nullOrigin.statusCode).toBe(403);
      expect(nullOrigin.json().error).toBe('mcp_origin_not_allowed');

      const unparseable = await app.inject({
        method: 'POST',
        url: '/mcp',
        headers: { ...BASE_HEADERS, origin: 'password=TEST_SECRET' },
        payload: { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} },
      });
      expect(unparseable.statusCode).toBe(403);
      expect(unparseable.json().error).toBe('mcp_origin_not_allowed');
      expect(unparseable.body).not.toContain('TEST_SECRET');
    } finally {
      await app.close();
    }
  });

  it('rejects secret-bearing Origins and never logs the raw header or secret', async () => {
    const capture = createLogCapture();
    const { app } = setup(capture.logger);
    try {
      const withToken = await app.inject({
        method: 'POST',
        url: '/mcp',
        headers: { ...BASE_HEADERS, origin: 'https://evil.example.com?access_token=TEST_SECRET' },
        payload: { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} },
      });
      expect(withToken.statusCode).toBe(403);
      expect(withToken.json().error).toBe('mcp_origin_not_allowed');
      expect(withToken.body).not.toContain('TEST_SECRET');

      const withPassword = await app.inject({
        method: 'POST',
        url: '/mcp',
        headers: { ...BASE_HEADERS, origin: 'password=TEST_SECRET' },
        payload: { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} },
      });
      expect(withPassword.statusCode).toBe(403);
      expect(withPassword.body).not.toContain('TEST_SECRET');

      const logs = capture.text();
      // 拒绝警告确实被记录并捕获（否则断言会空过），且只含受控分类，不含秘密。
      expect(logs).toContain('mcp_origin_not_allowed');
      expect(logs).not.toContain('TEST_SECRET');
      expect(logs).not.toContain('access_token=');
      expect(logs).not.toContain('password=');
      expect(logs).not.toContain('evil.example.com?');
    } finally {
      await app.close();
    }
  });

  it('a tool unknown error returns a generic result and logs no raw message/secret', async () => {
    const capture = createLogCapture();
    const config = loadConfig({ NODE_ENV: 'test' });
    const services = makeServices();
    const throwingStatus = {
      getStatus: async () => {
        throw new Error('database password=TEST_SECRET leaked');
      },
    } as unknown as ProjectStatusService;
    const app = buildApp({
      config,
      projectService: services.projectService,
      stageService: services.stageService,
      taskService: services.taskService,
      projectStatusService: throwingStatus,
      studySessionService: services.studySessionService,
    studySummaryService: services.studySummaryService,
      logger: capture.logger,
    });
    try {
      const { sessionId, protocolVersion } = await initialize(app);
      const res = await mcpPost(app, sessionId, protocolVersion, {
        jsonrpc: '2.0',
        id: 30,
        method: 'tools/call',
        params: { name: 'project_get_status', arguments: { project_id: uuid() } },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().result.isError).toBe(true);
      expect(res.json().result.content[0].text).toBe('内部错误');
      expect(res.body).not.toContain('TEST_SECRET');

      const logs = capture.text();
      // 工具内部错误确实被记录（否则断言会空过），且只含稳定分类 errType。
      expect(logs).toContain('mcp tool internal error');
      expect(logs).toContain('errType');
      expect(logs).not.toContain('TEST_SECRET');
      expect(logs).not.toContain('database password=');
    } finally {
      await app.close();
    }
  });

  it('production mode refuses to initialize /mcp and keeps the registry empty', async () => {
    const config = loadConfig({ NODE_ENV: 'production' });
    const services = makeServices();
    const app = buildApp({
      config,
      projectService: services.projectService,
      stageService: services.stageService,
      taskService: services.taskService,
      projectStatusService: services.projectStatusService,
      studySessionService: services.studySessionService,
    studySummaryService: services.studySummaryService,
      logger: { level: 'silent' },
    });
    try {
      const initializeWithHost = (host: string) =>
        app.inject({
          method: 'POST',
          url: '/mcp',
          headers: { ...BASE_HEADERS, host },
          payload: {
            jsonrpc: '2.0',
            id: 1,
            method: 'initialize',
            params: {
              protocolVersion: LATEST_PROTOCOL_VERSION,
              capabilities: {},
              clientInfo: { name: 'prod-client', version: '1' },
            },
          },
        });

      // 即使 Host 为公网域名也无法 initialize。
      const publicHost = await initializeWithHost('mingwu.maomao.im');
      expect(publicHost.statusCode).toBe(503);
      expect(publicHost.json().error).toBe('mcp_auth_not_configured');

      const localHost = await initializeWithHost('127.0.0.1');
      expect(localHost.statusCode).toBe(503);
      expect(localHost.json().error).toBe('mcp_auth_not_configured');
      expect(registryOf(app).size).toBe(0);
    } finally {
      await app.close();
    }
  });

  it('MCP calls do not change any Project/Stage/Task data', async () => {
    const { app } = setup();
    try {
      const { projectId, stageId } = await createProjectWithData(app);
      const task = await app.inject({
        method: 'POST',
        url: `/api/v1/projects/${projectId}/stages/${stageId}/tasks`,
        payload: { id: uuid(), title: '任务', position: 1 },
      });
      expect(task.statusCode).toBe(201);

      const snapshot = async () => ({
        status: await app.inject({ method: 'GET', url: `/api/v1/projects/${projectId}/status` }),
        tree: await app.inject({ method: 'GET', url: `/api/v1/projects/${projectId}/progress-tree` }),
      });
      const before = await snapshot();

      const { sessionId, protocolVersion } = await initialize(app);
      await mcpPost(app, sessionId, protocolVersion, {
        jsonrpc: '2.0',
        id: 20,
        method: 'tools/call',
        params: { name: 'project_get_status', arguments: { project_id: projectId } },
      });
      await mcpPost(app, sessionId, protocolVersion, {
        jsonrpc: '2.0',
        id: 21,
        method: 'tools/call',
        params: { name: 'project_list_stages', arguments: { project_id: projectId } },
      });
      await mcpPost(app, sessionId, protocolVersion, {
        jsonrpc: '2.0',
        id: 22,
        method: 'tools/call',
        params: { name: 'project_get_stage', arguments: { stage_id: stageId } },
      });

      const after = await snapshot();
      expect(after.status.body).toEqual(before.status.body);
      expect(after.tree.body).toEqual(before.tree.body);
    } finally {
      await app.close();
    }
  });

  it('app.close() cleans up all sessions in the registry', async () => {
    const { app } = setup();
    await initialize(app);
    await initialize(app);
    expect(registryOf(app).size).toBe(2);
    await app.close();
    expect(registryOf(app).size).toBe(0);
  });
});
