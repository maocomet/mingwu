import { describe, expect, it } from 'vitest';
import {
  AiTaskPositionConflictError,
  AiTaskVersionConflictError,
} from '../src/domain/ai-task/errors.js';
import { InMemoryAiTaskRepository } from '../src/infrastructure/repositories/in-memory-ai-task-repository.js';
import { makeAiTask, uuid } from './helpers.js';

function setup() {
  return { repository: new InMemoryAiTaskRepository() };
}

describe('InMemoryAiTaskRepository', () => {
  it('creates a task and retrieves it by id and by owner', async () => {
    const { repository } = setup();
    const task = makeAiTask();
    const result = await repository.createIfAbsent(task);
    expect(result.created).toBe(true);
    expect((await repository.findById(task.id))?.title).toBe(task.title);
    expect(await repository.listByOwner(task.projectId, task.ownerActorId)).toHaveLength(1);
  });

  it('returns the existing task without overwriting when the id is reused', async () => {
    const { repository } = setup();
    const task = makeAiTask({ title: 'original' });
    await repository.createIfAbsent(task);
    const retry = makeAiTask({ id: task.id, projectId: task.projectId, title: 'other' });
    const result = await repository.createIfAbsent(retry);
    expect(result.created).toBe(false);
    expect(result.task.title).toBe('original');
    expect((await repository.findById(task.id))?.title).toBe('original');
  });

  it('rejects the same position under the same parent for the same owner and project', async () => {
    const { repository } = setup();
    const projectId = uuid();
    const ownerActorId = uuid();
    const parentTaskId = uuid();
    await repository.createIfAbsent(
      makeAiTask({ projectId, ownerActorId, parentTaskId, position: 4 }),
    );
    await expect(
      repository.createIfAbsent(
        makeAiTask({ projectId, ownerActorId, parentTaskId, position: 4 }),
      ),
    ).rejects.toBeInstanceOf(AiTaskPositionConflictError);
  });

  it('rejects the same position among root tasks (parentTaskId null)', async () => {
    const { repository } = setup();
    const projectId = uuid();
    const ownerActorId = uuid();
    await repository.createIfAbsent(
      makeAiTask({ projectId, ownerActorId, parentTaskId: null, position: 2 }),
    );
    await expect(
      repository.createIfAbsent(
        makeAiTask({ projectId, ownerActorId, parentTaskId: null, position: 2 }),
      ),
    ).rejects.toBeInstanceOf(AiTaskPositionConflictError);
  });

  it('allows the same position under different parents', async () => {
    const { repository } = setup();
    const projectId = uuid();
    const ownerActorId = uuid();
    const a = makeAiTask({ projectId, ownerActorId, parentTaskId: uuid(), position: 5 });
    const b = makeAiTask({ projectId, ownerActorId, parentTaskId: uuid(), position: 5 });
    const ra = await repository.createIfAbsent(a);
    const rb = await repository.createIfAbsent(b);
    expect(ra.created).toBe(true);
    expect(rb.created).toBe(true);
  });

  it('allows the same position for different owners in the same project', async () => {
    const { repository } = setup();
    const projectId = uuid();
    const a = makeAiTask({ projectId, ownerActorId: uuid(), parentTaskId: null, position: 3 });
    const b = makeAiTask({ projectId, ownerActorId: uuid(), parentTaskId: null, position: 3 });
    const ra = await repository.createIfAbsent(a);
    const rb = await repository.createIfAbsent(b);
    expect(ra.created).toBe(true);
    expect(rb.created).toBe(true);
  });

  it('allows the same position in different projects', async () => {
    const { repository } = setup();
    const ownerActorId = uuid();
    const a = makeAiTask({ projectId: uuid(), ownerActorId, parentTaskId: null, position: 3 });
    const b = makeAiTask({ projectId: uuid(), ownerActorId, parentTaskId: null, position: 3 });
    const ra = await repository.createIfAbsent(a);
    const rb = await repository.createIfAbsent(b);
    expect(ra.created).toBe(true);
    expect(rb.created).toBe(true);
  });

  it('lists tasks only for the matching project and owner', async () => {
    const { repository } = setup();
    const projectId = uuid();
    const ownerActorId = uuid();
    await repository.createIfAbsent(makeAiTask({ projectId, ownerActorId }));
    await repository.createIfAbsent(makeAiTask({ projectId: uuid(), ownerActorId }));
    await repository.createIfAbsent(makeAiTask({ projectId, ownerActorId: uuid() }));
    expect(await repository.listByOwner(projectId, ownerActorId)).toHaveLength(1);
  });

  it('updateTaskContent applies CAS changes and bumps version + refreshes updatedAt', async () => {
    const { repository } = setup();
    const task = makeAiTask({ title: 'old-title', description: 'old-desc', notes: ['n1'] });
    await repository.createIfAbsent(task);
    const updated = await repository.updateTaskContent({
      id: task.id,
      expectedVersion: 1,
      changes: { title: 'new-title', description: null },
      updatedAt: '2026-08-12T00:00:00.000Z',
    });
    expect(updated.title).toBe('new-title');
    expect(updated.description).toBeNull();
    expect(updated.version).toBe(2);
    expect(updated.updatedAt).toBe('2026-08-12T00:00:00.000Z');
    // 只有变更字段变化，其余字段（含 notes 数组引用隔离）保持不变。
    expect(updated.notes).toEqual(['n1']);
    expect(updated.notes).not.toBe(task.notes);
    expect(updated.projectId).toBe(task.projectId);
    expect(updated.ownerActorId).toBe(task.ownerActorId);
    expect(updated.status).toBe(task.status);
    expect(updated.position).toBe(task.position);
  });

  it('updateTaskContent rejects a stale expectedVersion and never overwrites', async () => {
    const { repository } = setup();
    const task = makeAiTask({ title: 'original' });
    await repository.createIfAbsent(task);
    await repository.updateTaskContent({
      id: task.id,
      expectedVersion: 1,
      changes: { title: 'v2' },
      updatedAt: '2026-08-12T00:00:00.000Z',
    });
    // 第二次用旧版本 1 更新 → 稳定冲突，不覆盖 v2。
    await expect(
      repository.updateTaskContent({
        id: task.id,
        expectedVersion: 1,
        changes: { title: 'stale-write' },
        updatedAt: '2026-08-12T00:00:01.000Z',
      }),
    ).rejects.toBeInstanceOf(AiTaskVersionConflictError);
    expect((await repository.findById(task.id))?.title).toBe('v2');
    expect((await repository.findById(task.id))?.version).toBe(2);
  });

  it('updateTaskContent rejects a non-existent id with a version conflict', async () => {
    const { repository } = setup();
    await expect(
      repository.updateTaskContent({
        id: uuid(),
        expectedVersion: 1,
        changes: { title: 'ghost' },
        updatedAt: '2026-08-12T00:00:00.000Z',
      }),
    ).rejects.toBeInstanceOf(AiTaskVersionConflictError);
  });

  it('concurrent updateTaskContent with the same expectedVersion: exactly one wins', async () => {
    const { repository } = setup();
    const task = makeAiTask({ title: 'base' });
    await repository.createIfAbsent(task);
    const results = await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        repository
          .updateTaskContent({
            id: task.id,
            expectedVersion: 1,
            changes: { title: `writer-${i}` },
            updatedAt: '2026-08-12T00:00:00.000Z',
          })
          .then(() => 'succeeded')
          .catch((e) =>
            e instanceof AiTaskVersionConflictError ? 'conflict' : 'other',
          ),
      ),
    );
    expect(results.filter((r) => r === 'succeeded')).toHaveLength(1);
    expect(results.filter((r) => r === 'conflict')).toHaveLength(19);
    const finalTask = await repository.findById(task.id);
    expect(finalTask?.version).toBe(2);
  });

  it('completeTask applies CAS: completed status, 100% progress, same time, version +1', async () => {
    const { repository } = setup();
    const task = makeAiTask({
      title: 'do-it',
      description: 'desc',
      notes: ['n1'],
      status: 'not_started',
      progressPercent: 0,
    });
    await repository.createIfAbsent(task);
    const completed = await repository.completeTask({
      id: task.id,
      expectedVersion: 1,
      completedAt: '2026-08-12T00:00:00.000Z',
    });
    expect(completed.status).toBe('completed');
    expect(completed.progressPercent).toBe(100);
    // completedAt 与 updatedAt 为同一服务端时间。
    expect(completed.completedAt).toBe('2026-08-12T00:00:00.000Z');
    expect(completed.updatedAt).toBe('2026-08-12T00:00:00.000Z');
    expect(completed.version).toBe(2);
    // 其余字段保持不变（含 notes 数组引用隔离）。
    expect(completed.title).toBe(task.title);
    expect(completed.description).toBe(task.description);
    expect(completed.notes).toEqual(['n1']);
    expect(completed.notes).not.toBe(task.notes);
    expect(completed.projectId).toBe(task.projectId);
    expect(completed.ownerActorId).toBe(task.ownerActorId);
    expect(completed.position).toBe(task.position);
    expect(completed.createdAt).toBe(task.createdAt);
  });

  it('completeTask rejects a stale expectedVersion and never overwrites', async () => {
    const { repository } = setup();
    const task = makeAiTask({ title: 'original' });
    await repository.createIfAbsent(task);
    await repository.completeTask({
      id: task.id,
      expectedVersion: 1,
      completedAt: '2026-08-12T00:00:00.000Z',
    });
    // 第二次用旧版本 1 完成 → 稳定冲突，不覆盖已完成状态。
    await expect(
      repository.completeTask({
        id: task.id,
        expectedVersion: 1,
        completedAt: '2026-08-12T00:00:01.000Z',
      }),
    ).rejects.toBeInstanceOf(AiTaskVersionConflictError);
    const after = await repository.findById(task.id);
    expect(after?.status).toBe('completed');
    expect(after?.version).toBe(2);
  });

  it('completeTask rejects a non-existent id with a version conflict', async () => {
    const { repository } = setup();
    await expect(
      repository.completeTask({
        id: uuid(),
        expectedVersion: 1,
        completedAt: '2026-08-12T00:00:00.000Z',
      }),
    ).rejects.toBeInstanceOf(AiTaskVersionConflictError);
  });

  it('concurrent completeTask with the same expectedVersion: exactly one wins', async () => {
    const { repository } = setup();
    const task = makeAiTask({ title: 'base' });
    await repository.createIfAbsent(task);
    const results = await Promise.all(
      Array.from({ length: 20 }, () =>
        repository
          .completeTask({
            id: task.id,
            expectedVersion: 1,
            completedAt: '2026-08-12T00:00:00.000Z',
          })
          .then(() => 'succeeded')
          .catch((e) =>
            e instanceof AiTaskVersionConflictError ? 'conflict' : 'other',
          ),
      ),
    );
    expect(results.filter((r) => r === 'succeeded')).toHaveLength(1);
    expect(results.filter((r) => r === 'conflict')).toHaveLength(19);
    const finalTask = await repository.findById(task.id);
    expect(finalTask?.status).toBe('completed');
    expect(finalTask?.version).toBe(2);
  });

  it('sequential same-connection updateTaskContent calls advance the version each time', async () => {
    const { repository } = setup();
    const task = makeAiTask({ title: 'v1' });
    await repository.createIfAbsent(task);
    let version = 1;
    for (let i = 2; i <= 5; i += 1) {
      const updated = await repository.updateTaskContent({
        id: task.id,
        expectedVersion: version,
        changes: { title: `v${i}` },
        updatedAt: '2026-08-12T00:00:00.000Z',
      });
      expect(updated.version).toBe(i);
      version = updated.version;
    }
    expect((await repository.findById(task.id))?.title).toBe('v5');
  });

  it('concurrent createIfAbsent with the same id: one created, rest return existing', async () => {
    const { repository } = setup();
    const task = makeAiTask();
    const results = await Promise.all(
      Array.from({ length: 20 }, () => repository.createIfAbsent(task)),
    );
    expect(results.filter((r) => r.created)).toHaveLength(1);
    expect(results.filter((r) => !r.created)).toHaveLength(19);
    expect((await repository.listByOwner(task.projectId, task.ownerActorId)).length).toBe(1);
  });

  it('concurrent createIfAbsent with the same parent and position: one created, rest position conflict', async () => {
    const { repository } = setup();
    const projectId = uuid();
    const ownerActorId = uuid();
    const parentTaskId = uuid();
    const results = await Promise.all(
      Array.from({ length: 20 }, () =>
        repository
          .createIfAbsent(
            makeAiTask({ projectId, ownerActorId, parentTaskId, position: 9 }),
          )
          .then(() => 'created')
          .catch((e) =>
            e instanceof AiTaskPositionConflictError ? 'conflict' : 'other',
          ),
      ),
    );
    expect(results.filter((r) => r === 'created')).toHaveLength(1);
    expect(results.filter((r) => r === 'conflict')).toHaveLength(19);
    expect((await repository.listByOwner(projectId, ownerActorId)).length).toBe(1);
  });
});
