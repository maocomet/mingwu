import { describe, expect, it } from 'vitest';
import {
  AI_TASK_DESCRIPTION_MAX_LENGTH,
  AI_TASK_TITLE_MAX_LENGTH,
  type AuthenticatedAiActorContext,
  type AiActorType,
} from '@mingwu/contracts';
import { AiTaskService } from '../src/application/ai-task/ai-task-service.js';
import { ProjectNotFoundError } from '../src/domain/project/errors.js';
import {
  AiTaskDescriptionInvalidError,
  AiTaskIdInvalidError,
  AiTaskIdempotencyConflictError,
  AiTaskParentNotFoundError,
  AiTaskProjectTaskInvalidError,
  AiTaskRequesterInvalidError,
  AiTaskScopeConflictError,
  AiTaskTitleInvalidError,
} from '../src/domain/ai-task/errors.js';
import { makeActorContext, makeServices, uuid } from './helpers.js';

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
