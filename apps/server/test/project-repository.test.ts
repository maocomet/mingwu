import { describe, expect, it } from 'vitest';
import { InMemoryProjectRepository } from '../src/infrastructure/repositories/in-memory-project-repository.js';
import { makeProject, uuid } from './helpers.js';

describe('InMemoryProjectRepository', () => {
  it('createIfAbsent saves and returns the project with created=true', async () => {
    const repo = new InMemoryProjectRepository();
    const project = makeProject();
    const result = await repo.createIfAbsent(project);
    expect(result.created).toBe(true);
    const found = await repo.findById(project.id);
    expect(found).toEqual(project);
  });

  it('createIfAbsent returns the existing project without overwriting', async () => {
    const repo = new InMemoryProjectRepository();
    const project = makeProject({ name: 'first' });
    await repo.createIfAbsent(project);
    const second = makeProject({ id: project.id, name: 'second' });
    const result = await repo.createIfAbsent(second);
    expect(result.created).toBe(false);
    expect(result.project.name).toBe('first');
    const found = await repo.findById(project.id);
    expect(found!.name).toBe('first');
  });

  it('returns null for an unknown id', async () => {
    const repo = new InMemoryProjectRepository();
    expect(await repo.findById(uuid())).toBeNull();
  });

  it('updateIfVersion succeeds only when version matches', async () => {
    const repo = new InMemoryProjectRepository();
    const project = makeProject();
    await repo.createIfAbsent(project);
    const updated = makeProject({ id: project.id, name: 'updated', version: project.version + 1 });
    const saved = await repo.updateIfVersion(updated, project.version);
    expect(saved).not.toBeNull();
    expect((await repo.findById(project.id))!.name).toBe('updated');
  });

  it('updateIfVersion does not write when version mismatches', async () => {
    const repo = new InMemoryProjectRepository();
    const project = makeProject({ name: 'original' });
    await repo.createIfAbsent(project);
    const updated = makeProject({ id: project.id, name: 'should-not-write' });
    const saved = await repo.updateIfVersion(updated, project.version + 5);
    expect(saved).toBeNull();
    const found = await repo.findById(project.id);
    expect(found!.name).toBe('original');
    expect(found!.version).toBe(project.version);
  });

  it('updateIfVersion returns null for an unknown id', async () => {
    const repo = new InMemoryProjectRepository();
    const saved = await repo.updateIfVersion(makeProject(), 1);
    expect(saved).toBeNull();
  });

  it('returns a copy so callers cannot mutate stored state', async () => {
    const repo = new InMemoryProjectRepository();
    const project = makeProject({ name: 'original' });
    await repo.createIfAbsent(project);
    const found = await repo.findById(project.id);
    found!.name = 'mutated';
    const again = await repo.findById(project.id);
    expect(again!.name).toBe('original');
  });

  it('concurrent createIfAbsent with the same id: exactly one created, data from the winner', async () => {
    const repo = new InMemoryProjectRepository();
    const id = uuid();
    const results = await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        repo.createIfAbsent(makeProject({ id, name: `candidate-${i}` })),
      ),
    );
    const createdCount = results.filter((r) => r.created).length;
    expect(createdCount).toBe(1);
    const winner = results.find((r) => r.created)!;
    const finalProject = await repo.findById(id);
    expect(finalProject!.name).toBe(winner.project.name);
    expect(finalProject!.version).toBe(1);
  });

  it('concurrent updateIfVersion with the same expectedVersion: exactly one succeeds', async () => {
    const repo = new InMemoryProjectRepository();
    const project = makeProject();
    await repo.createIfAbsent(project);
    const results = await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        repo.updateIfVersion(
          makeProject({ id: project.id, name: `updated-${i}`, version: project.version + 1 }),
          project.version,
        ),
      ),
    );
    const saved = results.filter((r) => r !== null);
    expect(saved).toHaveLength(1);
    const finalProject = await repo.findById(project.id);
    expect(finalProject!.version).toBe(project.version + 1);
  });
});
