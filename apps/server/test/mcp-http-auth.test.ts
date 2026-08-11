import { describe, expect, it } from 'vitest';
import { Writable } from 'node:stream';
import { LATEST_PROTOCOL_VERSION } from '@modelcontextprotocol/sdk/types.js';
import { buildApp, type AppDeps } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import type { McpSessionRegistry } from '../src/mcp/mcp-sessions.js';
import type { McpAuthenticator } from '../src/domain/mcp-auth/mcp-authenticator.js';
import type { McpAuthContext } from '../src/domain/mcp-auth/mcp-auth-context.js';
import { AUTH_FIXTURES, makeAuthenticator } from './mcp-auth-fixtures.js';
import { makeServices } from './helpers.js';

type App = ReturnType<typeof buildApp>;

const BASE_HEADERS: Record<string, string> = {
  'content-type': 'application/json',
  accept: 'application/json, text/event-stream',
};

const AUTH_HEADER = `Bearer ${AUTH_FIXTURES.connection1.token}`;

function setupAuth(
  authenticator: McpAuthenticator,
  nodeEnv = 'test',
  logger?: AppDeps['logger'],
) {
  const config = loadConfig({ NODE_ENV: nodeEnv });
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
    mcpAuthenticator: authenticator,
    logger,
  });
  return { app, ...services };
}

function registryOf(app: App): McpSessionRegistry {
  return (app as unknown as { mcpSessions: McpSessionRegistry }).mcpSessions;
}

/** 用 pino 同步 stream 捕获 Fastify 日志，用于断言认证器异常脱敏。 */
function createLogCapture() {
  const chunks: Buffer[] = [];
  const stream = new Writable({
    write(chunk: Buffer, _enc: BufferEncoding, callback: (error?: Error | null) => void) {
      chunks.push(Buffer.from(chunk));
      callback();
    },
  });
  const logger: AppDeps['logger'] = { level: 'info', stream };
  const text = () => Buffer.concat(chunks).toString('utf8');
  return { logger, text };
}

async function mcpPost(
  app: App,
  sessionId: string | undefined,
  protocolVersion: string | undefined,
  payload: Record<string, unknown>,
  extraHeaders: Record<string, string | string[]> = {},
) {
  const headers: Record<string, string | string[]> = { ...BASE_HEADERS, ...extraHeaders };
  if (sessionId !== undefined) headers['mcp-session-id'] = sessionId;
  if (protocolVersion !== undefined) headers['mcp-protocol-version'] = protocolVersion;
  return app.inject({ method: 'POST', url: '/mcp', headers, payload });
}

async function initialize(
  app: App,
  token: string,
): Promise<{ sessionId: string; protocolVersion: string }> {
  const res = await mcpPost(app, undefined, undefined, {
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: LATEST_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: 'auth-test-client', version: '0.0.1' },
    },
  }, { authorization: `Bearer ${token}` });
  expect(res.statusCode).toBe(200);
  const sidHeader = res.headers['mcp-session-id'];
  const sessionId = Array.isArray(sidHeader) ? sidHeader[0] : sidHeader;
  if (typeof sessionId !== 'string' || sessionId.length === 0) {
    throw new Error('expected a Mcp-Session-Id header on the initialize response');
  }
  const body = res.json();
  const protocolVersion = body.result.protocolVersion as string;
  await mcpPost(app, sessionId, protocolVersion, {
    jsonrpc: '2.0',
    method: 'notifications/initialized',
  }, { authorization: `Bearer ${token}` });
  return { sessionId, protocolVersion };
}

