import { describe, expect, it } from 'vitest';
import {
  AI_TASK_DESCRIPTION_MAX_LENGTH,
  AI_TASK_TITLE_MAX_LENGTH,
  type AiTaskNode,
  type AuthenticatedAiActorContext,
  type AiActorType,
} from '@mingwu/contracts';
import { AiTaskService, sortAiTaskSiblingLevel } from '../src/application/ai-task/ai-task-service.js';
import { ProjectNotFoundError } from '../src/domain/project/errors.js';
import {
  AiTaskArchivedError,
  AiTaskDescriptionInvalidError,
  AiTaskIdInvalidError,
  AiTaskIdempotencyConflictError,
  AiTaskNotFoundError,
  AiTaskParentNotFoundError,
  AiTaskProjectTaskInvalidError,
  AiTaskRequesterInvalidError,
  AiTaskScopeConflictError,
  AiTaskTitleInvalidError,
  AiTaskTreeCorruptError,
  AiTaskUpdateInvalidError,
  AiTaskVersionConflictError,
} from '../src/domain/ai-task/errors.js';
import type { AiTaskRepository } from '../src/domain/ai-task/repository.js';
import { makeActorContext, makeAiTask, makeServices, uuid } from './helpers.js';

const FIXED_NOW = '2026-08-12T00:00:00.000Z';

/** 共享同一组仓储；注入固定时钟以稳定断言 createdAt / updatedAt。 */
function setup() {
  const services = makeServices();
  const aiTaskService = new AiTaskService(
    services.aiTaskRepository,
    services.projectRepository,
    services.taskRepository,
    () => FIXED_NOW,
  );
  return { ...services, aiTaskService };
}

type Services = ReturnType<typeof setup>;

async function makeProjectId(services: Services): Promise<string> {
  const { project } = await services.projectService.createProject({ id: uuid(), name: 'AI 项目' });
  return project.id;
}

/**
 * 受控假仓储：只替换需要的接口，其余按安全默认实现。用于注入"越界归属" / "夹带额外
 * 字段"的读侧反例——这些脏数据无法通过正常创建流程产生，只能从仓储直接喂入服务。
 */
function stubAiTaskRepository(overrides: Partial<AiTaskRepository>): AiTaskRepository {
  const base: AiTaskRepository = {
    findById: async () => null,
    listByOwner: async () => [],
    createIfAbsent: async (task) => ({ task, created: true }),
    // 基座仓储无任何任务：任何 CAS 更新 / 完成都应冲突，测试按需 override 具体行为。
    updateTaskContent: async () => {
      throw new AiTaskVersionConflictError();
    },
    completeTask: async () => {
      throw new AiTaskVersionConflictError();
    },
  };
  return { ...base, ...overrides };
}

/** 创建正式 ProjectTask（用于 projectTaskId 关联校验），返回其任务对象。 */
async function makeFormalTask(
  services: Services,
  projectId: string,
): Promise<{ id: string; stageId: string; projectId: string }> {
  const { stage } = await services.stageService.createStage(projectId, {
    id: uuid(),
    name: '正式关卡',
  });
  const { task } = await services.taskService.createTask(projectId, stage.id, {
    id: uuid(),
    title: '正式主任务',
  });
  return { id: task.id, stageId: stage.id, projectId: task.projectId };
}

