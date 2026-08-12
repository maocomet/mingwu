import { describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  AI_TASK_DESCRIPTION_MAX_LENGTH,
  AI_TASK_TITLE_MAX_LENGTH,
  type AiActorType,
  type AiTask,
} from '@mingwu/contracts';
import type { AiTaskService } from '../src/application/ai-task/ai-task-service.js';
import type { McpAuthContext } from '../src/domain/mcp-auth/mcp-auth-context.js';
import { buildMcpServer, type McpLogger } from '../src/mcp/mcp-server.js';
import { AUTH_FIXTURES } from './mcp-auth-fixtures.js';
import { makeAiTask, makeServices, uuid } from './helpers.js';

type Services = ReturnType<typeof makeServices>;

/** 构造受信只读 MCP 认证上下文（冻结）。permissionProfile 默认 default。 */
function authContextFor(
  actorId: string,
  actorType: AiActorType,
  permissionProfile = 'default',
  connectionId = uuid(),
): McpAuthContext {
  return Object.freeze({
    actorId,
    actorCode: 'test-actor',
    actorType,
    connectionId,
    permissionProfile,
  });
}

interface BuildOptions {
  authContext?: McpAuthContext | null;
  services?: Services;
  aiTaskService?: AiTaskService;
  logger?: McpLogger;
}

function buildTestServer(opts: BuildOptions = {}) {
  const services = opts.services ?? makeServices();
  const server = buildMcpServer({
    aiTaskService: opts.aiTaskService ?? services.aiTaskService,
    projectStatusService: services.projectStatusService,
    stageService: services.stageService,
    studySessionDetailService: services.studySessionDetailService,
    studySessionCurrentService: services.studySessionCurrentService,
    studyReportService: services.studyReportService,
    stageUpdateRequestService: services.stageUpdateRequestService,
    projectWorkReportService: services.projectWorkReportService,
    serviceName: 'mingwu-server',
    serviceVersion: '0.1.0',
    logger: opts.logger ?? { error: () => undefined },
    authContext: opts.authContext ?? null,
  });
  return { server, services };
}

/** 用官方 Client + SDK 内存 transport 建立真实协议连接（自动完成 initialize 握手）。 */
async function connectClient(server: McpServer): Promise<Client> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'task-update-test-client', version: '0.0.1' });
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

/** 捕获 McpLogger.error 的全部日志文本，用于断言未知异常脱敏。 */
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

/** 共享仓储：创建项目并返回其 id。 */
async function seedProject(services: Services): Promise<string> {
  const { project } = await services.projectService.createProject({
    id: uuid(),
    name: 'AI 任务项目',
  });
  return project.id;
}

/** 通过 task_create 工具在 actorA 名下创建一条任务，返回完整任务。 */
async function createTaskForActorA(
  client: Client,
  projectId: string,
  overrides: Record<string, unknown> = {},
): Promise<AiTask> {
  const result = await client.callTool({
    name: 'task_create',
    arguments: { task_id: uuid(), project_id: projectId, title: '原任务', ...overrides },
  });
  if (result.isError) {
    throw new Error(`seed task_create failed: ${firstText(result)}`);
  }
  return JSON.parse(firstText(result)) as AiTask;
}

