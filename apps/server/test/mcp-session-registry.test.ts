import { describe, expect, it } from 'vitest';
import { McpSessionRegistry } from '../src/mcp/mcp-sessions.js';
import type { McpAuthContext } from '../src/domain/mcp-auth/mcp-auth-context.js';
import { AUTH_FIXTURES } from './mcp-auth-fixtures.js';
import { makeServices } from './helpers.js';

/**
 * 返修 1 验证：绑定身份必须注入到该连接自己的 MCP Server，而不是只存进 registry。
 * McpSessionRegistry.prepare 为每个连接新建独立 server，并把本次绑定的只读
 * AuthContext 注入该 server 的依赖（身份是 server 实例私有，不进共享全局）。
 * 这里直接观察 prepare 返回的 session：server 实例互不相同、各自持有注入的上下文、
 * 互不串线；匿名只读模式为 null。
 */
describe('McpSessionRegistry per-server private identity', () => {
  function makeRegistry(): McpSessionRegistry {
    const services = makeServices();
    return new McpSessionRegistry({
      projectStatusService: services.projectStatusService,
      stageService: services.stageService,
      studySessionDetailService: services.studySessionDetailService,
      studySessionCurrentService: services.studySessionCurrentService,
      studyReportService: services.studyReportService,
      stageUpdateRequestService: services.stageUpdateRequestService,
      serviceName: 'test-registry',
      serviceVersion: '0.1.0',
      logger: { error: () => undefined },
    });
  }

  function frozenContext(connectionId: string): McpAuthContext {
    return Object.freeze({
      actorId: AUTH_FIXTURES.actorA.actorId,
      actorCode: AUTH_FIXTURES.actorA.actorCode,
      actorType: AUTH_FIXTURES.actorA.actorType,
      connectionId,
      permissionProfile: AUTH_FIXTURES.actorA.permissionProfile,
    });
  }

  it('prepare builds an independent server per connection, each holding its own bound authContext', () => {
    const registry = makeRegistry();
    const ctx1 = frozenContext(AUTH_FIXTURES.connection1.connectionId);
    const ctx2 = frozenContext(AUTH_FIXTURES.connection2.connectionId);
    const a = registry.prepare(ctx1);
    const b = registry.prepare(ctx2);

    // 两个连接必然得到两个独立的 server 实例：身份不放在共享可变全局变量里。
    expect(a.server).not.toBe(b.server);
    expect(a.transport).not.toBe(b.transport);
    expect(a.sessionId).not.toBe(b.sessionId);

    // 每个 session 各自持有注入的只读绑定上下文，互不串线。
    expect(a.authContext).toBe(ctx1);
    expect(b.authContext).toBe(ctx2);
    expect(a.authContext).not.toBe(b.authContext);
    expect(a.authContext!.connectionId).toBe(AUTH_FIXTURES.connection1.connectionId);
    expect(b.authContext!.connectionId).toBe(AUTH_FIXTURES.connection2.connectionId);

    // 匿名只读模式绑定 null。
    const anon = registry.prepare(null);
    expect(anon.authContext).toBeNull();
  });
});
