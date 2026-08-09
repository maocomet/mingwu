import { describe, expect, it } from 'vitest';
import { ProjectTaskPositionConflictError } from '../src/domain/project-task/errors.js';
import { InMemoryProjectTaskRepository } from '../src/infrastructure/repositories/in-memory-project-task-repository.js';
import { makeTask, uuid } from './helpers.js';

function setup() {
  return { repository: new InMemoryProjectTaskRepository() };
}

describe('InMemoryProjectTaskRepository', () => {
  it('creates a task and retrieves it by id and by stage', async () => {
    const { repository } = setup();
    const task = makeTask();
    const result = await repository.createIfAbsent(task);
    expect(result.created).toBe(true);
    expect((await repository.findById(task.id))?.title).toBe(task.title);
    expect(await repository.listByStage(task.stageId)).toHaveLength(1);
  });

  it('returns the existing task without overwriting when the id is reused', async () => {
    const { repository } = setup();
    const task = makeTask({ title: 'original' });
    await repository.createIfAbsent(task);
    const retry = makeTask({ id: task.id, stageId: task.stageId, title: 'other' });
    const result = await repository.createIfAbsent(retry);
    expect(result.created).toBe(false);
    expect(result.task.title).toBe('original');
    expect((await repository.findById(task.id))?.title).toBe('original');
  });

  it('rejects the same position under the same parent within a stage', async () => {
    const { repository } = setup();
    const stageId = uuid();
    const parentTaskId = uuid();
    await repository.createIfAbsent(makeTask({ stageId, parentTaskId, position: 4 }));
    await expect(
      repository.createIfAbsent(makeTask({ stageId, parentTaskId, position: 4 })),
    ).rejects.toBeInstanceOf(ProjectTaskPositionConflictError);
  });

  it('rejects the same position among root tasks (parentTaskId null)', async () => {
    const { repository } = setup();
    const stageId = uuid();
    await repository.createIfAbsent(makeTask({ stageId, parentTaskId: null, position: 2 }));
    await expect(
      repository.createIfAbsent(makeTask({ stageId, parentTaskId: null, position: 2 })),
    ).rejects.toBeInstanceOf(ProjectTaskPositionConflictError);
  });

  it('allows the same position under different parents', async () => {
    const { repository } = setup();
    const stageId = uuid();
    const a = makeTask({ stageId, parentTaskId: uuid(), position: 5 });
    const b = makeTask({ stageId, parentTaskId: uuid(), position: 5 });
    const ra = await repository.createIfAbsent(a);
    const rb = await repository.createIfAbsent(b);
    expect(ra.created).toBe(true);
    expect(rb.created).toBe(true);
  });

  it('allows the same position in different stages', async () => {
    const { repository } = setup();
    const a = makeTask({ stageId: uuid(), parentTaskId: null, position: 3 });
    const b = makeTask({ stageId: uuid(), parentTaskId: null, position: 3 });
    const ra = await repository.createIfAbsent(a);
    const rb = await repository.createIfAbsent(b);
    expect(ra.created).toBe(true);
    expect(rb.created).toBe(true);
  });

  it('lists tasks by stage only', async () => {
    const { repository } = setup();
    const stageId = uuid();
    await repository.createIfAbsent(makeTask({ stageId }));
    await repository.createIfAbsent(makeTask({ stageId: uuid() }));
    expect(await repository.listByStage(stageId)).toHaveLength(1);
  });

  it('concurrent createIfAbsent with the same id: one created, rest return existing', async () => {
    const { repository } = setup();
    const task = makeTask();
    const results = await Promise.all(
      Array.from({ length: 20 }, () => repository.createIfAbsent(task)),
    );
    expect(results.filter((r) => r.created)).toHaveLength(1);
    expect(results.filter((r) => !r.created)).toHaveLength(19);
    expect((await repository.listByStage(task.stageId)).length).toBe(1);
  });

  it('concurrent createIfAbsent with the same parent and position: one created, rest position conflict', async () => {
    const { repository } = setup();
    const stageId = uuid();
    const parentTaskId = uuid();
    const results = await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        repository
          .createIfAbsent(makeTask({ stageId, parentTaskId, position: 9 }))
          .then(() => 'created')
          .catch((e) =>
            e instanceof ProjectTaskPositionConflictError ? 'conflict' : 'other',
          ),
      ),
    );
    expect(results.filter((r) => r === 'created')).toHaveLength(1);
    expect(results.filter((r) => r === 'conflict')).toHaveLength(19);
    expect((await repository.listByStage(stageId)).length).toBe(1);
  });
});
