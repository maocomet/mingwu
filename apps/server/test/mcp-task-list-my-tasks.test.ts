import { describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AiActorType, AiTask, AiTaskNode } from '@mingwu/contracts';
import { AiTaskService } from '../src/application/ai-task/ai-task-service.js';
import type { AiTaskRepository } from '../src/domain/ai-task/repository.js';
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
  const client = new Client({ name: 'task-list-my-tasks-test-client', version: '0.0.1' });
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

/** 捕获 McpLogger.error 的全部日志文本，用于断言脱敏与分类记录。 */
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
    name: 'AI 任务树项目',
  });
  return project.id;
}

/** 经 task_create 创建任务并返回完整 AiTask。 */
async function createTask(
  client: Client,
  projectId: string,
  args: { task_id: string; title: string; parent_task_id?: string },
): Promise<AiTask> {
  const result = await client.callTool({
    name: 'task_create',
    arguments: { ...args, project_id: projectId },
  });
  expect(result.isError).not.toBe(true);
  return JSON.parse(firstText(result)) as AiTask;
}

/** 调用 task_list_my_tasks 并返回解析后的任务树。 */
async function listMyTasks(client: Client, projectId: string): Promise<{ tasks: AiTaskNode[] }> {
  const result = await client.callTool({
    name: 'task_list_my_tasks',
    arguments: { project_id: projectId },
  });
  expect(result.isError).not.toBe(true);
  return JSON.parse(firstText(result)) as { tasks: AiTaskNode[] };
}