describe('MCP /mcp Bearer authentication and session identity binding', () => {
  it('valid credentials initialize successfully and bind actorId/connectionId to the session without storing the token', async () => {
    const auth = makeAuthenticator();
    const { app } = setupAuth(auth);
    try {
      const { sessionId } = await initialize(app, AUTH_FIXTURES.connection1.token);
      const session = registryOf(app).get(sessionId)!;
      expect(session.authContext).toEqual({
        actorId: AUTH_FIXTURES.actorA.actorId,
        actorCode: AUTH_FIXTURES.actorA.actorCode,
        actorType: AUTH_FIXTURES.actorA.actorType,
        connectionId: AUTH_FIXTURES.connection1.connectionId,
        permissionProfile: AUTH_FIXTURES.actorA.permissionProfile,
      });
      // registry 只保存 sessionId（UUID）与只读 AuthContext，不得保存或回显 Token / 摘要。
      expect(session.sessionId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
      const serialized = JSON.stringify(session.authContext);
      expect(serialized).not.toContain(AUTH_FIXTURES.connection1.token);
      expect(serialized).not.toContain('Bearer');
      // 绑定上下文必须是复制并冻结后的只读对象（不是认证器返回的原引用）。
      expect(Object.isFrozen(session.authContext)).toBe(true);
    } finally {
      await app.close();
    }
  });

  it('missing, malformed, empty, multi-value and invalid Authorization are all controlled 401 with no secret leaked', async () => {
    const { app } = setupAuth(makeAuthenticator());
    try {
      const initializePayload = {
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: LATEST_PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: { name: 'bad-client', version: '1' },
        },
      };
      const cases: Array<{ name: string; headers: Record<string, string | string[]> }> = [
        { name: 'missing', headers: {} },
        { name: 'wrong scheme', headers: { authorization: `Basic ${AUTH_FIXTURES.connection1.token}` } },
        { name: 'scheme glued', headers: { authorization: `Bearer${AUTH_FIXTURES.connection1.token}` } },
        { name: 'empty bearer', headers: { authorization: 'Bearer ' } },
        { name: 'empty token value', headers: { authorization: 'Bearer   ' } },
        { name: 'invalid token', headers: { authorization: 'Bearer wrong-token' } },
        // token 内出现任意空白字符（含 tab）都不得被接受。
        { name: 'tab inside token', headers: { authorization: 'Bearer test-token-alpha\tconn1' } },
        {
          name: 'multiple authorization headers',
          headers: {
            authorization: [
              `Bearer ${AUTH_FIXTURES.connection1.token}`,
              `Bearer ${AUTH_FIXTURES.connection2.token}`,
            ],
          },
        },
      ];
      for (const c of cases) {
        const res = await mcpPost(app, undefined, undefined, initializePayload, c.headers);
        expect(res.statusCode, c.name).toBe(401);
        expect(res.json().error, c.name).toBe('mcp_auth_required');
        expect(res.body, c.name).not.toContain(AUTH_FIXTURES.connection1.token);
        expect(res.body, c.name).not.toContain('revoked');
        expect(res.body, c.name).not.toContain('expired');
      }
      expect(registryOf(app).size).toBe(0);
    } finally {
      await app.close();
    }
  });

  it('re-authenticates every request: revoking the credential immediately kills the session with a 401 and no reason leaked', async () => {
    const auth = makeAuthenticator();
    const { app } = setupAuth(auth);
    try {
      const { sessionId, protocolVersion } = await initialize(app, AUTH_FIXTURES.connection1.token);
      auth.revoke(AUTH_FIXTURES.connection1.connectionId);
      const res = await mcpPost(app, sessionId, protocolVersion, {
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/list',
        params: {},
      }, { authorization: AUTH_HEADER });
      expect(res.statusCode).toBe(401);
      expect(res.json().error).toBe('mcp_auth_required');
      expect(res.body).not.toContain('revoked');
      expect(res.body).not.toContain('expired');
      expect(res.body).not.toContain(AUTH_FIXTURES.connection1.token);
    } finally {
      await app.close();
    }
  });

  it('a different connection (same Actor) or another Actor cannot take over an existing session (403)', async () => {
    const { app } = setupAuth(makeAuthenticator());
    try {
      const { sessionId, protocolVersion } = await initialize(app, AUTH_FIXTURES.connection1.token);

      // 同一 Actor 的另一条连接：不得接管旧 session。
      const sameActorOtherConn = await mcpPost(app, sessionId, protocolVersion, {
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/list',
        params: {},
      }, { authorization: `Bearer ${AUTH_FIXTURES.connection2.token}` });
      expect(sameActorOtherConn.statusCode).toBe(403);
      expect(sameActorOtherConn.json().error).toBe('mcp_session_identity_mismatch');

      // 另一 Actor 的 token：同样不得接管。
      const otherActor = await mcpPost(app, sessionId, protocolVersion, {
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/list',
        params: {},
      }, { authorization: `Bearer ${AUTH_FIXTURES.connectionB.token}` });
      expect(otherActor.statusCode).toBe(403);
      expect(otherActor.json().error).toBe('mcp_session_identity_mismatch');

      // 原连接仍可继续使用。
      const original = await mcpPost(app, sessionId, protocolVersion, {
        jsonrpc: '2.0',
        id: 4,
        method: 'tools/list',
        params: {},
      }, { authorization: AUTH_HEADER });
      expect(original.statusCode).toBe(200);
    } finally {
      await app.close();
    }
  });

  it('two clients with different connections get independent sessions; closing one does not affect the other', async () => {
    const { app } = setupAuth(makeAuthenticator());
    try {
      const a = await initialize(app, AUTH_FIXTURES.connection1.token);
      const b = await initialize(app, AUTH_FIXTURES.connection2.token);
      expect(a.sessionId).not.toBe(b.sessionId);
      expect(registryOf(app).size).toBe(2);

      // 两条连接各自绑定独立的冻结只读上下文，互不串线。
      const sessionA = registryOf(app).get(a.sessionId)!;
      const sessionB = registryOf(app).get(b.sessionId)!;
      expect(sessionA.authContext).not.toBe(sessionB.authContext);
      expect(Object.isFrozen(sessionA.authContext)).toBe(true);
      expect(Object.isFrozen(sessionB.authContext)).toBe(true);
      expect(sessionA.authContext!.connectionId).toBe(AUTH_FIXTURES.connection1.connectionId);
      expect(sessionB.authContext!.connectionId).toBe(AUTH_FIXTURES.connection2.connectionId);

      // 关闭 A：A 的 session 被清理，B 不受影响。
      await mcpPost(app, a.sessionId, a.protocolVersion, {
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/list',
        params: {},
      }, { authorization: AUTH_HEADER });
      const delA = await app.inject({
        method: 'DELETE',
        url: '/mcp',
        headers: { 'mcp-session-id': a.sessionId, authorization: AUTH_HEADER },
      });
      expect(delA.statusCode).not.toBe(401);
      expect(registryOf(app).size).toBe(1);

      const bStill = await mcpPost(app, b.sessionId, b.protocolVersion, {
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/list',
        params: {},
      }, { authorization: `Bearer ${AUTH_FIXTURES.connection2.token}` });
      expect(bStill.statusCode).toBe(200);
    } finally {
      await app.close();
    }
  });

  it('GET and DELETE also require a valid Authorization header', async () => {
    const { app } = setupAuth(makeAuthenticator());
    try {
      const { sessionId } = await initialize(app, AUTH_FIXTURES.connection1.token);
      const getNoAuth = await app.inject({
        method: 'GET',
        url: '/mcp',
        headers: { accept: 'text/event-stream', 'mcp-session-id': sessionId },
      });
      expect(getNoAuth.statusCode).toBe(401);
      expect(getNoAuth.json().error).toBe('mcp_auth_required');

      const delNoAuth = await app.inject({
        method: 'DELETE',
        url: '/mcp',
        headers: { 'mcp-session-id': sessionId },
      });
      expect(delNoAuth.statusCode).toBe(401);
      expect(registryOf(app).size).toBe(1);

      // 带有效凭据的 DELETE 清理成功。
      const delAuth = await app.inject({
        method: 'DELETE',
        url: '/mcp',
        headers: { 'mcp-session-id': sessionId, authorization: AUTH_HEADER },
      });
      expect(delAuth.statusCode).not.toBe(401);
      expect(registryOf(app).size).toBe(0);
    } finally {
      await app.close();
    }
  });

  it('sanitizes an unknown authenticator exception: controlled 500, secrets never reach the response or the log', async () => {
    const { logger, text } = createLogCapture();
    // 假认证器抛出含密码 / 连接串的未知异常：任何秘密都不得进入响应或日志。
    const SECRET = 'postgres://app:password=TEST_SECRET@db.internal:5432/mingwu?ssl=true';
    const failingAuthenticator: McpAuthenticator = {
      async authenticate() {
        throw new Error(`db connection failed: ${SECRET}`);
      },
    };
    const { app } = setupAuth(failingAuthenticator, 'test', logger);
    try {
      const res = await mcpPost(app, undefined, undefined, {
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: LATEST_PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: { name: 'boom-client', version: '1' },
        },
      }, { authorization: `Bearer ${AUTH_FIXTURES.connection1.token}` });
      expect(res.statusCode).toBe(500);
      expect(res.json().error).toBe('mcp_auth_internal_error');
      expect(res.body).not.toContain(SECRET);
      expect(res.body).not.toContain('TEST_SECRET');
      expect(res.body).not.toContain('postgres://');
      // 未知认证器异常不得建立任何 session。
      expect(registryOf(app).size).toBe(0);
      // 捕获日志只记录稳定 errType，绝不含密码 / 连接串。
      const logText = text();
      expect(logText).not.toContain(SECRET);
      expect(logText).not.toContain('TEST_SECRET');
      expect(logText).toContain('mcp authenticator internal error');
    } finally {
      await app.close();
    }
  });

  it('rejects an invalid auth context returned by the authenticator: controlled 500, no session, no value echoed', async () => {
    const { logger, text } = createLogCapture();
    // 认证器“相信”了客户端提交的非法身份字段：路由必须防守性拒绝，不能绑定。
    const invalidAuthenticator: McpAuthenticator = {
      async authenticate(): Promise<McpAuthContext> {
        return {
          actorId: 'not-a-uuid',
          actorCode: 'x',
          actorType: 'resident_ai',
          connectionId: AUTH_FIXTURES.connection1.connectionId,
          permissionProfile: 'default',
        };
      },
    };
    const { app } = setupAuth(invalidAuthenticator, 'test', logger);
    try {
      const res = await mcpPost(app, undefined, undefined, {
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: LATEST_PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: { name: 'crafted-client', version: '1' },
        },
      }, { authorization: `Bearer ${AUTH_FIXTURES.connection1.token}` });
      expect(res.statusCode).toBe(500);
      expect(res.json().error).toBe('mcp_auth_internal_error');
      // 非法上下文不得建立 session，也不得把具体非法值反弹给调用方。
      expect(registryOf(app).size).toBe(0);
      expect(res.body).not.toContain('not-a-uuid');
      const logText = text();
      expect(logText).toContain('mcp auth context invalid');
      expect(logText).not.toContain('not-a-uuid');
    } finally {
      await app.close();
    }
  });

  it('whitelists only the five identity fields on the bound authContext, dropping smuggled secrets', async () => {
    // 假认证器在合法五字段之外，运行时额外返回 token / tokenHash / authorization /
    // secret（用类型断言模拟可替换接口的“越界”实现）。这些字段在 McpAuthContext
    // 类型上不存在，但运行时真实可枚举；路由复制时必须被丢弃，绝不能夹带进 session。
    const SNEAKY_TOKEN = 'sneaky-secret-token-value';
    const SNEAKY_HASH = 'sneaky-secret-token-hash-value';
    const SNEAKY_AUTHZ = 'Bearer sneaky-secret-authorization-value';
    const SNEAKY_SECRET = 'sneaky-secret-value';
    const smugglerAuthenticator: McpAuthenticator = {
      async authenticate(): Promise<McpAuthContext> {
        return {
          actorId: AUTH_FIXTURES.actorA.actorId,
          actorCode: AUTH_FIXTURES.actorA.actorCode,
          actorType: AUTH_FIXTURES.actorA.actorType,
          connectionId: AUTH_FIXTURES.connection1.connectionId,
          permissionProfile: AUTH_FIXTURES.actorA.permissionProfile,
          token: SNEAKY_TOKEN,
          tokenHash: SNEAKY_HASH,
          authorization: SNEAKY_AUTHZ,
          secret: SNEAKY_SECRET,
        } as McpAuthContext; // 运行时额外可枚举字段，模拟未知第三方认证器实现
      },
    };
    const { app } = setupAuth(smugglerAuthenticator, 'test');
    try {
      // 合法五字段仍然让 initialize 正常建立 session。
      const { sessionId } = await initialize(app, AUTH_FIXTURES.connection1.token);
      const session = registryOf(app).get(sessionId)!;
      // 绑定上下文必须只有五个白名单键（registry 与 server 依赖注入为同一引用，
      // 一处断言同时覆盖两者）。
      expect(session.authContext).toEqual({
        actorId: AUTH_FIXTURES.actorA.actorId,
        actorCode: AUTH_FIXTURES.actorA.actorCode,
        actorType: AUTH_FIXTURES.actorA.actorType,
        connectionId: AUTH_FIXTURES.connection1.connectionId,
        permissionProfile: AUTH_FIXTURES.actorA.permissionProfile,
      });
      expect(Object.keys(session.authContext!)).toHaveLength(5);
      // 序列化结果不得包含任一夹带值。
      const serialized = JSON.stringify(session.authContext);
      expect(serialized).not.toContain(SNEAKY_TOKEN);
      expect(serialized).not.toContain(SNEAKY_HASH);
      expect(serialized).not.toContain(SNEAKY_AUTHZ);
      expect(serialized).not.toContain(SNEAKY_SECRET);
    } finally {
      await app.close();
    }
  });

  it('production stays fail-closed without an authenticator but works with valid credentials once one is injected', async () => {
    // 未注入：503，registry 0（fail-closed，与既有匿名测试一致）。
    const anon = setupAuth(undefined as unknown as McpAuthenticator, 'production', {
      level: 'silent',
    });
    try {
      const res = await anon.app.inject({
        method: 'POST',
        url: '/mcp',
        headers: { ...BASE_HEADERS, host: '127.0.0.1' },
        payload: {
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: {
            protocolVersion: LATEST_PROTOCOL_VERSION,
            capabilities: {},
            clientInfo: { name: 'prod-anon', version: '1' },
          },
        },
      });
      expect(res.statusCode).toBe(503);
      expect(res.json().error).toBe('mcp_auth_not_configured');
      expect(registryOf(anon.app).size).toBe(0);
    } finally {
      await anon.app.close();
    }

    // 注入认证器：production 也执行认证，有效凭据可通过并使用现有只读工具。
    const { app } = setupAuth(makeAuthenticator(), 'production');
    try {
      const res = await mcpPost(app, undefined, undefined, {
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: LATEST_PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: { name: 'prod-client', version: '1' },
        },
      }, { authorization: AUTH_HEADER, host: '127.0.0.1' });
      expect(res.statusCode).toBe(200);
      expect(registryOf(app).size).toBe(1);
    } finally {
      await app.close();
    }
  });
});
