import { describe, expect, it } from 'vitest';
import type { ProjectService } from '../src/application/project/project-service.js';
import type { StageService } from '../src/application/stage/stage-service.js';
import { ProjectNotFoundError } from '../src/domain/project/errors.js';
import { StageNotFoundError } from '../src/domain/stage/errors.js';
import {
  ProjectTaskIdempotencyConflictError,
  ProjectTaskNotFoundError,
  ProjectTaskParentNotFoundError,
  ProjectTaskPositionConflictError,
  ProjectTaskScopeConflictError,
  ProjectTaskTreeCorruptionError,
} from '../src/domain/project-task/errors.js';
import { makeServices, makeTask, uuid } from './helpers.js';

async function makeProject(projectService: ProjectService): Promise<string> {
  const { project } = await projectService.createProject({ id: uuid(), name: 'Proj' });
  return project.id;
}

async function makeStage(
  projectService: ProjectService,
  stageService: StageService,
  projectId: string,
): Promise<string> {
  const { stage } = await stageService.createStage(projectId, { id: uuid(), name: '第一关' });
  return stage.id;
}

describe('ProjectTaskService', () => {
  it('creates a main task with default not_started status and version 1', async () => {
    const { projectService, stageService, taskService } = makeServices();
    const projectId = await makeProject(projectService);
    const stageId = await makeStage(projectService, stageService, projectId);
    const result = await taskService.createTask(projectId, stageId, {
      id: uuid(),
      title: '主任务',
    });
    expect(result.created).toBe(true);
    expect(result.task.status).toBe('not_started');
    expect(result.task.version).toBe(1);
    expect(result.task.position).toBe(1);
    expect(result.task.parentTaskId).toBeNull();
    expect(result.task.stageId).toBe(stageId);
  });

  it('auto-assigns increasing positions among siblings', async () => {
    const { projectService, stageService, taskService } = makeServices();
    const projectId = await makeProject(projectService);
    const stageId = await makeStage(projectService, stageService, projectId);
    const a = await taskService.createTask(projectId, stageId, { id: uuid(), title: 'A' });
    const b = await taskService.createTask(projectId, stageId, { id: uuid(), title: 'B' });
    const c = await taskService.createTask(projectId, stageId, { id: uuid(), title: 'C' });
    expect([a.task.position, b.task.position, c.task.position]).toEqual([1, 2, 3]);
  });

  it('honours an explicitly provided position', async () => {
    const { projectService, stageService, taskService } = makeServices();
    const projectId = await makeProject(projectService);
    const stageId = await makeStage(projectService, stageService, projectId);
    const result = await taskService.createTask(projectId, stageId, {
      id: uuid(),
      title: 'B',
      position: 8,
    });
    expect(result.task.position).toBe(8);
  });

  it('creates a sub-task under a parent task', async () => {
    const { projectService, stageService, taskService } = makeServices();
    const projectId = await makeProject(projectService);
    const stageId = await makeStage(projectService, stageService, projectId);
    const parent = await taskService.createTask(projectId, stageId, {
      id: uuid(),
      title: '父任务',
    });
    const child = await taskService.createTask(projectId, stageId, {
      id: uuid(),
      title: '分任务',
      parentTaskId: parent.task.id,
    });
    expect(child.task.parentTaskId).toBe(parent.task.id);
    expect(child.task.position).toBe(1);
  });

  it('rejects creating a task under an unknown stage', async () => {
    const { projectService, taskService } = makeServices();
    const projectId = await makeProject(projectService);
    await expect(
      taskService.createTask(projectId, uuid(), { id: uuid(), title: 'X' }),
    ).rejects.toBeInstanceOf(StageNotFoundError);
  });

  it('rejects a stage belonging to another project', async () => {
    const { projectService, stageService, taskService } = makeServices();
    const projectA = await makeProject(projectService);
    const stageInA = await makeStage(projectService, stageService, projectA);
    const projectB = await makeProject(projectService);
    await expect(
      taskService.createTask(projectB, stageInA, { id: uuid(), title: 'X' }),
    ).rejects.toBeInstanceOf(ProjectTaskScopeConflictError);
  });

  it('rejects an unknown parent task', async () => {
    const { projectService, stageService, taskService } = makeServices();
    const projectId = await makeProject(projectService);
    const stageId = await makeStage(projectService, stageService, projectId);
    await expect(
      taskService.createTask(projectId, stageId, {
        id: uuid(),
        title: 'X',
        parentTaskId: uuid(),
      }),
    ).rejects.toBeInstanceOf(ProjectTaskParentNotFoundError);
  });

  it('rejects a parent task in a different stage (cross-stage mounting)', async () => {
    const { projectService, stageService, taskService } = makeServices();
    const projectId = await makeProject(projectService);
    const stageA = await makeStage(projectService, stageService, projectId);
    const stageB = await makeStage(projectService, stageService, projectId);
    const parent = await taskService.createTask(projectId, stageA, {
      id: uuid(),
      title: '父任务',
    });
    await expect(
      taskService.createTask(projectId, stageB, {
        id: uuid(),
        title: 'X',
        parentTaskId: parent.task.id,
      }),
    ).rejects.toBeInstanceOf(ProjectTaskScopeConflictError);
  });

  it('rejects a parent task in a different project (cross-project mounting)', async () => {
    const { projectService, stageService, taskService } = makeServices();
    const projectA = await makeProject(projectService);
    const stageA = await makeStage(projectService, stageService, projectA);
    const projectB = await makeProject(projectService);
    const stageB = await makeStage(projectService, stageService, projectB);
    const parent = await taskService.createTask(projectA, stageA, {
      id: uuid(),
      title: '父任务',
    });
    await expect(
      taskService.createTask(projectB, stageB, {
        id: uuid(),
        title: 'X',
        parentTaskId: parent.task.id,
      }),
    ).rejects.toBeInstanceOf(ProjectTaskScopeConflictError);
  });

  it('treats a retry with the same id and content as idempotent', async () => {
    const { projectService, stageService, taskService } = makeServices();
    const projectId = await makeProject(projectService);
    const stageId = await makeStage(projectService, stageService, projectId);
    const input = { id: uuid(), title: '任务', description: 'd' };
    const first = await taskService.createTask(projectId, stageId, input);
    const second = await taskService.createTask(projectId, stageId, input);
    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.task.id).toBe(first.task.id);
    expect(second.task.title).toBe('任务');
    expect(second.task.position).toBe(first.task.position);
  });

  it('treats an auto-position retry as idempotent even though the recomputed position differs', async () => {
    const { projectService, stageService, taskService } = makeServices();
    const projectId = await makeProject(projectService);
    const stageId = await makeStage(projectService, stageService, projectId);
    const input = { id: uuid(), title: '任务' };
    const first = await taskService.createTask(projectId, stageId, input);
    const second = await taskService.createTask(projectId, stageId, input);
    expect(second.created).toBe(false);
    expect(second.task.position).toBe(first.task.position);
  });

  it('rejects reusing the same id with different content', async () => {
    const { projectService, stageService, taskService } = makeServices();
    const projectId = await makeProject(projectService);
    const stageId = await makeStage(projectService, stageService, projectId);
    const id = uuid();
    await taskService.createTask(projectId, stageId, { id, title: 'A' });
    await expect(
      taskService.createTask(projectId, stageId, { id, title: 'B' }),
    ).rejects.toBeInstanceOf(ProjectTaskIdempotencyConflictError);
  });

  it('rejects an explicit position already taken by a sibling', async () => {
    const { projectService, stageService, taskService } = makeServices();
    const projectId = await makeProject(projectService);
    const stageId = await makeStage(projectService, stageService, projectId);
    const parent = await taskService.createTask(projectId, stageId, {
      id: uuid(),
      title: '父',
      position: 1,
    });
    await taskService.createTask(projectId, stageId, {
      id: uuid(),
      title: '子A',
      parentTaskId: parent.task.id,
      position: 1,
    });
    await expect(
      taskService.createTask(projectId, stageId, {
        id: uuid(),
        title: '子B',
        parentTaskId: parent.task.id,
        position: 1,
      }),
    ).rejects.toBeInstanceOf(ProjectTaskPositionConflictError);
  });

  it('auto-assigns unique consecutive positions when 20 root tasks are created concurrently', async () => {
    const { projectService, stageService, taskService } = makeServices();
    const projectId = await makeProject(projectService);
    const stageId = await makeStage(projectService, stageService, projectId);
    const results = await Promise.all(
      Array.from({ length: 20 }, () =>
        taskService.createTask(projectId, stageId, { id: uuid(), title: 'auto' }),
      ),
    );
    expect(results.every((r) => r.created)).toBe(true);
    const positions = results.map((r) => r.task.position).sort((a, b) => a - b);
    expect(positions).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
    expect(new Set(positions).size).toBe(20);
  });

  it('gets a task by id', async () => {
    const { projectService, stageService, taskService } = makeServices();
    const projectId = await makeProject(projectService);
    const stageId = await makeStage(projectService, stageService, projectId);
    const created = await taskService.createTask(projectId, stageId, { id: uuid(), title: '任务' });
    const task = await taskService.getTask(created.task.id);
    expect(task.title).toBe('任务');
  });

  it('throws ProjectTaskNotFoundError for an unknown task', async () => {
    const { taskService } = makeServices();
    await expect(taskService.getTask(uuid())).rejects.toBeInstanceOf(ProjectTaskNotFoundError);
  });

  it('throws ProjectNotFoundError for an unknown project in the progress tree', async () => {
    const { taskService } = makeServices();
    await expect(taskService.getProgressTree(uuid())).rejects.toBeInstanceOf(
      ProjectNotFoundError,
    );
  });

  it('returns an empty stage list for a project with no stages', async () => {
    const { projectService, taskService } = makeServices();
    const projectId = await makeProject(projectService);
    const tree = await taskService.getProgressTree(projectId);
    expect(tree.project.id).toBe(projectId);
    expect(tree.stages).toEqual([]);
  });

  it('returns an empty task list for a stage with no tasks', async () => {
    const { projectService, stageService, taskService } = makeServices();
    const projectId = await makeProject(projectService);
    const stageId = await makeStage(projectService, stageService, projectId);
    const tree = await taskService.getProgressTree(projectId);
    const stage = tree.stages[0]!;
    expect(stage.id).toBe(stageId);
    expect(stage.tasks).toEqual([]);
  });

  it('builds a task tree with recursive children sorted by position', async () => {
    const { projectService, stageService, taskService } = makeServices();
    const projectId = await makeProject(projectService);
    const stageId = await makeStage(projectService, stageService, projectId);

    // 主任务：B(1) A(2) 故意乱序创建，验证树按 position 排序
    const taskB = await taskService.createTask(projectId, stageId, { id: uuid(), title: 'B', position: 1 });
    const taskA = await taskService.createTask(projectId, stageId, { id: uuid(), title: 'A', position: 2 });
    // B 的分任务：child2(2) child1(1)，乱序创建
    const child2 = await taskService.createTask(projectId, stageId, {
      id: uuid(),
      title: 'child2',
      parentTaskId: taskB.task.id,
      position: 2,
    });
    await taskService.createTask(projectId, stageId, {
      id: uuid(),
      title: 'child1',
      parentTaskId: taskB.task.id,
      position: 1,
    });
    // child2 的孙任务
    await taskService.createTask(projectId, stageId, {
      id: uuid(),
      title: 'grand',
      parentTaskId: child2.task.id,
    });

    const tree = await taskService.getProgressTree(projectId);
    const stage = tree.stages[0]!;
    expect(stage.tasks.map((t) => t.title)).toEqual(['B', 'A']);

    const [b] = stage.tasks;
    expect(b!.children.map((t) => t.title)).toEqual(['child1', 'child2']);

    const [, secondChild] = b!.children;
    expect(secondChild!.children.map((t) => t.title)).toEqual(['grand']);
  });

  it('sorts stages by position and keeps tasks per stage independent', async () => {
    const { projectService, stageService, taskService } = makeServices();
    const projectId = await makeProject(projectService);
    const stageB = await stageService.createStage(projectId, { id: uuid(), name: '关卡B', position: 2 });
    const stageA = await stageService.createStage(projectId, { id: uuid(), name: '关卡A', position: 1 });
    await taskService.createTask(projectId, stageA.stage.id, { id: uuid(), title: 'A1' });
    await taskService.createTask(projectId, stageB.stage.id, { id: uuid(), title: 'B1' });

    const tree = await taskService.getProgressTree(projectId);
    expect(tree.stages.map((s) => s.name)).toEqual(['关卡A', '关卡B']);
    expect(tree.stages[0]!.tasks.map((t) => t.title)).toEqual(['A1']);
    expect(tree.stages[1]!.tasks.map((t) => t.title)).toEqual(['B1']);
  });

  it('throws ProjectTaskTreeCorruptionError for an orphan parent reference', async () => {
    const { projectService, stageService, taskRepository, taskService } = makeServices();
    const projectId = await makeProject(projectService);
    const stageId = await makeStage(projectService, stageService, projectId);
    await taskRepository.createIfAbsent(
      makeTask({ projectId, stageId, parentTaskId: uuid(), title: '孤儿分任务' }),
    );
    const err = await taskService.getProgressTree(projectId).then(
      () => null,
      (e) => e,
    );
    expect(err).toBeInstanceOf(ProjectTaskTreeCorruptionError);
    expect((err as ProjectTaskTreeCorruptionError).reason).toBe('orphan_parent');
  });

  it('throws ProjectTaskTreeCorruptionError for a self-referencing task', async () => {
    const { projectService, stageService, taskRepository, taskService } = makeServices();
    const projectId = await makeProject(projectService);
    const stageId = await makeStage(projectService, stageService, projectId);
    const id = uuid();
    await taskRepository.createIfAbsent(
      makeTask({ id, projectId, stageId, parentTaskId: id, title: '自指任务' }),
    );
    const err = await taskService.getProgressTree(projectId).then(
      () => null,
      (e) => e,
    );
    expect(err).toBeInstanceOf(ProjectTaskTreeCorruptionError);
    expect((err as ProjectTaskTreeCorruptionError).reason).toBe('self_reference');
  });

  it('throws ProjectTaskTreeCorruptionError for a two-node parent cycle', async () => {
    const { projectService, stageService, taskRepository, taskService } = makeServices();
    const projectId = await makeProject(projectService);
    const stageId = await makeStage(projectService, stageService, projectId);
    const a = uuid();
    const b = uuid();
    await taskRepository.createIfAbsent(
      makeTask({ id: a, projectId, stageId, parentTaskId: b, title: 'A' }),
    );
    await taskRepository.createIfAbsent(
      makeTask({ id: b, projectId, stageId, parentTaskId: a, title: 'B' }),
    );
    const err = await taskService.getProgressTree(projectId).then(
      () => null,
      (e) => e,
    );
    expect(err).toBeInstanceOf(ProjectTaskTreeCorruptionError);
    expect((err as ProjectTaskTreeCorruptionError).reason).toBe('cycle');
  });
});
