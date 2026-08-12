import { describe, expect, it } from 'vitest';
import { AiTaskPositionConflictError } from '../src/domain/ai-task/errors.js';
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
