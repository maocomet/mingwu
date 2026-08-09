import { describe, expect, it } from 'vitest';
import { StagePositionConflictError } from '../src/domain/stage/errors.js';
import { InMemoryStageRepository } from '../src/infrastructure/repositories/in-memory-stage-repository.js';
import { makeStage, uuid } from './helpers.js';

function setup() {
  return { repository: new InMemoryStageRepository() };
}

describe('InMemoryStageRepository', () => {
  it('creates a stage and retrieves it by id and by project', async () => {
    const { repository } = setup();
    const stage = makeStage();
    const result = await repository.createIfAbsent(stage);
    expect(result.created).toBe(true);
    expect((await repository.findById(stage.id))?.name).toBe(stage.name);
    expect(await repository.listByProject(stage.projectId)).toHaveLength(1);
  });

  it('returns the existing stage without overwriting when the id is reused', async () => {
    const { repository } = setup();
    const stage = makeStage({ name: 'original' });
    await repository.createIfAbsent(stage);
    const retry = makeStage({ id: stage.id, projectId: stage.projectId, name: 'other' });
    const result = await repository.createIfAbsent(retry);
    expect(result.created).toBe(false);
    expect(result.stage.name).toBe('original');
    expect((await repository.findById(stage.id))?.name).toBe('original');
  });

  it('rejects a different stage id occupying the same (projectId, position)', async () => {
    const { repository } = setup();
    const projectId = uuid();
    await repository.createIfAbsent(makeStage({ projectId, position: 2 }));
    await expect(
      repository.createIfAbsent(makeStage({ projectId, position: 2 })),
    ).rejects.toBeInstanceOf(StagePositionConflictError);
  });

  it('allows the same position in different projects', async () => {
    const { repository } = setup();
    const first = makeStage({ position: 3 });
    const second = makeStage({ position: 3 });
    expect(first.projectId).not.toBe(second.projectId);
    const a = await repository.createIfAbsent(first);
    const b = await repository.createIfAbsent(second);
    expect(a.created).toBe(true);
    expect(b.created).toBe(true);
  });

  it('lists stages by project sorted by position ascending', async () => {
    const { repository } = setup();
    const projectId = uuid();
    await repository.createIfAbsent(makeStage({ projectId, position: 3 }));
    await repository.createIfAbsent(makeStage({ projectId, position: 1 }));
    await repository.createIfAbsent(makeStage({ projectId, position: 2 }));
    const stages = await repository.listByProject(projectId);
    expect(stages.map((s) => s.position)).toEqual([1, 2, 3]);
  });

  it('excludes stages belonging to other projects', async () => {
    const { repository } = setup();
    await repository.createIfAbsent(makeStage({ projectId: uuid(), position: 1 }));
    const projectId = uuid();
    await repository.createIfAbsent(makeStage({ projectId, position: 1 }));
    expect(await repository.listByProject(projectId)).toHaveLength(1);
  });

  it('concurrent createIfAbsent with the same id: one created, rest return existing', async () => {
    const { repository } = setup();
    const stage = makeStage();
    const results = await Promise.all(
      Array.from({ length: 20 }, () => repository.createIfAbsent(stage)),
    );
    expect(results.filter((r) => r.created)).toHaveLength(1);
    expect(results.filter((r) => !r.created)).toHaveLength(19);
    expect((await repository.listByProject(stage.projectId)).length).toBe(1);
  });

  it('concurrent createIfAbsent with the same position but different ids: one created, rest position conflict', async () => {
    const { repository } = setup();
    const projectId = uuid();
    const results = await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        repository
          .createIfAbsent(makeStage({ projectId, position: 7 }))
          .then(() => 'created')
          .catch((e) => (e instanceof StagePositionConflictError ? 'conflict' : 'other')),
      ),
    );
    expect(results.filter((r) => r === 'created')).toHaveLength(1);
    expect(results.filter((r) => r === 'conflict')).toHaveLength(19);
    expect((await repository.listByProject(projectId)).length).toBe(1);
  });

  it('updateIfVersion applies metadata changes and bumps version', async () => {
    const { repository } = setup();
    const stage = makeStage({ position: 1 });
    await repository.createIfAbsent(stage);
    const updated = {
      ...stage,
      name: '改名',
      description: '新描述',
      position: 5,
      version: stage.version + 1,
      updatedAt: new Date().toISOString(),
    };
    const result = await repository.updateIfVersion(updated, stage.version);
    expect(result).not.toBeNull();
    expect(result!.name).toBe('改名');
    expect(result!.description).toBe('新描述');
    expect(result!.position).toBe(5);
    expect(result!.version).toBe(stage.version + 1);
    expect((await repository.findById(stage.id))!.name).toBe('改名');
  });

  it('updateIfVersion returns null and does not write when the stage does not exist', async () => {
    const { repository } = setup();
    const ghost = makeStage();
    const result = await repository.updateIfVersion(ghost, ghost.version);
    expect(result).toBeNull();
    expect(await repository.findById(ghost.id)).toBeNull();
  });

  it('updateIfVersion returns null and does not write on version mismatch', async () => {
    const { repository } = setup();
    const stage = makeStage();
    await repository.createIfAbsent(stage);
    const result = await repository.updateIfVersion(
      { ...stage, version: stage.version + 1 },
      stage.version + 99,
    );
    expect(result).toBeNull();
    expect((await repository.findById(stage.id))!.version).toBe(stage.version);
  });

  it('updateIfVersion rejects a position occupied by a different stage in the same project', async () => {
    const { repository } = setup();
    const projectId = uuid();
    const stage = makeStage({ projectId, position: 1 });
    await repository.createIfAbsent(stage);
    await repository.createIfAbsent(makeStage({ projectId, position: 2 }));
    const updated = { ...stage, position: 2, version: stage.version + 1 };
    await expect(repository.updateIfVersion(updated, stage.version)).rejects.toBeInstanceOf(
      StagePositionConflictError,
    );
    // 原数据不被覆盖
    expect((await repository.findById(stage.id))!.position).toBe(1);
  });

  it('updateIfVersion allows keeping its own position (self excluded from the uniqueness check)', async () => {
    const { repository } = setup();
    const stage = makeStage({ position: 3 });
    await repository.createIfAbsent(stage);
    const updated = { ...stage, name: '保持位置', version: stage.version + 1 };
    const result = await repository.updateIfVersion(updated, stage.version);
    expect(result!.position).toBe(3);
  });

  it('concurrent updateIfVersion with the same expectedVersion: only one succeeds', async () => {
    const { repository } = setup();
    const stage = makeStage();
    await repository.createIfAbsent(stage);
    const results = await Promise.all(
      Array.from({ length: 20 }, () =>
        repository.updateIfVersion(
          { ...stage, name: '并发改名', version: stage.version + 1 },
          stage.version,
        ),
      ),
    );
    expect(results.filter((r) => r !== null)).toHaveLength(1);
    expect((await repository.findById(stage.id))!.version).toBe(stage.version + 1);
  });
});