describe('AiTaskService.create', () => {
  it('creates a task whose owner comes only from the authContext and initializes server-controlled fields', async () => {
    const services = setup();
    const projectId = await makeProjectId(services);
    const actor = makeActorContext();
    const result = await services.aiTaskService.create(actor, {
      id: uuid(),
      projectId,
      title: '  我的任务  ',
      description: '  描述  ',
    });
    expect(result.created).toBe(true);
    const task = result.task;
    // 归属：owner 只来自受信上下文，任何客户端输入都没有身份字段。
    expect(task.ownerActorId).toBe(actor.actorId);
    // 规范化：首尾空白被去除。
    expect(task.title).toBe('我的任务');
    expect(task.description).toBe('描述');
    // 服务端固定初始值：status / 进度 / 备注 / 阻塞 / 版本 / 时间 / 完成 / 归档。
    expect(task.status).toBe('not_started');
    expect(task.progressPercent).toBe(0);
    expect(task.notes).toEqual([]);
    expect(task.blockerType).toBeNull();
    expect(task.blockerReason).toBeNull();
    expect(task.version).toBe(1);
    expect(task.createdAt).toBe(FIXED_NOW);
    expect(task.updatedAt).toBe(FIXED_NOW);
    expect(task.completedAt).toBeNull();
    expect(task.archivedAt).toBeNull();
    expect(task.position).toBe(1);
    expect(task.projectTaskId).toBeNull();
    expect(task.parentTaskId).toBeNull();
  });

  it('normalizes an empty description to null', async () => {
    const services = setup();
    const projectId = await makeProjectId(services);
    const created = await services.aiTaskService.create(makeActorContext(), {
      id: uuid(),
      projectId,
      title: '无描述',
      description: '   ',
    });
    expect(created.task.description).toBeNull();
  });

  it('rejects a task id that is not a UUID', async () => {
    const services = setup();
    const projectId = await makeProjectId(services);
    await expect(
      services.aiTaskService.create(makeActorContext(), {
        id: 'not-a-uuid',
        projectId,
        title: 'X',
      }),
    ).rejects.toBeInstanceOf(AiTaskIdInvalidError);
  });

  it('rejects a blank title and a title over the code point limit', async () => {
    const services = setup();
    const projectId = await makeProjectId(services);
    await expect(
      services.aiTaskService.create(makeActorContext(), { id: uuid(), projectId, title: '   ' }),
    ).rejects.toBeInstanceOf(AiTaskTitleInvalidError);
    await expect(
      services.aiTaskService.create(makeActorContext(), {
        id: uuid(),
        projectId,
        title: '😀'.repeat(AI_TASK_TITLE_MAX_LENGTH + 1),
      }),
    ).rejects.toBeInstanceOf(AiTaskTitleInvalidError);
    // 恰好上限个 code point 允许（Unicode 组合字符也按 code point 计数，不按 UTF-16 单元）。
    const exact = await services.aiTaskService.create(makeActorContext(), {
      id: uuid(),
      projectId,
      title: '😀'.repeat(AI_TASK_TITLE_MAX_LENGTH),
    });
    expect(exact.created).toBe(true);
  });

  it('accepts a padded title / description that is exactly the code point limit after trim', async () => {
    const services = setup();
    const projectId = await makeProjectId(services);
    // 前导空格 + 恰好上限个 emoji（200 code points）+ 尾随空格：trim 后为合法上限。
    const paddedTitle = `  ${'😀'.repeat(AI_TASK_TITLE_MAX_LENGTH)}  `;
    const paddedDescription = ` ${'中'.repeat(AI_TASK_DESCRIPTION_MAX_LENGTH)} `;
    const created = await services.aiTaskService.create(makeActorContext(), {
      id: uuid(),
      projectId,
      title: paddedTitle,
      description: paddedDescription,
    });
    expect(created.created).toBe(true);
    expect(created.task.title).toBe('😀'.repeat(AI_TASK_TITLE_MAX_LENGTH));
    expect(created.task.description).toBe('中'.repeat(AI_TASK_DESCRIPTION_MAX_LENGTH));
  });

  it('rejects a description over the code point limit', async () => {
    const services = setup();
    const projectId = await makeProjectId(services);
    await expect(
      services.aiTaskService.create(makeActorContext(), {
        id: uuid(),
        projectId,
        title: 'X',
        description: '中'.repeat(AI_TASK_DESCRIPTION_MAX_LENGTH + 1),
      }),
    ).rejects.toBeInstanceOf(AiTaskDescriptionInvalidError);
    // 恰好上限个 code point 允许。
    const exact = await services.aiTaskService.create(makeActorContext(), {
      id: uuid(),
      projectId,
      title: 'X',
      description: '中'.repeat(AI_TASK_DESCRIPTION_MAX_LENGTH),
    });
    expect(exact.created).toBe(true);
  });

  it('rejects an invalid requester context without writing (defensive server-side identity check)', async () => {
    const services = setup();
    const projectId = await makeProjectId(services);
    const badContexts: Array<Partial<AuthenticatedAiActorContext>> = [
      { actorId: 'not-a-uuid' },
      { actorCode: '   ' },
      { actorCode: 'a'.repeat(65) },
      { actorType: 'not-a-type' as AiActorType },
    ];
    for (const patch of badContexts) {
      const ctx = { ...makeActorContext(), ...patch };
      await expect(
        services.aiTaskService.create(ctx, { id: uuid(), projectId, title: 'X' }),
      ).rejects.toBeInstanceOf(AiTaskRequesterInvalidError);
    }
    expect(
      await services.aiTaskRepository.listByOwner(projectId, makeActorContext().actorId),
    ).toHaveLength(0);
  });

  it('rejects an unknown project', async () => {
    const services = setup();
    await expect(
      services.aiTaskService.create(makeActorContext(), { id: uuid(), projectId: uuid(), title: 'X' }),
    ).rejects.toBeInstanceOf(ProjectNotFoundError);
  });

  it('rejects a projectTaskId that is missing or belongs to another project', async () => {
    const services = setup();
    const projectId = await makeProjectId(services);
    await expect(
      services.aiTaskService.create(makeActorContext(), {
        id: uuid(),
        projectId,
        projectTaskId: uuid(),
        title: 'X',
      }),
    ).rejects.toBeInstanceOf(AiTaskProjectTaskInvalidError);

    // 跨项目关联正式任务：formal task 属于 projectB，但请求写在 projectId。
    const otherProjectId = await makeProjectId(services);
    const otherFormal = await makeFormalTask(services, otherProjectId);
    await expect(
      services.aiTaskService.create(makeActorContext(), {
        id: uuid(),
        projectId,
        projectTaskId: otherFormal.id,
        title: 'X',
      }),
    ).rejects.toBeInstanceOf(AiTaskProjectTaskInvalidError);
  });

  it('links an optional projectTaskId from the same project without changing formal progress', async () => {
    const services = setup();
    const projectId = await makeProjectId(services);
    const formal = await makeFormalTask(services, projectId);
    const actor = makeActorContext();
    const result = await services.aiTaskService.create(actor, {
      id: uuid(),
      projectId,
      projectTaskId: formal.id,
      title: '关联正式任务',
    });
    expect(result.created).toBe(true);
    expect(result.task.projectTaskId).toBe(formal.id);

    // AITask 创建绝不改变正式主任务 / 关卡：正式任务仍是 not_started / version 1。
    const formalTask = await services.taskRepository.findById(formal.id);
    expect(formalTask?.status).toBe('not_started');
    expect(formalTask?.version).toBe(1);
    const stage = await services.stageRepository.findById(formal.stageId);
    expect(stage?.status).toBe('not_started');
    expect(stage?.version).toBe(1);
  });

  it('rejects an unknown parent AiTask', async () => {
    const services = setup();
    const projectId = await makeProjectId(services);
    await expect(
      services.aiTaskService.create(makeActorContext(), {
        id: uuid(),
        projectId,
        parentTaskId: uuid(),
        title: 'X',
      }),
    ).rejects.toBeInstanceOf(AiTaskParentNotFoundError);
  });

  it('rejects a parent AiTask from another project (cross-project mounting)', async () => {
    const services = setup();
    const actor = makeActorContext();
    const projectA = await makeProjectId(services);
    const projectB = await makeProjectId(services);
    const parent = await services.aiTaskService.create(actor, {
      id: uuid(),
      projectId: projectA,
      title: '父任务',
    });
    await expect(
      services.aiTaskService.create(actor, {
        id: uuid(),
        projectId: projectB,
        parentTaskId: parent.task.id,
        title: 'X',
      }),
    ).rejects.toBeInstanceOf(AiTaskScopeConflictError);
  });

  it('rejects a parent AiTask owned by a different actor (cross-actor mounting)', async () => {
    const services = setup();
    const projectId = await makeProjectId(services);
    const actorA = makeActorContext();
    const actorB = makeActorContext();
    const parent = await services.aiTaskService.create(actorA, {
      id: uuid(),
      projectId,
      title: 'A 的父任务',
    });
    await expect(
      services.aiTaskService.create(actorB, {
        id: uuid(),
        projectId,
        parentTaskId: parent.task.id,
        title: 'B 的子任务',
      }),
    ).rejects.toBeInstanceOf(AiTaskScopeConflictError);
  });

  it('builds a parent/child tree where children of the same parent share the parent scope', async () => {
    const services = setup();
    const projectId = await makeProjectId(services);
    const actor = makeActorContext();
    const parent = await services.aiTaskService.create(actor, { id: uuid(), projectId, title: '父' });
    const child = await services.aiTaskService.create(actor, {
      id: uuid(),
      projectId,
      parentTaskId: parent.task.id,
      title: '子',
    });
    expect(child.task.parentTaskId).toBe(parent.task.id);
    // 子任务在自己的父级下从 position 1 起算。
    expect(child.task.position).toBe(1);
    // 根任务的第二个兄弟自动分配 position 2。
    const sibling = await services.aiTaskService.create(actor, { id: uuid(), projectId, title: '兄弟' });
    expect(sibling.task.position).toBe(2);
  });

  it('retries the same id with the same semantics idempotently and returns the existing task', async () => {
    const services = setup();
    const projectId = await makeProjectId(services);
    const actor = makeActorContext();
    const input = { id: uuid(), projectId, title: ' 任务 ', description: ' d ' };
    const first = await services.aiTaskService.create(actor, input);
    const second = await services.aiTaskService.create(actor, input);
    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.task.id).toBe(first.task.id);
    // 规范化后的语义相同：幂等返回既有任务，不新建。
    expect(second.task.title).toBe('任务');
    expect(second.task.createdAt).toBe(first.task.createdAt);
    expect(await services.aiTaskRepository.listByOwner(projectId, actor.actorId)).toHaveLength(1);
  });

  it('rejects reusing the same id with different semantics without overwriting', async () => {
    const services = setup();
    const projectId = await makeProjectId(services);
    const actor = makeActorContext();
    const id = uuid();
    await services.aiTaskService.create(actor, { id, projectId, title: 'A' });

    // 标题不同。
    await expect(
      services.aiTaskService.create(actor, { id, projectId, title: 'B' }),
    ).rejects.toBeInstanceOf(AiTaskIdempotencyConflictError);
    // 描述不同。
    await expect(
      services.aiTaskService.create(actor, { id, projectId, title: 'A', description: 'd' }),
    ).rejects.toBeInstanceOf(AiTaskIdempotencyConflictError);
    // 项目不同（幂等预检先于项目校验，因此是语义冲突而非 ProjectNotFound）。
    await expect(
      services.aiTaskService.create(actor, { id, projectId: uuid(), title: 'A' }),
    ).rejects.toBeInstanceOf(AiTaskIdempotencyConflictError);
    // 不同 owner（同 id 时另一身份也视为语义冲突，绝不覆盖他人任务）。
    await expect(
      services.aiTaskService.create(makeActorContext(), { id, projectId, title: 'A' }),
    ).rejects.toBeInstanceOf(AiTaskIdempotencyConflictError);

    const tasks = await services.aiTaskRepository.listByOwner(projectId, actor.actorId);
    expect(tasks).toHaveLength(1);
    expect(tasks[0]!.title).toBe('A');
  });

  it('auto-assigns unique consecutive positions when 20 tasks are created concurrently', async () => {
    const services = setup();
    const projectId = await makeProjectId(services);
    const actor = makeActorContext();
    const results = await Promise.all(
      Array.from({ length: 20 }, () =>
        services.aiTaskService.create(actor, { id: uuid(), projectId, title: 'auto' }),
      ),
    );
    expect(results.every((r) => r.created)).toBe(true);
    const positions = results.map((r) => r.task.position).sort((a, b) => a - b);
    expect(positions).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
    expect(new Set(positions).size).toBe(20);
  });

  it('isolates tasks between different actors', async () => {
    const services = setup();
    const projectId = await makeProjectId(services);
    const actorA = makeActorContext();
    const actorB = makeActorContext();
    const task = await services.aiTaskService.create(actorA, { id: uuid(), projectId, title: 'A 的任务' });
    // B 在自己的视图里看不到 A 的任务。
    expect(await services.aiTaskRepository.listByOwner(projectId, actorB.actorId)).toHaveLength(0);
    // A 的两条连接共享同一身份：同一 actorId 下都能看到同一任务（同一 owner 归属）。
    expect(await services.aiTaskRepository.listByOwner(projectId, actorA.actorId)).toHaveLength(1);
    expect((await services.aiTaskRepository.listByOwner(projectId, actorA.actorId))[0]!.id).toBe(task.task.id);
  });
});

