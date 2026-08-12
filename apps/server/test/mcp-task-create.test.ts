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
import { makeServices, uuid } from './helpers.js';

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
  const client = new Client({ name: 'task-create-test-client', version: '0.0.1' });
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

/** 创建正式 ProjectTask，用于 project_task_id 关联校验。 */
async function seedFormalTask(
  services: Services,
  projectId: string,
): Promise<{ id: string; stageId: string }> {
  const { stage } = await services.stageService.createStage(projectId, {
    id: uuid(),
    name: '正式关卡',
  });
  const { task } = await services.taskService.createTask(projectId, stage.id, {
    id: uuid(),
    title: '正式主任务',
  });
  return { id: task.id, stageId: stage.id };
}

describe('MCP task_create write tool', () => {
  it('is listed by tools/list; resident_ai with default profile creates own AI task attributed to the bound actor', async () => {
    const { server, services } = buildTestServer({
      authContext: authContextFor(AUTH_FIXTURES.actorA.actorId, 'resident_ai'),
    });
    const projectId = await seedProject(services);
    const client = await connectClient(server);
    try {
      const { tools } = await client.listTools();
      expect(tools.some((t) => t.name === 'task_create')).toBe(true);

      const taskId = uuid();
      const result = await client.callTool({
        name: 'task_create',
        arguments: {
          task_id: taskId,
          project_id: projectId,
          title: ' 我的 AI 任务 ',
          description: ' 第一版描述 ',
        },
      });
      expect(result.isError).not.toBe(true);
      const task = JSON.parse(firstText(result)) as AiTask;
      // 归属只来自服务端认证上下文。
      expect(task.id).toBe(taskId);
      expect(task.projectId).toBe(projectId);
      expect(task.ownerActorId).toBe(AUTH_FIXTURES.actorA.actorId);
      // 规范化与服务端初始化字段。
      expect(task.title).toBe('我的 AI 任务');
      expect(task.description).toBe('第一版描述');
      expect(task.status).toBe('not_started');
      expect(task.progressPercent).toBe(0);
      expect(task.notes).toEqual([]);
      expect(task.blockerType).toBeNull();
      expect(task.blockerReason).toBeNull();
      expect(task.position).toBe(1);
      expect(task.version).toBe(1);
      expect(task.projectTaskId).toBeNull();
      expect(task.parentTaskId).toBeNull();
      expect(task.completedAt).toBeNull();
      expect(task.archivedAt).toBeNull();
      expect(typeof task.createdAt).toBe('string');
      expect(typeof task.updatedAt).toBe('string');

      // 成功结果不得回显 token / connectionId / permissionProfile。
      const serialized = firstText(result);
      expect(serialized).not.toContain(AUTH_FIXTURES.connection1.token);
      expect(serialized).not.toContain(AUTH_FIXTURES.connection1.connectionId);
      expect(serialized).not.toContain('permissionProfile');

      // 服务读回与 MCP 返回一致，且 owner 归属正确。
      const read = await services.aiTaskRepository.findById(taskId);
      expect(read).toEqual(task);
    } finally {
      await client.close();
      await server.close();
    }
  });

  it('rejects anonymous / temporary_ai / reviewer / unknown profile with zero writes', async () => {
    const services = makeServices();
    const projectId = await seedProject(services);

    // temporary_ai 在 default 权限下也拒绝创建长期 AI 私人任务。
    const temp = buildTestServer({
      services,
      authContext: authContextFor(uuid(), 'temporary_ai'),
    });
    const tempClient = await connectClient(temp.server);
    try {
      const denied = await tempClient.callTool({
        name: 'task_create',
        arguments: { task_id: uuid(), project_id: projectId, title: '临时任务' },
      });
      expect(denied.isError).toBe(true);
      expect(firstText(denied)).toBe('当前身份无权创建 AI 任务');
    } finally {
      await tempClient.close();
      await temp.server.close();
    }

    // reviewer 拒绝且零写入。
    const rev = buildTestServer({
      services,
      authContext: authContextFor(uuid(), 'reviewer'),
    });
    const revClient = await connectClient(rev.server);
    try {
      const denied = await revClient.callTool({
        name: 'task_create',
        arguments: { task_id: uuid(), project_id: projectId, title: '评审任务' },
      });
      expect(denied.isError).toBe(true);
      expect(firstText(denied)).toBe('当前身份无权创建 AI 任务');
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
        name: 'task_create',
        arguments: { task_id: uuid(), project_id: projectId, title: '管理任务' },
      });
      expect(denied.isError).toBe(true);
      expect(firstText(denied)).toBe('当前身份无权创建 AI 任务');
    } finally {
      await profileClient.close();
      await unknownProfile.server.close();
    }

    // 匿名只读上下文：工具可见但写入 fail-closed 拒绝。
    const anon = buildTestServer({ services, authContext: null });
    const anonClient = await connectClient(anon.server);
    try {
      const { tools } = await anonClient.listTools();
      expect(tools.some((t) => t.name === 'task_create')).toBe(true);
      const denied = await anonClient.callTool({
        name: 'task_create',
        arguments: { task_id: uuid(), project_id: projectId, title: '匿名任务' },
      });
      expect(denied.isError).toBe(true);
      expect(firstText(denied)).toBe('当前连接未授权写操作');
    } finally {
      await anonClient.close();
      await anon.server.close();
    }

    // 全部拒绝：没有任何任务被创建。
    expect((await services.aiTaskRepository.listByOwner(projectId, AUTH_FIXTURES.actorA.actorId)).length).toBe(0);
  });

  it('rejects smuggled identity / status / protected fields with zero writes', async () => {
    const { server, services } = buildTestServer({
      authContext: authContextFor(AUTH_FIXTURES.actorA.actorId, 'resident_ai'),
    });
    const projectId = await seedProject(services);
    const client = await connectClient(server);
    try {
      const result = await client.callTool({
        name: 'task_create',
        arguments: {
          task_id: uuid(),
          project_id: projectId,
          title: '正常标题',
          ownerActorId: '00000000-0000-4000-8000-000000000099',
          actor_id: '00000000-0000-4000-8000-000000000098',
          actorCode: 'forged-actor',
          status: 'completed',
          progressPercent: 100,
          notes: ['伪造备注'],
          position: 5,
          version: 9,
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
          completedAt: '2026-01-01T00:00:00.000Z',
          archivedAt: '2026-01-01T00:00:00.000Z',
          bogus: 1,
        },
      });
      // 严格 schema 拒绝额外字段。
      expect(result.isError).toBe(true);
      // 零写入。
      expect(
        (await services.aiTaskRepository.listByOwner(projectId, AUTH_FIXTURES.actorA.actorId))
          .length,
      ).toBe(0);
    } finally {
      await client.close();
      await server.close();
    }
  });

  it('maps invalid id, blank title, over-length description, missing project, bad projectTask, bad parent, cross-actor parent to controlled errors with zero writes', async () => {
    const { server, services } = buildTestServer({
      authContext: authContextFor(AUTH_FIXTURES.actorA.actorId, 'resident_ai'),
    });
    const projectId = await seedProject(services);
    const formal = await seedFormalTask(services, projectId);
    const client = await connectClient(server);
    try {
      // 任务 id 不是 UUID：在严格 schema 层被拒绝（服务层另有防守性检查）。
      const badId = await client.callTool({
        name: 'task_create',
        arguments: { task_id: 'not-a-uuid', project_id: projectId, title: 'X' },
      });
      expect(badId.isError).toBe(true);

      // 纯空白标题：schema 只拦超长，空标题交服务层规范化 → 受控业务错误。
      const blankTitle = await client.callTool({
        name: 'task_create',
        arguments: { task_id: uuid(), project_id: projectId, title: '   ' },
      });
      expect(blankTitle.isError).toBe(true);
      expect(firstText(blankTitle)).toBe('任务标题不合法');

      // 标题超过 code point 上限：schema refine 在入口拒绝。
      const longTitle = await client.callTool({
        name: 'task_create',
        arguments: {
          task_id: uuid(),
          project_id: projectId,
          title: '😀'.repeat(AI_TASK_TITLE_MAX_LENGTH + 1),
        },
      });
      expect(longTitle.isError).toBe(true);

      // 描述超过 code point 上限：schema refine 在入口拒绝。
      const longDesc = await client.callTool({
        name: 'task_create',
        arguments: {
          task_id: uuid(),
          project_id: projectId,
          title: 'X',
          description: '中'.repeat(AI_TASK_DESCRIPTION_MAX_LENGTH + 1),
        },
      });
      expect(longDesc.isError).toBe(true);

      // 项目不存在。
      const missingProject = await client.callTool({
        name: 'task_create',
        arguments: { task_id: uuid(), project_id: uuid(), title: 'X' },
      });
      expect(missingProject.isError).toBe(true);
      expect(firstText(missingProject)).toBe('项目不存在');

      // 关联正式任务不存在（或不属于本项目）。
      const missingFormal = await client.callTool({
        name: 'task_create',
        arguments: {
          task_id: uuid(),
          project_id: projectId,
          project_task_id: uuid(),
          title: 'X',
        },
      });
      expect(missingFormal.isError).toBe(true);
      expect(firstText(missingFormal)).toBe('关联的正式任务不合法');

      // 关联其他项目的正式任务。
      const otherProjectId = await seedProject(services);
      const otherFormal = await seedFormalTask(services, otherProjectId);
      const crossProjectFormal = await client.callTool({
        name: 'task_create',
        arguments: {
          task_id: uuid(),
          project_id: projectId,
          project_task_id: otherFormal.id,
          title: 'X',
        },
      });
      expect(crossProjectFormal.isError).toBe(true);
      expect(firstText(crossProjectFormal)).toBe('关联的正式任务不合法');

      // 父任务不存在。
      const missingParent = await client.callTool({
        name: 'task_create',
        arguments: {
          task_id: uuid(),
          project_id: projectId,
          parent_task_id: uuid(),
          title: 'X',
        },
      });
      expect(missingParent.isError).toBe(true);
      expect(firstText(missingParent)).toBe('父任务不存在');

      // trim 后恰好上限（前导 + 尾随空格 + 恰好 200 个 emoji）→ MCP 入口接受并规范化。
      const padded = await client.callTool({
        name: 'task_create',
        arguments: {
          task_id: uuid(),
          project_id: projectId,
          title: `  ${'😀'.repeat(AI_TASK_TITLE_MAX_LENGTH)}  `,
          description: ` ${'中'.repeat(AI_TASK_DESCRIPTION_MAX_LENGTH)} `,
        },
      });
      expect(padded.isError).not.toBe(true);
      const paddedTask = JSON.parse(firstText(padded)) as AiTask;
      expect(paddedTask.title).toBe('😀'.repeat(AI_TASK_TITLE_MAX_LENGTH));
      expect(paddedTask.description).toBe('中'.repeat(AI_TASK_DESCRIPTION_MAX_LENGTH));

      // 关联正式任务成功路径：project_task_id 属于本项目时允许，且不改正式进度。
      const linked = await client.callTool({
        name: 'task_create',
        arguments: {
          task_id: uuid(),
          project_id: projectId,
          project_task_id: formal.id,
          title: '关联正式任务',
        },
      });
      expect(linked.isError).not.toBe(true);
      const linkedTask = JSON.parse(firstText(linked)) as AiTask;
      expect(linkedTask.projectTaskId).toBe(formal.id);
      // AITask 创建绝不改变正式主任务 / 关卡。
      const formalTask = await services.taskRepository.findById(formal.id);
      expect(formalTask?.status).toBe('not_started');
      expect(formalTask?.version).toBe(1);
      const stage = await services.stageRepository.findById(formal.stageId);
      expect(stage?.status).toBe('not_started');
      expect(stage?.version).toBe(1);

      // 上面所有失败路径 + 2 条成功路径（padded / linked）：正式任务未动，AI 任务只有成功这两条。
      const tasks = await services.aiTaskRepository.listByOwner(
        projectId,
        AUTH_FIXTURES.actorA.actorId,
      );
      expect(tasks).toHaveLength(2);
    } finally {
      await client.close();
      await server.close();
    }
  });

  it('rejects a parent AiTask owned by a different actor (cross-actor mounting)', async () => {
    const services = makeServices();
    const projectId = await seedProject(services);
    // A 创建父任务。
    const serverA = buildTestServer({
      services,
      authContext: authContextFor(AUTH_FIXTURES.actorA.actorId, 'resident_ai'),
    });
    const clientA = await connectClient(serverA.server);
    let parentId: string;
    try {
      const created = await clientA.callTool({
        name: 'task_create',
        arguments: { task_id: uuid(), project_id: projectId, title: 'A 的父任务' },
      });
      expect(created.isError).not.toBe(true);
      parentId = (JSON.parse(firstText(created)) as AiTask).id;
    } finally {
      await clientA.close();
      await serverA.server.close();
    }

    // B 想挂在 A 的父任务下 → 拒绝。
    const serverB = buildTestServer({
      services,
      authContext: authContextFor(AUTH_FIXTURES.actorB.actorId, 'resident_ai'),
    });
    const clientB = await connectClient(serverB.server);
    try {
      const denied = await clientB.callTool({
        name: 'task_create',
        arguments: {
          task_id: uuid(),
          project_id: projectId,
          parent_task_id: parentId,
          title: 'B 的子任务',
        },
      });
      expect(denied.isError).toBe(true);
      expect(firstText(denied)).toBe('父任务必须属于同一项目和同一身份');
    } finally {
      await clientB.close();
      await serverB.server.close();
    }

    // 只成功创建了 A 的父任务；B 的请求零写入。
    expect(await services.aiTaskRepository.listByOwner(projectId, AUTH_FIXTURES.actorA.actorId)).toHaveLength(1);
    expect(await services.aiTaskRepository.listByOwner(projectId, AUTH_FIXTURES.actorB.actorId)).toHaveLength(0);
  });

  it('same task_id with same semantics retries idempotently; different semantics conflict without overwriting', async () => {
    const { server, services } = buildTestServer({
      authContext: authContextFor(AUTH_FIXTURES.actorA.actorId, 'resident_ai'),
    });
    const projectId = await seedProject(services);
    const client = await connectClient(server);
    try {
      const taskId = uuid();
      const args = { task_id: taskId, project_id: projectId, title: ' 同任务 ' };
      const first = await client.callTool({ name: 'task_create', arguments: args });
      expect(first.isError).not.toBe(true);

      // 同 id + 同项目 + 同身份 + 同规范化标题（排版差异）→ 幂等成功，返回既有任务。
      const retry = await client.callTool({
        name: 'task_create',
        arguments: { ...args, title: '同任务' },
      });
      expect(retry.isError).not.toBe(true);
      const retryTask = JSON.parse(firstText(retry)) as AiTask;
      expect(retryTask.id).toBe(taskId);
      expect(retryTask.createdAt).toBe((JSON.parse(firstText(first)) as AiTask).createdAt);
      expect(await services.aiTaskRepository.listByOwner(projectId, AUTH_FIXTURES.actorA.actorId)).toHaveLength(1);

      // 同 id 不同标题 → 受控冲突，不覆盖。
      const conflictTitle = await client.callTool({
        name: 'task_create',
        arguments: { ...args, title: '不同标题' },
      });
      expect(conflictTitle.isError).toBe(true);
      expect(firstText(conflictTitle)).toBe('任务已存在且语义冲突，不覆盖旧任务');

      // 同 id 不同描述 → 受控冲突。
      const conflictDesc = await client.callTool({
        name: 'task_create',
        arguments: { ...args, description: '加描述' },
      });
      expect(conflictDesc.isError).toBe(true);
      expect(firstText(conflictDesc)).toBe('任务已存在且语义冲突，不覆盖旧任务');

      // 同 id 不同项目 → 受控冲突。
      const otherProjectId = await seedProject(services);
      const conflictProject = await client.callTool({
        name: 'task_create',
        arguments: { ...args, project_id: otherProjectId },
      });
      expect(conflictProject.isError).toBe(true);
      expect(firstText(conflictProject)).toBe('任务已存在且语义冲突，不覆盖旧任务');

      // 同 id 不同身份 → 受控冲突（绝不覆盖他人任务）。
      const connB = buildTestServer({
        services,
        authContext: authContextFor(AUTH_FIXTURES.actorB.actorId, 'resident_ai'),
      });
      const cB = await connectClient(connB.server);
      try {
        const conflictActor = await cB.callTool({
          name: 'task_create',
          arguments: { task_id: taskId, project_id: projectId, title: '同任务' },
        });
        expect(conflictActor.isError).toBe(true);
        expect(firstText(conflictActor)).toBe('任务已存在且语义冲突，不覆盖旧任务');
      } finally {
        await cB.close();
        await connB.server.close();
      }

      // 旧任务从未被覆盖，仍只有一份。
      const tasks = await services.aiTaskRepository.listByOwner(projectId, AUTH_FIXTURES.actorA.actorId);
      expect(tasks).toHaveLength(1);
      expect(tasks[0]!.title).toBe('同任务');
    } finally {
      await client.close();
      await server.close();
    }
  });

  it('20 concurrent auto-position task_create calls all succeed with unique consecutive positions', async () => {
    const { server, services } = buildTestServer({
      authContext: authContextFor(AUTH_FIXTURES.actorA.actorId, 'resident_ai'),
    });
    const projectId = await seedProject(services);
    const client = await connectClient(server);
    try {
      const results = await Promise.all(
        Array.from({ length: 20 }, () =>
          client.callTool({
            name: 'task_create',
            arguments: { task_id: uuid(), project_id: projectId, title: 'auto' },
          }),
        ),
      );
      expect(results.every((r) => r.isError !== true)).toBe(true);
      const tasks = results.map((r) => JSON.parse(firstText(r)) as AiTask);
      const positions = tasks.map((t) => t.position).sort((a, b) => a - b);
      expect(positions).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
      expect(new Set(positions).size).toBe(20);
      expect(
        await services.aiTaskRepository.listByOwner(projectId, AUTH_FIXTURES.actorA.actorId),
      ).toHaveLength(20);
    } finally {
      await client.close();
      await server.close();
    }
  });

  it('two connections of the same actor share the same task identity; a different actor is isolated', async () => {
    const services = makeServices();
    const projectId = await seedProject(services);

    // 连接 1（actorA）创建根任务。
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
    let rootId: string;
    try {
      const created = await client1.callTool({
        name: 'task_create',
        arguments: { task_id: uuid(), project_id: projectId, title: '根任务' },
      });
      expect(created.isError).not.toBe(true);
      rootId = (JSON.parse(firstText(created)) as AiTask).id;
    } finally {
      await client1.close();
      await server1.server.close();
    }

    // 连接 2（同一 actorA，另一条连接）能把自己的子任务挂到连接 1 创建的父任务下，
    // 因为两条连接解析到同一身份（owner 相同）。这验证"同一 actor 的多条连接共享同一
    // 任务身份"：身份由服务端 Bearer 解析的 actorId 决定，与连接无关。
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
    let childId: string;
    try {
      const child = await client2.callTool({
        name: 'task_create',
        arguments: {
          task_id: uuid(),
          project_id: projectId,
          parent_task_id: rootId,
          title: '同身份的子树',
        },
      });
      expect(child.isError).not.toBe(true);
      childId = (JSON.parse(firstText(child)) as AiTask).id;
      expect((JSON.parse(firstText(child)) as AiTask).ownerActorId).toBe(
        AUTH_FIXTURES.actorA.actorId,
      );
    } finally {
      await client2.close();
      await server2.server.close();
    }

    // 不同 actor（actorB）看不见 actorA 的任何任务：B 的列表为空。
    const serverB = buildTestServer({
      services,
      authContext: authContextFor(AUTH_FIXTURES.actorB.actorId, 'resident_ai'),
    });
    const clientB = await connectClient(serverB.server);
    try {
      const denied = await clientB.callTool({
        name: 'task_create',
        arguments: {
          task_id: uuid(),
          project_id: projectId,
          parent_task_id: rootId,
          title: 'B 想挂 A 的树',
        },
      });
      expect(denied.isError).toBe(true);
      expect(firstText(denied)).toBe('父任务必须属于同一项目和同一身份');
    } finally {
      await clientB.close();
      await serverB.server.close();
    }

    // 仓储状态：actorA 有根 + 子共 2 条，actorB 零条。
    expect(await services.aiTaskRepository.listByOwner(projectId, AUTH_FIXTURES.actorA.actorId)).toHaveLength(2);
    expect(await services.aiTaskRepository.listByOwner(projectId, AUTH_FIXTURES.actorB.actorId)).toHaveLength(0);
    // 子树归属正确。
    const child = await services.aiTaskRepository.findById(childId);
    expect(child?.parentTaskId).toBe(rootId);
    expect(child?.ownerActorId).toBe(AUTH_FIXTURES.actorA.actorId);
  });

  it('sanitizes an unknown create exception: generic result, log without raw message or secret', async () => {
    const capture = createLogCapture();
    const services = makeServices();
    const throwingService = {
      create: async () => {
        throw new Error('boom password=CREATE_SECRET leaked');
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
        name: 'task_create',
        arguments: { task_id: uuid(), project_id: uuid(), title: '正文' },
      });
      expect(result.isError).toBe(true);
      expect(firstText(result)).toBe('内部错误');
      expect(firstText(result)).not.toContain('CREATE_SECRET');
      const logText = capture.text();
      expect(logText).not.toContain('CREATE_SECRET');
      expect(logText).not.toContain('boom');
      expect(logText).toContain('mcp tool internal error');
    } finally {
      await client.close();
      await server.close();
    }
  });
});