describe('MCP task_list_my_tasks read-only tool', () => {
  it('is listed by tools/list; resident_ai with default profile reads own nested tree without echoing identity', async () => {
    const { server, services } = buildTestServer({
      authContext: authContextFor(AUTH_FIXTURES.actorA.actorId, 'resident_ai'),
    });
    const projectId = await seedProject(services);
    const client = await connectClient(server);
    try {
      const { tools } = await client.listTools();
      expect(tools.some((t) => t.name === 'task_list_my_tasks')).toBe(true);

      // 创建 根1[子1,子2] + 根2 三棵根下的多层结构，再整树读回。
      const root1 = await createTask(client, projectId, { task_id: uuid(), title: '根1' });
      const root2 = await createTask(client, projectId, { task_id: uuid(), title: '根2' });
      const child1 = await createTask(client, projectId, {
        task_id: uuid(),
        title: '子1',
        parent_task_id: root1.id,
      });
      const child2 = await createTask(client, projectId, {
        task_id: uuid(),
        title: '子2',
        parent_task_id: root1.id,
      });
      await createTask(client, projectId, {
        task_id: uuid(),
        title: '孙1',
        parent_task_id: child1.id,
      });
      void root2;

      const tree = await listMyTasks(client, projectId);
      expect(tree.tasks).toHaveLength(2);
      const [r1, r2] = tree.tasks as [AiTaskNode, AiTaskNode];
      // 根按 position 升序（根1 先建 position 1，根2 position 2）。
      expect(r1.id).toBe(root1.id);
      expect(r2.id).toBe(root2.id);
      // 根1 的子按 position 升序：子1（pos1）、子2（pos2）。
      expect(r1.children.map((c) => c.id)).toEqual([child1.id, child2.id]);
      // 子1 下再挂孙1。
      expect(r1.children[0]!.children).toHaveLength(1);
      expect(r1.children[0]!.children[0]!.title).toBe('孙1');
      expect(r2.children).toEqual([]);
      // 完整字段保留。
      expect(r1.ownerActorId).toBe(AUTH_FIXTURES.actorA.actorId);
      expect(r1.status).toBe('not_started');

      // 成功结果不得回显 token / connectionId / permissionProfile / 身份字段。
      const serialized = firstText(
        await client.callTool({
          name: 'task_list_my_tasks',
          arguments: { project_id: projectId },
        }),
      );
      expect(serialized).not.toContain(AUTH_FIXTURES.connection1.token);
      expect(serialized).not.toContain(AUTH_FIXTURES.connection1.connectionId);
      expect(serialized).not.toContain('permissionProfile');
      expect(serialized).not.toContain('actorCode');
    } finally {
      await client.close();
      await server.close();
    }
  });

  it('rejects anonymous / temporary_ai / reviewer / unknown profile with zero data returned', async () => {
    const services = makeServices();
    const projectId = await seedProject(services);

    // 匿名只读上下文：工具可见但读取 fail-closed 拒绝。
    const anon = buildTestServer({ services, authContext: null });
    const anonClient = await connectClient(anon.server);
    try {
      const { tools } = await anonClient.listTools();
      expect(tools.some((t) => t.name === 'task_list_my_tasks')).toBe(true);
      const denied = await anonClient.callTool({
        name: 'task_list_my_tasks',
        arguments: { project_id: projectId },
      });
      expect(denied.isError).toBe(true);
      expect(firstText(denied)).toBe('当前连接未授权读操作');
    } finally {
      await anonClient.close();
      await anon.server.close();
    }

    // temporary_ai：即使是 default 权限也拒绝读取长期个人任务树。
    const temp = buildTestServer({
      services,
      authContext: authContextFor(uuid(), 'temporary_ai'),
    });
    const tempClient = await connectClient(temp.server);
    try {
      const denied = await tempClient.callTool({
        name: 'task_list_my_tasks',
        arguments: { project_id: projectId },
      });
      expect(denied.isError).toBe(true);
      expect(firstText(denied)).toBe('当前身份无权读取任务树');
    } finally {
      await tempClient.close();
      await temp.server.close();
    }

    // reviewer 拒绝。
    const rev = buildTestServer({
      services,
      authContext: authContextFor(uuid(), 'reviewer'),
    });
    const revClient = await connectClient(rev.server);
    try {
      const denied = await revClient.callTool({
        name: 'task_list_my_tasks',
        arguments: { project_id: projectId },
      });
      expect(denied.isError).toBe(true);
      expect(firstText(denied)).toBe('当前身份无权读取任务树');
    } finally {
      await revClient.close();
      await rev.server.close();
    }

    // 未知 permissionProfile 拒绝。
    const unknownProfile = buildTestServer({
      services,
      authContext: authContextFor(uuid(), 'resident_ai', 'admin'),
    });
    const profileClient = await connectClient(unknownProfile.server);
    try {
      const denied = await profileClient.callTool({
        name: 'task_list_my_tasks',
        arguments: { project_id: projectId },
      });
      expect(denied.isError).toBe(true);
      expect(firstText(denied)).toBe('当前身份无权读取任务树');
    } finally {
      await profileClient.close();
      await unknownProfile.server.close();
    }
  });

  it('rejects smuggled identity / filter fields via the strict input schema', async () => {
    const { server, services } = buildTestServer({
      authContext: authContextFor(AUTH_FIXTURES.actorA.actorId, 'resident_ai'),
    });
    const projectId = await seedProject(services);
    const client = await connectClient(server);
    try {
      const smuggled = await client.callTool({
        name: 'task_list_my_tasks',
        arguments: {
          project_id: projectId,
          ownerActorId: '00000000-0000-4000-8000-000000000099',
          actor_id: '00000000-0000-4000-8000-000000000098',
          actorCode: 'forged-actor',
          connectionId: 'forged-connection',
          permissionProfile: 'admin',
          status: 'completed',
          bogus: 1,
        },
      });
      // 严格 schema 拒绝任何额外字段：不能通过伪造字段切换 / 探测他人任务。
      expect(smuggled.isError).toBe(true);
    } finally {
      await client.close();
      await server.close();
    }
  });

  it('returns a controlled error for an unknown project', async () => {
    const { server } = buildTestServer({
      authContext: authContextFor(AUTH_FIXTURES.actorA.actorId, 'resident_ai'),
    });
    const client = await connectClient(server);
    try {
      const result = await client.callTool({
        name: 'task_list_my_tasks',
        arguments: { project_id: uuid() },
      });
      expect(result.isError).toBe(true);
      expect(firstText(result)).toBe('项目不存在');
    } finally {
      await client.close();
      await server.close();
    }
  });

  it('isolates by actor: another actor sees its own empty tree, with no inference channel about actor A', async () => {
    const services = makeServices();
    const projectId = await seedProject(services);
    // A 创建一棵树。
    const serverA = buildTestServer({
      services,
      authContext: authContextFor(AUTH_FIXTURES.actorA.actorId, 'resident_ai'),
    });
    const clientA = await connectClient(serverA.server);
    try {
      await createTask(clientA, projectId, { task_id: uuid(), title: 'A 的根' });
    } finally {
      await clientA.close();
      await serverA.server.close();
    }

    // B 查询同一项目：成功返回自己的空树（不是错误），无法据此判断 A 是否有任务。
    const serverB = buildTestServer({
      services,
      authContext: authContextFor(AUTH_FIXTURES.actorB.actorId, 'resident_ai'),
    });
    const clientB = await connectClient(serverB.server);
    try {
      const result = await clientB.callTool({
        name: 'task_list_my_tasks',
        arguments: { project_id: projectId },
      });
      expect(result.isError).not.toBe(true);
      const tree = JSON.parse(firstText(result)) as { tasks: AiTaskNode[] };
      expect(tree.tasks).toEqual([]);
      // B 查询不存在的项目与 A 一样得到同一受控错误，错误通道不泄露任务存在性。
      const missing = await clientB.callTool({
        name: 'task_list_my_tasks',
        arguments: { project_id: uuid() },
      });
      expect(firstText(missing)).toBe('项目不存在');
    } finally {
      await clientB.close();
      await serverB.server.close();
    }
  });

  it('two connections of the same actor read the same personal tree', async () => {
    const services = makeServices();
    const projectId = await seedProject(services);
    // 连接 1（actorA）创建任务。
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
    try {
      await createTask(client1, projectId, { task_id: uuid(), title: '跨连接任务' });
    } finally {
      await client1.close();
      await server1.server.close();
    }

    // 连接 2（同一 actorA 的另一条连接）：读取到同一棵任务树。
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
      const tree = await listMyTasks(client2, projectId);
      expect(tree.tasks).toHaveLength(1);
      expect(tree.tasks[0]!.title).toBe('跨连接任务');
      expect(tree.tasks[0]!.ownerActorId).toBe(AUTH_FIXTURES.actorA.actorId);
    } finally {
      await client2.close();
      await server2.server.close();
    }
  });

  it('maps a corrupted tree to a fixed sanitized error without leaking ids, and logs the classification', async () => {
    const capture = createLogCapture();
    const services = makeServices();
    const projectId = await seedProject(services);
    // 通过仓储注入孤儿父引用脏数据（正常创建流程不可能产生）。
    const dirtyParent = uuid();
    await services.aiTaskRepository.createIfAbsent(
      makeAiTask({
        id: uuid(),
        projectId,
        ownerActorId: AUTH_FIXTURES.actorA.actorId,
        parentTaskId: dirtyParent,
      }),
    );
    const { server } = buildTestServer({
      services,
      authContext: authContextFor(AUTH_FIXTURES.actorA.actorId, 'resident_ai'),
      logger: capture.logger,
    });
    const client = await connectClient(server);
    try {
      const result = await client.callTool({
        name: 'task_list_my_tasks',
        arguments: { project_id: projectId },
      });
      expect(result.isError).toBe(true);
      const text = firstText(result);
      expect(text).toBe('任务树数据不一致');
      // 固定脱敏响应：不泄露任何任务 / 项目 / Actor ID。
      expect(text).not.toContain(dirtyParent);
      expect(text).not.toContain(projectId);
      expect(text).not.toContain(AUTH_FIXTURES.actorA.actorId);
      // 服务端日志只记录错误分类，不记录原始任务 / 项目 / Actor ID。
      const logText = capture.text();
      expect(logText).toContain('AiTaskTreeCorruptError');
      expect(logText).not.toContain(dirtyParent);
      expect(logText).not.toContain(projectId);
      expect(logText).not.toContain(AUTH_FIXTURES.actorA.actorId);
    } finally {
      await client.close();
      await server.close();
    }
  });

  it('never leaks repository-smuggled runtime fields into the final text response (whitelist projection)', async () => {
    const services = makeServices();
    const projectId = await seedProject(services);
    // 仓储对象夹带连接 / 权限 / 凭据 / 未知运行时字段（正常创建流程不可能产生）。
    const smuggled = Object.assign(
      {},
      makeAiTask({ projectId, ownerActorId: AUTH_FIXTURES.actorA.actorId, notes: ['备注1'] }),
      { connectionId: 'conn-secret', permissionProfile: 'admin', token: 'TOKEN_SECRET', bogus: 1 },
    );
    // 真实 AiTaskService + 受控假仓储：服务层白名单投影丢弃夹带字段，MCP 回调序列化的
    // 是服务返回值，最终文本响应也必须不含这些字段和测试秘密值。
    const aiTaskService = new AiTaskService(
      {
        findById: async () => null,
        listByOwner: async () => [structuredClone(smuggled)],
        createIfAbsent: async (task) => ({ task, created: true }),
        // 本测试只走只读链路，updateTaskContent / completeTask 不会被调用；占位保证接口完整。
        updateTaskContent: async () => {
          throw new Error('updateTaskContent not used in this read-side test');
        },
        completeTask: async () => {
          throw new Error('completeTask not used in this read-side test');
        },
      } satisfies AiTaskRepository,
      services.projectRepository,
      services.taskRepository,
    );
    const { server } = buildTestServer({
      services,
      aiTaskService,
      authContext: authContextFor(AUTH_FIXTURES.actorA.actorId, 'resident_ai'),
    });
    const client = await connectClient(server);
    try {
      const result = await client.callTool({
        name: 'task_list_my_tasks',
        arguments: { project_id: projectId },
      });
      expect(result.isError).not.toBe(true);
      const text = firstText(result);
      // 文本响应绝不含仓储夹带的字段 / 凭据 / 测试秘密。
      expect(text).not.toContain('conn-secret');
      expect(text).not.toContain('permissionProfile');
      expect(text).not.toContain('TOKEN_SECRET');
      expect(text).not.toContain('bogus');
      // 正常完整 18 个字段与递归 children 仍保留。
      const tree = JSON.parse(text) as { tasks: AiTaskNode[] };
      expect(tree.tasks).toHaveLength(1);
      const node = tree.tasks[0]!;
      expect(node.id).toBe(smuggled.id);
      expect(node.projectId).toBe(projectId);
      expect(node.ownerActorId).toBe(AUTH_FIXTURES.actorA.actorId);
      expect(node.title).toBe(smuggled.title);
      expect(node.notes).toEqual(['备注1']);
      expect(node.children).toEqual([]);
    } finally {
      await client.close();
      await server.close();
    }
  });

  it('sanitizes an unknown list exception: generic result, log without raw message or secret', async () => {
    const capture = createLogCapture();
    const services = makeServices();
    const throwingService = {
      listMyTaskTree: async () => {
        throw new Error('boom password=LIST_SECRET leaked');
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
        name: 'task_list_my_tasks',
        arguments: { project_id: uuid() },
      });
      expect(result.isError).toBe(true);
      expect(firstText(result)).toBe('内部错误');
      expect(firstText(result)).not.toContain('LIST_SECRET');
      const logText = capture.text();
      expect(logText).not.toContain('LIST_SECRET');
      expect(logText).not.toContain('boom');
      expect(logText).toContain('mcp tool internal error');
    } finally {
      await client.close();
      await server.close();
    }
  });
});