describe('AiTaskService.listMyTaskTree', () => {
  it('returns an empty tree for a project without any tasks of the actor', async () => {
    const services = setup();
    const projectId = await makeProjectId(services);
    const { tasks } = await services.aiTaskService.listMyTaskTree(makeActorContext(), projectId);
    expect(tasks).toEqual([]);
  });

  it('returns the full nested personal tree with server-owned fields intact', async () => {
    const services = setup();
    const projectId = await makeProjectId(services);
    const actor = makeActorContext();
    const root = await services.aiTaskService.create(actor, { id: uuid(), projectId, title: '根' });
    const child = await services.aiTaskService.create(actor, {
      id: uuid(),
      projectId,
      parentTaskId: root.task.id,
      title: '子',
    });
    const grand = await services.aiTaskService.create(actor, {
      id: uuid(),
      projectId,
      parentTaskId: child.task.id,
      title: '孙',
    });
    const { tasks } = await services.aiTaskService.listMyTaskTree(actor, projectId);
    expect(tasks).toHaveLength(1);
    const node = tasks[0]!;
    expect(node.id).toBe(root.task.id);
    expect(node.children).toHaveLength(1);
    expect(node.children[0]!.id).toBe(child.task.id);
    expect(node.children[0]!.children).toHaveLength(1);
    expect(node.children[0]!.children[0]!.id).toBe(grand.task.id);
    expect(node.children[0]!.children[0]!.children).toEqual([]);
    // 完整字段（含服务端初始化字段）被保留。
    expect(node.ownerActorId).toBe(actor.actorId);
    expect(node.status).toBe('not_started');
    expect(node.progressPercent).toBe(0);
    expect(node.notes).toEqual([]);
    expect(node.version).toBe(1);
    expect(node.createdAt).toBe(FIXED_NOW);
    expect(node.updatedAt).toBe(FIXED_NOW);
  });

  it('sorts each sibling level by position ASC (roots and children)', async () => {
    const services = setup();
    const projectId = await makeProjectId(services);
    const actor = makeActorContext();
    const r1 = await services.aiTaskService.create(actor, { id: uuid(), projectId, title: 'r1' });
    const r2 = await services.aiTaskService.create(actor, { id: uuid(), projectId, title: 'r2' });
    const r3 = await services.aiTaskService.create(actor, { id: uuid(), projectId, title: 'r3' });
    const c11 = await services.aiTaskService.create(actor, {
      id: uuid(),
      projectId,
      parentTaskId: r1.task.id,
      title: 'c11',
    });
    const c12 = await services.aiTaskService.create(actor, {
      id: uuid(),
      projectId,
      parentTaskId: r1.task.id,
      title: 'c12',
    });
    const c31 = await services.aiTaskService.create(actor, {
      id: uuid(),
      projectId,
      parentTaskId: r3.task.id,
      title: 'c31',
    });
    const c32 = await services.aiTaskService.create(actor, {
      id: uuid(),
      projectId,
      parentTaskId: r3.task.id,
      title: 'c32',
    });
    const c33 = await services.aiTaskService.create(actor, {
      id: uuid(),
      projectId,
      parentTaskId: r3.task.id,
      title: 'c33',
    });
    const { tasks } = await services.aiTaskService.listMyTaskTree(actor, projectId);
    expect(tasks.map((t) => t.id)).toEqual([r1.task.id, r2.task.id, r3.task.id]);
    expect(tasks[0]!.children.map((c) => c.id)).toEqual([c11.task.id, c12.task.id]);
    expect(tasks[1]!.children).toEqual([]);
    expect(tasks[2]!.children.map((c) => c.id)).toEqual([c31.task.id, c32.task.id, c33.task.id]);
  });

  it('sorts equal-position siblings by id ASC (defensive tiebreak on the pure function)', () => {
    // 正常数据模型下 position 在同一父级唯一，该兜底分支不可通过公共 API 到达；
    // 用导出纯函数对"相同 position 按 id"的契约要求做确定性验证。
    const mk = (id: string, position: number): AiTaskNode => ({
      ...makeAiTask({ id, title: id, position }),
      children: [],
    });
    const level = [mk('b', 1), mk('a', 1), mk('c', 2), mk('d', 1)];
    const sorted = sortAiTaskSiblingLevel(level);
    expect(sorted.map((n) => n.id)).toEqual(['a', 'b', 'd', 'c']);
  });

  it('returns a deep copy: mutating the result does not pollute the repository', async () => {
    const services = setup();
    const projectId = await makeProjectId(services);
    const actor = makeActorContext();
    const root = await services.aiTaskService.create(actor, { id: uuid(), projectId, title: '根' });
    const first = await services.aiTaskService.listMyTaskTree(actor, projectId);
    // 深度篡改返回结果。
    const node = first.tasks[0]!;
    node.title = '被篡改';
    node.notes.push('伪造备注');
    node.children.push({ ...node, id: uuid(), title: '伪造子', children: [] });
    const second = await services.aiTaskService.listMyTaskTree(actor, projectId);
    expect(second.tasks).toHaveLength(1);
    expect(second.tasks[0]!.title).toBe('根');
    expect(second.tasks[0]!.notes).toEqual([]);
    expect(second.tasks[0]!.children).toEqual([]);
    const stored = await services.aiTaskRepository.findById(root.task.id);
    expect(stored?.title).toBe('根');
    expect(stored?.notes).toEqual([]);
  });

  it('rejects an invalid requester context without reading (defensive check)', async () => {
    const services = setup();
    const projectId = await makeProjectId(services);
    const badContexts: Array<Partial<AuthenticatedAiActorContext>> = [
      { actorId: 'not-a-uuid' },
      { actorCode: '   ' },
      { actorType: 'not-a-type' as AiActorType },
    ];
    for (const patch of badContexts) {
      await expect(
        services.aiTaskService.listMyTaskTree({ ...makeActorContext(), ...patch }, projectId),
      ).rejects.toBeInstanceOf(AiTaskRequesterInvalidError);
    }
  });

  it('rejects an unknown project with a controlled error', async () => {
    const services = setup();
    await expect(services.aiTaskService.listMyTaskTree(makeActorContext(), uuid())).rejects.toBeInstanceOf(
      ProjectNotFoundError,
    );
  });

  it('isolates by project: tasks in another project are not visible', async () => {
    const services = setup();
    const actor = makeActorContext();
    const projectA = await makeProjectId(services);
    const projectB = await makeProjectId(services);
    await services.aiTaskService.create(actor, { id: uuid(), projectId: projectA, title: 'A 项目任务' });
    const { tasks } = await services.aiTaskService.listMyTaskTree(actor, projectB);
    expect(tasks).toEqual([]);
  });

  it('isolates by actor: another actor sees an empty tree for the same project', async () => {
    const services = setup();
    const projectId = await makeProjectId(services);
    const actorA = makeActorContext();
    await services.aiTaskService.create(actorA, { id: uuid(), projectId, title: 'A 的任务' });
    const actorB = makeActorContext();
    const { tasks } = await services.aiTaskService.listMyTaskTree(actorB, projectId);
    expect(tasks).toEqual([]);
  });

  it('fails on an orphan parent reference (parent not in the current owner scope)', async () => {
    const services = setup();
    const projectId = await makeProjectId(services);
    const actor = makeActorContext();
    await services.aiTaskRepository.createIfAbsent(
      makeAiTask({
        id: uuid(),
        projectId,
        ownerActorId: actor.actorId,
        parentTaskId: uuid(),
      }),
    );
    await expect(services.aiTaskService.listMyTaskTree(actor, projectId)).rejects.toBeInstanceOf(
      AiTaskTreeCorruptError,
    );
  });

  it('fails on a self-referencing task', async () => {
    const services = setup();
    const projectId = await makeProjectId(services);
    const actor = makeActorContext();
    const id = uuid();
    await services.aiTaskRepository.createIfAbsent(
      makeAiTask({ id, projectId, ownerActorId: actor.actorId, parentTaskId: id }),
    );
    await expect(services.aiTaskService.listMyTaskTree(actor, projectId)).rejects.toBeInstanceOf(
      AiTaskTreeCorruptError,
    );
  });

  it('fails on a multi-node cycle without promoting orphans to roots or dropping nodes', async () => {
    const services = setup();
    const projectId = await makeProjectId(services);
    const actor = makeActorContext();
    const a = uuid();
    const b = uuid();
    const c = uuid();
    // a→b、b→c、c→a：三者互相成环，没有任何根节点。
    await services.aiTaskRepository.createIfAbsent(
      makeAiTask({ id: a, projectId, ownerActorId: actor.actorId, parentTaskId: b }),
    );
    await services.aiTaskRepository.createIfAbsent(
      makeAiTask({ id: b, projectId, ownerActorId: actor.actorId, parentTaskId: c }),
    );
    await services.aiTaskRepository.createIfAbsent(
      makeAiTask({ id: c, projectId, ownerActorId: actor.actorId, parentTaskId: a }),
    );
    await expect(services.aiTaskService.listMyTaskTree(actor, projectId)).rejects.toBeInstanceOf(
      AiTaskTreeCorruptError,
    );
  });

  it('fails on cross-scope dirty data (parent belongs to another project) with a fixed sanitized error', async () => {
    const services = setup();
    const actor = makeActorContext();
    const projectA = await makeProjectId(services);
    const projectB = await makeProjectId(services);
    // 项目 B 中有一条属于同一身份的任务，被项目 A 的任务跨项目引用为父（脏数据）。
    const crossProjectParent = makeAiTask({
      id: uuid(),
      projectId: projectB,
      ownerActorId: actor.actorId,
    });
    await services.aiTaskRepository.createIfAbsent(crossProjectParent);
    await services.aiTaskRepository.createIfAbsent(
      makeAiTask({
        id: uuid(),
        projectId: projectA,
        ownerActorId: actor.actorId,
        parentTaskId: crossProjectParent.id,
      }),
    );
    // 查询 A：子任务的父引用（跨项目）不在当前作用域内 → 树不一致。
    let error: unknown;
    try {
      await services.aiTaskService.listMyTaskTree(actor, projectA);
    } catch (err) {
      error = err;
    }
    expect(error).toBeInstanceOf(AiTaskTreeCorruptError);
    // 固定脱敏消息：不含任何任务 / 项目 / Actor ID。
    const message = (error as Error).message;
    expect(message).not.toContain(crossProjectParent.id);
    expect(message).not.toContain(projectA);
    expect(message).not.toContain(projectB);
    expect(message).not.toContain(actor.actorId);
  });

  it('fails when the repository returns a root task whose projectId is out of scope', async () => {
    const services = setup();
    const projectId = await makeProjectId(services);
    const actor = makeActorContext();
    // 受控假仓储：listByOwner 返回单条无父节点任务，其 projectId 属于另一项目（越界）。
    const outOfScope = makeAiTask({ projectId: uuid(), ownerActorId: actor.actorId });
    const aiTaskService = new AiTaskService(
      stubAiTaskRepository({
        listByOwner: async () => [structuredClone(outOfScope)],
      }),
      services.projectRepository,
      services.taskRepository,
      () => FIXED_NOW,
    );
    await expect(aiTaskService.listMyTaskTree(actor, projectId)).rejects.toBeInstanceOf(
      AiTaskTreeCorruptError,
    );
  });

  it('fails when the repository returns a root task whose ownerActorId is out of scope', async () => {
    const services = setup();
    const projectId = await makeProjectId(services);
    const actor = makeActorContext();
    // 受控假仓储：单条无父节点任务归属另一 owner（越界），即使 projectId 在当前项目内。
    const outOfScope = makeAiTask({ projectId, ownerActorId: uuid() });
    const aiTaskService = new AiTaskService(
      stubAiTaskRepository({
        listByOwner: async () => [structuredClone(outOfScope)],
      }),
      services.projectRepository,
      services.taskRepository,
      () => FIXED_NOW,
    );
    await expect(aiTaskService.listMyTaskTree(actor, projectId)).rejects.toBeInstanceOf(
      AiTaskTreeCorruptError,
    );
  });

  it('never exposes runtime extra fields smuggled by the repository into the returned tree', async () => {
    const services = setup();
    const projectId = await makeProjectId(services);
    const actor = makeActorContext();
    // 仓储对象夹带连接 / 权限 / 凭据 / 未知运行时字段（正常创建流程不可能产生）。
    const smuggled = Object.assign(
      {},
      makeAiTask({ projectId, ownerActorId: actor.actorId, notes: ['备注1'] }),
      { connectionId: 'conn-secret', permissionProfile: 'admin', token: 'TOKEN_SECRET', bogus: 1 },
    );
    const aiTaskService = new AiTaskService(
      stubAiTaskRepository({
        listByOwner: async () => [structuredClone(smuggled)],
      }),
      services.projectRepository,
      services.taskRepository,
      () => FIXED_NOW,
    );
    const { tasks } = await aiTaskService.listMyTaskTree(actor, projectId);
    expect(tasks).toHaveLength(1);
    const node = tasks[0]!;
    // 白名单投影：夹带的运行时额外字段在返回树中全部不存在。
    expect(node).not.toHaveProperty('connectionId');
    expect(node).not.toHaveProperty('permissionProfile');
    expect(node).not.toHaveProperty('token');
    expect(node).not.toHaveProperty('bogus');
    // 正常完整 18 个既定字段与递归 children 仍保留。
    expect(node.id).toBe(smuggled.id);
    expect(node.projectId).toBe(projectId);
    expect(node.ownerActorId).toBe(actor.actorId);
    expect(node.title).toBe(smuggled.title);
    expect(node.notes).toEqual(['备注1']);
    expect(node.children).toEqual([]);
  });
});

