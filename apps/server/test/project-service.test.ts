import { describe, expect, it } from 'vitest';
import { ProjectService } from '../src/application/project/project-service.js';
import {
  ProjectConflictError,
  ProjectIdempotencyConflictError,
  ProjectNotFoundError,
} from '../src/domain/project/errors.js';
import { InMemoryProjectRepository } from '../src/infrastructure/repositories/in-memory-project-repository.js';
import { makeProject, uuid } from './helpers.js';

function setup() {
  const repository = new InMemoryProjectRepository();
  const service = new ProjectService(repository);
  return { repository, service };
}

async function seed(repository: InMemoryProjectRepository, overrides = {}) {
  const project = makeProject(overrides);
  await repository.createIfAbsent(project);
  return project;
}

describe('ProjectService.createProject', () => {
  it('creates a project with default status active and version 1', async () => {
    const { service } = setup();
    const result = await service.createProject({ id: uuid(), name: 'Mingwu v0.1' });
    expect(result.created).toBe(true);
    expect(result.project.status).toBe('active');
    expect(result.project.version).toBe(1);
    expect(result.project.createdAt).toBe(result.project.updatedAt);
  });

  it('is idempotent: retrying the same id and content returns the existing project', async () => {
    const { service } = setup();
    const input = { id: uuid(), name: 'Mingwu v0.1' };
    const first = await service.createProject(input);
    const second = await service.createProject(input);
    expect(second.created).toBe(false);
    expect(second.project.id).toBe(first.project.id);
    expect(second.project.version).toBe(first.project.version);
  });

  it('rejects the same id with different content', async () => {
    const { service } = setup();
    const id = uuid();
    await service.createProject({ id, name: 'A' });
    await expect(service.createProject({ id, name: 'B' })).rejects.toBeInstanceOf(
      ProjectIdempotencyConflictError,
    );
  });

  it('concurrent createProject with the same id and content: exactly one created', async () => {
    const { service } = setup();
    const input = { id: uuid(), name: 'same' };
    const results = await Promise.all(
      Array.from({ length: 20 }, () => service.createProject(input)),
    );
    const createdCount = results.filter((r) => r.created).length;
    expect(createdCount).toBe(1);
    expect(new Set(results.map((r) => r.project.id)).size).toBe(1);
    expect(new Set(results.map((r) => r.project.name)).size).toBe(1);
  });

  it('concurrent createProject with the same id and different content: exactly one created, rest conflict', async () => {
    const { service } = setup();
    const id = uuid();
    const results = await Promise.allSettled(
      Array.from({ length: 20 }, (_, i) => service.createProject({ id, name: `candidate-${i}` })),
    );
    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(19);
    for (const r of rejected) {
      expect((r as PromiseRejectedResult).reason).toBeInstanceOf(ProjectIdempotencyConflictError);
    }
  });
});

describe('ProjectService.getProject', () => {
  it('returns an existing project', async () => {
    const { repository, service } = setup();
    const project = await seed(repository);
    await expect(service.getProject(project.id)).resolves.toEqual(project);
  });

  it('throws ProjectNotFoundError for an unknown project', async () => {
    const { service } = setup();
    await expect(service.getProject(uuid())).rejects.toBeInstanceOf(ProjectNotFoundError);
  });
});

describe('ProjectService.updateProject', () => {
  it('applies a patch and bumps the version', async () => {
    const { repository, service } = setup();
    const project = await seed(repository, { name: 'old name' });
    const updated = await service.updateProject(project.id, {
      expectedVersion: project.version,
      name: 'new name',
    });
    expect(updated.name).toBe('new name');
    expect(updated.version).toBe(project.version + 1);
  });

  it('rejects an update with a stale expected version', async () => {
    const { repository, service } = setup();
    const project = await seed(repository);
    await expect(
      service.updateProject(project.id, { expectedVersion: project.version + 5, name: 'x' }),
    ).rejects.toBeInstanceOf(ProjectConflictError);
  });

  it('throws ProjectNotFoundError when updating an unknown project', async () => {
    const { service } = setup();
    await expect(service.updateProject(uuid(), { expectedVersion: 1, name: 'x' })).rejects.toBeInstanceOf(
      ProjectNotFoundError,
    );
  });

  it('keeps a nullable field when absent and clears it when explicitly null', async () => {
    const { repository, service } = setup();
    const project = await seed(repository, { description: 'keep me' });
    const kept = await service.updateProject(project.id, { expectedVersion: project.version });
    expect(kept.description).toBe('keep me');
    const cleared = await service.updateProject(project.id, {
      expectedVersion: kept.version,
      description: null,
    });
    expect(cleared.description).toBeNull();
  });

  it('sets archivedAt when status becomes archived and clears it when leaving archived', async () => {
    const { repository, service } = setup();
    const project = await seed(repository, { status: 'active' });
    const archived = await service.updateProject(project.id, {
      expectedVersion: project.version,
      status: 'archived',
    });
    expect(archived.status).toBe('archived');
    expect(archived.archivedAt).not.toBeNull();
    const reactivated = await service.updateProject(project.id, {
      expectedVersion: archived.version,
      status: 'active',
    });
    expect(reactivated.status).toBe('active');
    expect(reactivated.archivedAt).toBeNull();
  });

  it('concurrent updateProject with the same expectedVersion: exactly one succeeds', async () => {
    const { repository, service } = setup();
    const project = await seed(repository);
    const results = await Promise.allSettled(
      Array.from({ length: 20 }, () =>
        service.updateProject(project.id, { expectedVersion: project.version, name: 'new' }),
      ),
    );
    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(19);
    for (const r of rejected) {
      expect((r as PromiseRejectedResult).reason).toBeInstanceOf(ProjectConflictError);
    }
    const finalProject = await service.getProject(project.id);
    expect(finalProject.version).toBe(project.version + 1);
    expect(finalProject.name).toBe('new');
  });
});