describe('MCP task_update write tool', () => {
  it('resident_ai with default profile updates own title / description and returns the full bumped AiTask', async () => {
    const { server, services } = buildTestServer({
      authContext: authContextFor(AUTH_FIXTURES.actorA.actorId, 'resident_ai'),
    });
    const projectId = await seedProject(services);
    const client = await connectClient(server);
    try {
      const { tools } = await client.listTools();
      expect(tools.some((t) => t.name === 'task_update')).toBe(true);

      const task = await createTaskForActorA(client, projectId);
      const result = await client.callTool({
        name: 'task_update',
        arguments: {
          task_id: task.id,
          expected_version: 1,
          title: ' 修改后的标题 ',
          description: ' 修改后的描述 ',
        },
      });
      expect(result.isError).not.toBe(true);
      const updated = JSON.parse(firstText(result)) as AiTask;
      expect(updated.id).toBe(task.id);
      expect(updated.projectId).toBe(projectId);
      expect(updated.ownerActorId).toBe(AUTH_FIXTURES.actorA.actorId);
      expect(updated.title).toBe('修改后的标题');
      expect(updated.description).toBe('修改后的描述');
      expect(updated.version).toBe(2);
      expect(updated.status).toBe('not_started');
      expect(updated.progressPercent).toBe(0);
      expect(updated.position).toBe(task.position);
      expect(updated.createdAt).toBe(task.createdAt);
      expect(typeof updated.updatedAt).toBe('string');

      // 成功结果不得回显 token / connectionId / permissionProfile。
      const serialized = firstText(result);
      expect(serialized).not.toContain(AUTH_FIXTURES.connection1.token);
      expect(serialized).not.toContain(AUTH_FIXTURES.connection1.connectionId);
      expect(serialized).not.toContain('permissionProfile');

      // 仓储读回与返回一致（版本已推进）。
      const read = await services.aiTaskRepository.findById(task.id);
      expect(read).toEqual(updated);
      expect(read?.version).toBe(2);
    } finally {
      await client.close();
      await server.close();
    }
  });

  it('rejects anonymous / temporary_ai / reviewer / unknown profile with zero writes', async () => {
    const services = makeServices();
    const projectId = await seedProject(services);
    // 先由 actorA 的真实连接创建一条任务，供拒绝路径引用。
    const seedServer = buildTestServer({
      services,
      authContext: authContextFor(AUTH_FIXTURES.actorA.actorId, 'resident_ai'),
    });
    const seedClient = await connectClient(seedServer.server);
    let taskId: string;
    try {
      const task = await createTaskForActorA(seedClient, projectId);
      taskId = task.id;
    } finally {
      await seedClient.close();
      await seedServer.server.close();
    }

    const cases: Array<{ label: string; ctx: McpAuthContext | null; expectText: string }> = [
      { label: 'temporary_ai', ctx: authContextFor(uuid(), 'temporary_ai'), expectText: '当前身份无权修改 AI 任务' },
      { label: 'reviewer', ctx: authContextFor(uuid(), 'reviewer'), expectText: '当前身份无权修改 AI 任务' },
      { label: 'unknown profile', ctx: authContextFor(uuid(), 'resident_ai', 'admin'), expectText: '当前身份无权修改 AI 任务' },
      { label: 'anonymous', ctx: null, expectText: '当前连接未授权写操作' },
    ];
    for (const c of cases) {
      const { server: s } = buildTestServer({ services, authContext: c.ctx });
      const cl = await connectClient(s);
      try {
        const denied = await cl.callTool({
          name: 'task_update',
          arguments: { task_id: taskId, expected_version: 1, title: 'X' },
        });
        expect(denied.isError, c.label).toBe(true);
        expect(firstText(denied), c.label).toBe(c.expectText);
      } finally {
        await cl.close();
        await s.close();
      }
    }

    // 全部拒绝：任务从未被修改。
    const untouched = await services.aiTaskRepository.findById(taskId);
    expect(untouched?.title).toBe('原任务');
    expect(untouched?.version).toBe(1);
  });

  it('rejects an input with no modification field, numeric-string coercion, and smuggled fields with zero writes', async () => {
    const { server, services } = buildTestServer({
      authContext: authContextFor(AUTH_FIXTURES.actorA.actorId, 'resident_ai'),
    });
    const projectId = await seedProject(services);
    const client = await connectClient(server);
    try {
      const task = await createTaskForActorA(client, projectId);

      // 只给 task_id + expected_version，无任何修改字段。
      const none = await client.callTool({
        name: 'task_update',
        arguments: { task_id: task.id, expected_version: 1 },
      });
      expect(none.isError).toBe(true);
      expect(firstText(none)).toBe('至少提供一个修改字段');

      // expected_version 数值字符串绝不强制转换。
      const numString = await client.callTool({
        name: 'task_update',
        arguments: { task_id: task.id, expected_version: '1', title: 'X' },
      });
      expect(numString.isError).toBe(true);

      // 严格 schema：身份 / 状态 / 受保护 / 未知字段全部拒绝。
      const smuggled = await client.callTool({
        name: 'task_update',
        arguments: {
          task_id: task.id,
          expected_version: 1,
          title: 'X',
          ownerActorId: '00000000-0000-4000-8000-000000000099',
          actor_id: '00000000-0000-4000-8000-000000000098',
          actorCode: 'forged',
          status: 'completed',
          progressPercent: 100,
          notes: ['x'],
          blockerType: 'x',
          blockerReason: 'x',
          position: 5,
          version: 9,
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
          completedAt: '2026-01-01T00:00:00.000Z',
          archivedAt: '2026-01-01T00:00:00.000Z',
          bogus: 1,
        },
      });
      expect(smuggled.isError).toBe(true);

      // 零写入：任务未被修改。
      const untouched = await services.aiTaskRepository.findById(task.id);
      expect(untouched?.title).toBe('原任务');
      expect(untouched?.version).toBe(1);
    } finally {
      await client.close();
      await server.close();
    }
  });

  it('returns the SAME wording for a missing task and an other-actor task; a real actor update succeeds', async () => {
    const services = makeServices();
    const projectId = await seedProject(services);
    const serverA = buildTestServer({
      services,
      authContext: authContextFor(AUTH_FIXTURES.actorA.actorId, 'resident_ai'),
    });
    const clientA = await connectClient(serverA.server);
    let taskId: string;
    try {
      const task = await createTaskForActorA(clientA, projectId);
      taskId = task.id;

      // 不存在的任务。
      const missing = await clientA.callTool({
        name: 'task_update',
        arguments: { task_id: uuid(), expected_version: 1, title: 'X' },
      });
      expect(missing.isError).toBe(true);
      expect(firstText(missing)).toBe('任务不存在');
    } finally {
      await clientA.close();
      await serverA.server.close();
    }

    // actorB 尝试修改 actorA 的任务 → 同一受控文案，禁止跨 Actor 探测。
    const serverB = buildTestServer({
      services,
      authContext: authContextFor(AUTH_FIXTURES.actorB.actorId, 'resident_ai'),
    });
    const clientB = await connectClient(serverB.server);
    try {
      const other = await clientB.callTool({
        name: 'task_update',
        arguments: { task_id: taskId, expected_version: 1, title: '偷改' },
      });
      expect(other.isError).toBe(true);
      expect(firstText(other)).toBe('任务不存在');
    } finally {
      await clientB.close();
      await serverB.server.close();
    }

    // 两处文案一致且不含任何 ID。
    const untouched = await services.aiTaskRepository.findById(taskId);
    expect(untouched?.title).toBe('原任务');
    expect(untouched?.version).toBe(1);
  });

  it('rejects a stale expected_version with a stable conflict and maps archived / invalid / long inputs', async () => {
    const { server, services } = buildTestServer({
      authContext: authContextFor(AUTH_FIXTURES.actorA.actorId, 'resident_ai'),
    });
    const projectId = await seedProject(services);
    const client = await connectClient(server);
    try {
      const task = await createTaskForActorA(client, projectId);

      // 版本冲突：先用 version 1 推进到 2，再用陈旧版本 1 → 稳定冲突。
      const first = await client.callTool({
        name: 'task_update',
        arguments: { task_id: task.id, expected_version: 1, title: '二稿' },
      });
      expect(first.isError).not.toBe(true);
      const stale = await client.callTool({
        name: 'task_update',
        arguments: { task_id: task.id, expected_version: 1, title: '陈旧' },
      });
      expect(stale.isError).toBe(true);
      expect(firstText(stale)).toBe('任务版本已变化，请刷新后重试');
      const afterConflict = await services.aiTaskRepository.findById(task.id);
      expect(afterConflict?.title).toBe('二稿');
      expect(afterConflict?.version).toBe(2);

      // 空标题（trim 后为空白）→ 业务受控错误。
      const blankTitle = await client.callTool({
        name: 'task_update',
        arguments: { task_id: task.id, expected_version: 2, title: '   ' },
      });
      expect(blankTitle.isError).toBe(true);
      expect(firstText(blankTitle)).toBe('任务标题不合法');

      // 标题超 code point 上限 → 入口 refine 拒绝。
      const longTitle = await client.callTool({
        name: 'task_update',
        arguments: {
          task_id: task.id,
          expected_version: 2,
          title: '😀'.repeat(AI_TASK_TITLE_MAX_LENGTH + 1),
        },
      });
      expect(longTitle.isError).toBe(true);

      // 描述超 code point 上限 → 入口 refine 拒绝。
      const longDesc = await client.callTool({
        name: 'task_update',
        arguments: {
          task_id: task.id,
          expected_version: 2,
          description: '中'.repeat(AI_TASK_DESCRIPTION_MAX_LENGTH + 1),
        },
      });
      expect(longDesc.isError).toBe(true);

      // 任务 id 不是 UUID → 严格 schema 拒绝。
      const badId = await client.callTool({
        name: 'task_update',
        arguments: { task_id: 'not-a-uuid', expected_version: 1, title: 'X' },
      });
      expect(badId.isError).toBe(true);

      // 已归档任务 → 受控拒绝：直接种入一条 owner=actorA 且已归档的任务
      //（createIfAbsent 不覆盖既有 id，position 需避开既有任务）。
      const archivedTask = makeAiTask({
        projectId,
        ownerActorId: AUTH_FIXTURES.actorA.actorId,
        position: 2,
        archivedAt: new Date().toISOString(),
      });
      await services.aiTaskRepository.createIfAbsent(archivedTask);
      const archived = await client.callTool({
        name: 'task_update',
        arguments: { task_id: archivedTask.id, expected_version: 1, title: 'X' },
      });
      expect(archived.isError).toBe(true);
      expect(firstText(archived)).toBe('任务已归档，无法修改');
    } finally {
      await client.close();
      await server.close();
    }
  });

  it('no-op update returns the current task without bumping the version', async () => {
    const { server, services } = buildTestServer({
      authContext: authContextFor(AUTH_FIXTURES.actorA.actorId, 'resident_ai'),
    });
    const projectId = await seedProject(services);
    const client = await connectClient(server);
    try {
      const task = await createTaskForActorA(client, projectId, { title: '稳定标题' });
      const noop = await client.callTool({
        name: 'task_update',
        arguments: { task_id: task.id, expected_version: 1, title: ' 稳定标题 ' },
      });
      expect(noop.isError).not.toBe(true);
      const noopTask = JSON.parse(firstText(noop)) as AiTask;
      expect(noopTask.title).toBe('稳定标题');
      expect(noopTask.version).toBe(1);
      expect(noopTask.updatedAt).toBe(task.updatedAt);
    } finally {
      await client.close();
      await server.close();
    }
  });

  it('same actor can update sequentially across two connections by refreshing the version', async () => {
    const services = makeServices();
    const projectId = await seedProject(services);

    // 连接 1 创建任务并改标题到 version 2。
    const server1 = buildTestServer({
      services,
      authContext: authContextFor(
        AUTH_FIXTURES.actorA.actorId,
        'resident_ai',
        'default',
        AUTH_FIXTURES.connection1.connectionId,
      ),
    });
    const client1 = await connectClient(server1.server);
    let taskId: string;
    try {
      const task = await createTaskForActorA(client1, projectId, { title: '一稿' });
      taskId = task.id;
      const first = await client1.callTool({
        name: 'task_update',
        arguments: { task_id: task.id, expected_version: 1, title: '二稿' },
      });
      expect(first.isError).not.toBe(true);
      expect((JSON.parse(firstText(first)) as AiTask).version).toBe(2);
    } finally {
      await client1.close();
      await server1.server.close();
    }

    // 连接 2（同一 actorA，另一条连接）刷新到 version 2 后继续修改成功。
    const server2 = buildTestServer({
      services,
      authContext: authContextFor(
        AUTH_FIXTURES.actorA.actorId,
        'resident_ai',
        'default',
        AUTH_FIXTURES.connection2.connectionId,
      ),
    });
    const client2 = await connectClient(server2.server);
    try {
      const second = await client2.callTool({
        name: 'task_update',
        arguments: { task_id: taskId, expected_version: 2, description: '补充' },
      });
      expect(second.isError).not.toBe(true);
      const updated = JSON.parse(firstText(second)) as AiTask;
      expect(updated.title).toBe('二稿');
      expect(updated.description).toBe('补充');
      expect(updated.version).toBe(3);
      expect(updated.ownerActorId).toBe(AUTH_FIXTURES.actorA.actorId);
    } finally {
      await client2.close();
      await server2.server.close();
    }
  });

  it('sanitizes an unknown update exception: generic result, log without raw message or secret', async () => {
    const capture = createLogCapture();
    const services = makeServices();
    const throwingService = {
      updateOwnTask: async () => {
        throw new Error('boom password=UPDATE_SECRET leaked');
      },
    } as unknown as AiTaskService;
    const { server } = buildTestServer({
      services,
      aiTaskService: throwingService,
      authContext: authContextFor(AUTH_FIXTURES.actorA.actorId, 'resident_ai'),
      logger: capture.logger,
    });
    const client = await connectClient(server);
    try {
      const result = await client.callTool({
        name: 'task_update',
        arguments: { task_id: uuid(), expected_version: 1, title: '正文' },
      });
      expect(result.isError).toBe(true);
      expect(firstText(result)).toBe('内部错误');
      expect(firstText(result)).not.toContain('UPDATE_SECRET');
      const logText = capture.text();
      expect(logText).not.toContain('UPDATE_SECRET');
      expect(logText).not.toContain('boom');
      expect(logText).toContain('mcp tool internal error');
    } finally {
      await client.close();
      await server.close();
    }
  });
});