describe('AiTaskService.updateOwnTask', () => {
  /** 通过服务创建一棵单人任务（version 1），返回任务与项目。 */
  async function seedOwnTask(services: Services, actor = makeActorContext(), title = '原标题') {
    const projectId = await makeProjectId(services);
    const created = await services.aiTaskService.create(actor, {
      id: uuid(),
      projectId,
      title,
      description: '原描述',
    });
    return { projectId, task: created.task };
  }

  it('updates own title and description, bumps version and refreshes updatedAt only', async () => {
    const services = setup();
    const actor = makeActorContext();
    const { task } = await seedOwnTask(services, actor, '老标题');
    const updated = await services.aiTaskService.updateOwnTask(actor, {
      taskId: task.id,
      expectedVersion: task.version,
      title: '  新标题  ',
      description: ' 新描述 ',
    });
    // 规范化 trim；服务端推进版本与刷新时间。
    expect(updated.title).toBe('新标题');
    expect(updated.description).toBe('新描述');
    expect(updated.version).toBe(2);
    expect(updated.updatedAt).toBe(FIXED_NOW);
    // 其余字段不变（归属、位置、正式关联、备注等）。
    expect(updated.ownerActorId).toBe(actor.actorId);
    expect(updated.position).toBe(task.position);
    expect(updated.status).toBe('not_started');
    expect(updated.progressPercent).toBe(0);
    expect(updated.notes).toEqual([]);
    expect(updated.projectTaskId).toBeNull();
    expect(updated.archivedAt).toBeNull();
    expect(updated.createdAt).toBe(task.createdAt);
  });

  it('clears description via null and treats blank as null (single-field updates)', async () => {
    const services = setup();
    const actor = makeActorContext();
    const { task } = await seedOwnTask(services, actor);
    // 只改描述：null 显式清空。
    const cleared = await services.aiTaskService.updateOwnTask(actor, {
      taskId: task.id,
      expectedVersion: task.version,
      description: null,
    });
    expect(cleared.description).toBeNull();
    expect(cleared.title).toBe('原标题');
    expect(cleared.version).toBe(2);
    // 已为 null 时再空白清空是 no-op（规范化后与现有内容一致），不推进版本。
    const noopBlank = await services.aiTaskService.updateOwnTask(actor, {
      taskId: cleared.id,
      expectedVersion: 2,
      description: '   ',
    });
    expect(noopBlank.description).toBeNull();
    expect(noopBlank.version).toBe(2);
    // 把描述改成有值（version 3），再用空白清空 → null（version 4），验证空白→null 规范化。
    const valued = await services.aiTaskService.updateOwnTask(actor, {
      taskId: cleared.id,
      expectedVersion: 2,
      description: '有值描述',
    });
    expect(valued.version).toBe(3);
    const blanked = await services.aiTaskService.updateOwnTask(actor, {
      taskId: cleared.id,
      expectedVersion: 3,
      description: '   ',
    });
    expect(blanked.description).toBeNull();
    expect(blanked.version).toBe(4);
  });

  it('treats normalized-identical content as a no-op: no version / updatedAt bump', async () => {
    const services = setup();
    const actor = makeActorContext();
    const { task } = await seedOwnTask(services, actor, '固定标题');
    // 带首尾空白的相同标题，trim 后与现有内容一致 → no-op。
    const noop = await services.aiTaskService.updateOwnTask(actor, {
      taskId: task.id,
      expectedVersion: task.version,
      title: '  固定标题  ',
    });
    expect(noop.title).toBe('固定标题');
    expect(noop.version).toBe(1);
    expect(noop.updatedAt).toBe(FIXED_NOW);
  });

  it('rejects an invalid requester context without reading or writing (defensive)', async () => {
    const services = setup();
    const { task } = await seedOwnTask(services);
    await expect(
      services.aiTaskService.updateOwnTask(
        {} as AuthenticatedAiActorContext,
        { taskId: task.id, expectedVersion: 1, title: 'X' },
      ),
    ).rejects.toBeInstanceOf(AiTaskRequesterInvalidError);
  });

  it('rejects a non-UUID taskId and an input with no modification field', async () => {
    const services = setup();
    const actor = makeActorContext();
    await expect(
      services.aiTaskService.updateOwnTask(actor, {
        taskId: 'not-a-uuid',
        expectedVersion: 1,
        title: 'X',
      }),
    ).rejects.toBeInstanceOf(AiTaskIdInvalidError);
    const { task } = await seedOwnTask(services, actor);
    await expect(
      services.aiTaskService.updateOwnTask(actor, { taskId: task.id, expectedVersion: 1 }),
    ).rejects.toBeInstanceOf(AiTaskUpdateInvalidError);
  });

  it('rejects a blank title and a title over the code point limit', async () => {
    const services = setup();
    const actor = makeActorContext();
    const { task } = await seedOwnTask(services, actor);
    await expect(
      services.aiTaskService.updateOwnTask(actor, { taskId: task.id, expectedVersion: 1, title: '   ' }),
    ).rejects.toBeInstanceOf(AiTaskTitleInvalidError);
    await expect(
      services.aiTaskService.updateOwnTask(actor, {
        taskId: task.id,
        expectedVersion: 1,
        title: '😀'.repeat(AI_TASK_TITLE_MAX_LENGTH + 1),
      }),
    ).rejects.toBeInstanceOf(AiTaskTitleInvalidError);
  });

  it('rejects a description over the code point limit', async () => {
    const services = setup();
    const actor = makeActorContext();
    const { task } = await seedOwnTask(services, actor);
    await expect(
      services.aiTaskService.updateOwnTask(actor, {
        taskId: task.id,
        expectedVersion: 1,
        description: '中'.repeat(AI_TASK_DESCRIPTION_MAX_LENGTH + 1),
      }),
    ).rejects.toBeInstanceOf(AiTaskDescriptionInvalidError);
  });

  it('returns the SAME controlled not-found error for missing and other-actor tasks (no cross-actor probing)', async () => {
    const services = setup();
    const actorA = makeActorContext();
    const actorB = makeActorContext();
    const { task } = await seedOwnTask(services, actorA);
    let missingError: unknown;
    let otherError: unknown;
    try {
      await services.aiTaskService.updateOwnTask(actorA, {
        taskId: uuid(),
        expectedVersion: 1,
        title: 'X',
      });
    } catch (err) {
      missingError = err;
    }
    try {
      await services.aiTaskService.updateOwnTask(actorB, {
        taskId: task.id,
        expectedVersion: task.version,
        title: '偷改他人任务',
      });
    } catch (err) {
      otherError = err;
    }
    expect(missingError).toBeInstanceOf(AiTaskNotFoundError);
    expect(otherError).toBeInstanceOf(AiTaskNotFoundError);
    // 固定脱敏文案完全一致，且不含任务 / Actor ID。
    const msg = (e: unknown) => (e as Error).message;
    expect(msg(missingError)).toBe(msg(otherError));
    expect(msg(missingError)).not.toContain(task.id);
    expect(msg(missingError)).not.toContain(actorA.actorId);
    expect(msg(missingError)).not.toContain(actorB.actorId);
    // 任务内容未被 actorB 修改。
    const untouched = await services.aiTaskRepository.findById(task.id);
    expect(untouched?.title).toBe('原标题');
    expect(untouched?.version).toBe(1);
  });

  it('rejects an archived task', async () => {
    const services = setup();
    const actor = makeActorContext();
    const projectId = await makeProjectId(services);
    // createIfAbsent 不覆盖既有 id，直接种入一条已归档任务（新 id）。
    const archivedTask = makeAiTask({
      projectId,
      ownerActorId: actor.actorId,
      archivedAt: FIXED_NOW,
    });
    await services.aiTaskRepository.createIfAbsent(archivedTask);
    await expect(
      services.aiTaskService.updateOwnTask(actor, {
        taskId: archivedTask.id,
        expectedVersion: archivedTask.version,
        title: 'X',
      }),
    ).rejects.toBeInstanceOf(AiTaskArchivedError);
  });

  it('rejects a stale expectedVersion with a stable conflict and never overwrites', async () => {
    const services = setup();
    const actor = makeActorContext();
    const { task } = await seedOwnTask(services, actor, 'v1');
    // 推进到 version 2。
    const v2 = await services.aiTaskService.updateOwnTask(actor, {
      taskId: task.id,
      expectedVersion: 1,
      title: 'v2',
    });
    expect(v2.version).toBe(2);
    // 用陈旧版本 1 再改 → 稳定冲突，不覆盖。
    await expect(
      services.aiTaskService.updateOwnTask(actor, {
        taskId: task.id,
        expectedVersion: 1,
        title: 'stale',
      }),
    ).rejects.toBeInstanceOf(AiTaskVersionConflictError);
    expect((await services.aiTaskRepository.findById(task.id))?.title).toBe('v2');
  });

  it('allows the same actor to update sequentially across multiple connections by refreshing the version', async () => {
    const services = setup();
    const actor = makeActorContext();
    const { task } = await seedOwnTask(services, actor, '一稿');
    // 第一个"连接"以 version 1 提交。
    const first = await services.aiTaskService.updateOwnTask(actor, {
      taskId: task.id,
      expectedVersion: 1,
      title: '二稿',
    });
    expect(first.version).toBe(2);
    // 第二个"连接"刷新到 version 2 后提交成功。
    const second = await services.aiTaskService.updateOwnTask(actor, {
      taskId: first.id,
      expectedVersion: 2,
      description: '补充说明',
    });
    expect(second.version).toBe(3);
    expect(second.title).toBe('二稿');
    expect(second.description).toBe('补充说明');
  });

  it('never externalizes repository-smuggled runtime fields on the update path (whitelist projection)', async () => {
    const services = makeServices();
    const projectId = await makeProjectId(services);
    const actor = makeActorContext();
    const clean = makeAiTask({ projectId, ownerActorId: actor.actorId, title: '干净' });
    const smuggled = Object.assign({}, clean, { connectionId: 'conn-secret', token: 'TKN' });
    // findById 返回干净任务（供 no-op 判定），updateTaskContent 返回夹带 runtime 字段的任务。
    const aiTaskService = new AiTaskService(
      stubAiTaskRepository({
        findById: async () => structuredClone(clean),
        // 假仓储正确应用 changes（title → 新标题）但返回仍夹带 runtime 额外字段。
        updateTaskContent: async (input) =>
          structuredClone({
            ...smuggled,
            ...input.changes,
            version: 2,
            updatedAt: FIXED_NOW,
          }),
      }),
      services.projectRepository,
      services.taskRepository,
      () => FIXED_NOW,
    );
    const updated = await aiTaskService.updateOwnTask(actor, {
      taskId: clean.id,
      expectedVersion: 1,
      title: '新标题',
    });
    expect(updated.title).toBe('新标题');
    expect('connectionId' in updated).toBe(false);
    expect('token' in updated).toBe(false);
    // 白名单 18 个字段仍在。
    expect(updated.ownerActorId).toBe(actor.actorId);
    expect(updated.version).toBe(2);
  });

  it('never changes ProjectTask / Stage or any formal progress', async () => {
    const services = setup();
    const actor = makeActorContext();
    const projectId = await makeProjectId(services);
    const formal = await makeFormalTask(services, projectId);
    const created = await services.aiTaskService.create(actor, {
      id: uuid(),
      projectId,
      projectTaskId: formal.id,
      title: '关联正式任务',
    });
    const beforeStage = await services.stageRepository.findById(formal.stageId);
    const beforeFormal = await services.taskRepository.findById(formal.id);
    await services.aiTaskService.updateOwnTask(actor, {
      taskId: created.task.id,
      expectedVersion: 1,
      description: '改描述不动正式进度',
    });
    const afterStage = await services.stageRepository.findById(formal.stageId);
    const afterFormal = await services.taskRepository.findById(formal.id);
    expect(afterStage).toEqual(beforeStage);
    expect(afterFormal).toEqual(beforeFormal);
  });
});

describe('AiTaskService.completeOwnTask', () => {
  /** 通过服务创建一棵单人任务（version 1），返回任务与项目。 */
  async function seedOwnTask(services: Services, actor = makeActorContext(), title = '待办') {
    const projectId = await makeProjectId(services);
    const created = await services.aiTaskService.create(actor, {
      id: uuid(),
      projectId,
      title,
      description: '原描述',
    });
    return { projectId, task: created.task };
  }

  it('first completion sets completed status, 100% progress and the SAME server time', async () => {
    const services = setup();
    const actor = makeActorContext();
    const { task } = await seedOwnTask(services, actor, '第一件');
    const completed = await services.aiTaskService.completeOwnTask(actor, {
      taskId: task.id,
      expectedVersion: task.version,
    });
    // completedAt 与 updatedAt 为同一服务端时间；版本 +1；其余字段不变。
    expect(completed.status).toBe('completed');
    expect(completed.progressPercent).toBe(100);
    expect(completed.completedAt).toBe(FIXED_NOW);
    expect(completed.updatedAt).toBe(FIXED_NOW);
    expect(completed.completedAt).toBe(completed.updatedAt);
    expect(completed.version).toBe(2);
    expect(completed.title).toBe('第一件');
    expect(completed.ownerActorId).toBe(actor.actorId);
    expect(completed.position).toBe(task.position);
    expect(completed.notes).toEqual([]);
    expect(completed.archivedAt).toBeNull();
    expect(completed.createdAt).toBe(task.createdAt);
  });

  it('is a no-op when already completed and version matches: no version / time bump', async () => {
    const services = setup();
    const actor = makeActorContext();
    const { task } = await seedOwnTask(services, actor);
    const first = await services.aiTaskService.completeOwnTask(actor, {
      taskId: task.id,
      expectedVersion: 1,
    });
    expect(first.version).toBe(2);
    // 已完成 + 版本一致 → no-op：直接返回当前任务，不推进版本 / 时间。
    const again = await services.aiTaskService.completeOwnTask(actor, {
      taskId: task.id,
      expectedVersion: 2,
    });
    expect(again.status).toBe('completed');
    expect(again.version).toBe(2);
    expect(again.updatedAt).toBe(FIXED_NOW);
    expect(again.completedAt).toBe(FIXED_NOW);
    // 仓储真实状态也未再次变更。
    const stored = await services.aiTaskRepository.findById(task.id);
    expect(stored?.version).toBe(2);
  });

  it('conflicts FIRST on a stale version even when the task is already completed', async () => {
    const services = setup();
    const actor = makeActorContext();
    const { task } = await seedOwnTask(services, actor);
    await services.aiTaskService.completeOwnTask(actor, {
      taskId: task.id,
      expectedVersion: 1,
    });
    // 已完成 + 陈旧版本 → 稳定冲突（陈旧版本先于 no-op 判定）。
    await expect(
      services.aiTaskService.completeOwnTask(actor, {
        taskId: task.id,
        expectedVersion: 1,
      }),
    ).rejects.toBeInstanceOf(AiTaskVersionConflictError);
    expect((await services.aiTaskRepository.findById(task.id))?.version).toBe(2);
  });

  it('rejects a stale expectedVersion on a fresh task and never overwrites', async () => {
    const services = setup();
    const actor = makeActorContext();
    const { task } = await seedOwnTask(services, actor);
    // 任务当前 version 为 1，用陈旧版本… 先推进一次再用旧版本重试。
    await services.aiTaskService.completeOwnTask(actor, {
      taskId: task.id,
      expectedVersion: 1,
    });
    await expect(
      services.aiTaskService.completeOwnTask(actor, {
        taskId: task.id,
        expectedVersion: 1,
      }),
    ).rejects.toBeInstanceOf(AiTaskVersionConflictError);
    const stored = await services.aiTaskRepository.findById(task.id);
    expect(stored?.status).toBe('completed');
    expect(stored?.version).toBe(2);
  });

  it('rejects an invalid requester context and a non-UUID taskId', async () => {
    const services = setup();
    const { task } = await seedOwnTask(services);
    await expect(
      services.aiTaskService.completeOwnTask(
        {} as AuthenticatedAiActorContext,
        { taskId: task.id, expectedVersion: 1 },
      ),
    ).rejects.toBeInstanceOf(AiTaskRequesterInvalidError);
    const actor = makeActorContext();
    await expect(
      services.aiTaskService.completeOwnTask(actor, {
        taskId: 'not-a-uuid',
        expectedVersion: 1,
      }),
    ).rejects.toBeInstanceOf(AiTaskIdInvalidError);
  });

  it('returns the SAME controlled not-found error for missing and other-actor tasks (no cross-actor probing)', async () => {
    const services = setup();
    const actorA = makeActorContext();
    const actorB = makeActorContext();
    const { task } = await seedOwnTask(services, actorA);
    let missingError: unknown;
    let otherError: unknown;
    try {
      await services.aiTaskService.completeOwnTask(actorA, {
        taskId: uuid(),
        expectedVersion: 1,
      });
    } catch (err) {
      missingError = err;
    }
    try {
      await services.aiTaskService.completeOwnTask(actorB, {
        taskId: task.id,
        expectedVersion: task.version,
      });
    } catch (err) {
      otherError = err;
    }
    expect(missingError).toBeInstanceOf(AiTaskNotFoundError);
    expect(otherError).toBeInstanceOf(AiTaskNotFoundError);
    // 固定脱敏文案完全一致，且不含任务 / Actor ID。
    const msg = (e: unknown) => (e as Error).message;
    expect(msg(missingError)).toBe(msg(otherError));
    expect(msg(missingError)).not.toContain(task.id);
    expect(msg(missingError)).not.toContain(actorA.actorId);
    expect(msg(missingError)).not.toContain(actorB.actorId);
    // 他人任务未被完成。
    const untouched = await services.aiTaskRepository.findById(task.id);
    expect(untouched?.status).toBe('not_started');
    expect(untouched?.version).toBe(1);
  });

  it('rejects an archived task', async () => {
    const services = setup();
    const actor = makeActorContext();
    const projectId = await makeProjectId(services);
    // createIfAbsent 不覆盖既有 id，直接种入一条已归档任务（新 id）。
    const archivedTask = makeAiTask({
      projectId,
      ownerActorId: actor.actorId,
      archivedAt: FIXED_NOW,
    });
    await services.aiTaskRepository.createIfAbsent(archivedTask);
    await expect(
      services.aiTaskService.completeOwnTask(actor, {
        taskId: archivedTask.id,
        expectedVersion: archivedTask.version,
      }),
    ).rejects.toBeInstanceOf(AiTaskArchivedError);
    expect((await services.aiTaskRepository.findById(archivedTask.id))?.status).toBe('not_started');
  });

  it('allows the same actor to complete sequentially across multiple connections by refreshing the version', async () => {
    const services = setup();
    const actor = makeActorContext();
    const { task } = await seedOwnTask(services, actor, '多连接');
    // 第一个"连接"以 version 1 完成。
    const first = await services.aiTaskService.completeOwnTask(actor, {
      taskId: task.id,
      expectedVersion: 1,
    });
    expect(first.version).toBe(2);
    // 第二个"连接"刷新到 version 2 后重试 → no-op，不推进版本。
    const second = await services.aiTaskService.completeOwnTask(actor, {
      taskId: first.id,
      expectedVersion: 2,
    });
    expect(second.version).toBe(2);
    expect(second.status).toBe('completed');
  });

  it('exactly one of 20 concurrent completeOwnTask calls wins on the same version', async () => {
    const services = setup();
    const actor = makeActorContext();
    const { task } = await seedOwnTask(services, actor, '并发完成');
    const results = await Promise.all(
      Array.from({ length: 20 }, () =>
        services.aiTaskService
          .completeOwnTask(actor, { taskId: task.id, expectedVersion: 1 })
          .then(() => 'succeeded')
          .catch((e) => (e instanceof AiTaskVersionConflictError ? 'conflict' : 'other')),
      ),
    );
    expect(results.filter((r) => r === 'succeeded')).toHaveLength(1);
    expect(results.filter((r) => r === 'conflict')).toHaveLength(19);
    const finalTask = await services.aiTaskRepository.findById(task.id);
    expect(finalTask?.status).toBe('completed');
    expect(finalTask?.version).toBe(2);
  });

  it('never externalizes repository-smuggled runtime fields on the complete path (whitelist projection)', async () => {
    const services = makeServices();
    const projectId = await makeProjectId(services);
    const actor = makeActorContext();
    const clean = makeAiTask({ projectId, ownerActorId: actor.actorId, title: '干净' });
    const smuggled = Object.assign({}, clean, { connectionId: 'conn-secret', token: 'TKN' });
    const aiTaskService = new AiTaskService(
      stubAiTaskRepository({
        findById: async () => structuredClone(clean),
        // 假仓储正确落账完成状态但返回仍夹带 runtime 额外字段。
        completeTask: async (input) =>
          structuredClone({
            ...smuggled,
            status: 'completed',
            progressPercent: 100,
            completedAt: input.completedAt,
            updatedAt: input.completedAt,
            version: 2,
          }),
      }),
      services.projectRepository,
      services.taskRepository,
      () => FIXED_NOW,
    );
    const completed = await aiTaskService.completeOwnTask(actor, {
      taskId: clean.id,
      expectedVersion: 1,
    });
    expect(completed.status).toBe('completed');
    expect('connectionId' in completed).toBe(false);
    expect('token' in completed).toBe(false);
    // 白名单 18 个字段仍在。
    expect(completed.ownerActorId).toBe(actor.actorId);
    expect(completed.version).toBe(2);
  });

  it('leaves ProjectTask / Stage / project status / map progress untouched and creates NO StageUpdateRequest', async () => {
    const services = setup();
    const actor = makeActorContext();
    const projectId = await makeProjectId(services);
    const formal = await makeFormalTask(services, projectId);
    // 项目状态聚合（关卡 + 正式任务进度）在完成前采样。
    const beforeProject = await services.projectStatusService.getStatus(projectId);
    const beforeStage = await services.stageRepository.findById(formal.stageId);
    const beforeFormal = await services.taskRepository.findById(formal.id);
    const beforeRequests = await services.stageUpdateRequestRepository.listByStage(formal.stageId);
    // 创建并完成一条关联正式任务的 AI 私人任务。
    const created = await services.aiTaskService.create(actor, {
      id: uuid(),
      projectId,
      projectTaskId: formal.id,
      title: '要完成的任务',
    });
    await services.aiTaskService.completeOwnTask(actor, {
      taskId: created.task.id,
      expectedVersion: 1,
    });
    // AI 私人任务确实完成了。
    expect((await services.aiTaskRepository.findById(created.task.id))?.status).toBe('completed');
    // 正式进度 / 关卡 / 项目聚合完全不变。
    const afterProject = await services.projectStatusService.getStatus(projectId);
    const afterStage = await services.stageRepository.findById(formal.stageId);
    const afterFormal = await services.taskRepository.findById(formal.id);
    const afterRequests = await services.stageUpdateRequestRepository.listByStage(formal.stageId);
    expect(afterProject).toEqual(beforeProject);
    expect(afterStage).toEqual(beforeStage);
    expect(afterFormal).toEqual(beforeFormal);
    expect(afterRequests).toEqual(beforeRequests);
  });
});
