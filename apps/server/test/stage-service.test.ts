import { describe, expect, it } from 'vitest';
import type { ProjectService } from '../src/application/project/project-service.js';
import { ProjectNotFoundError } from '../src/domain/project/errors.js';
import {
  StageIdempotencyConflictError,
  StageNotFoundError,
} from '../src/domain/stage/errors.js';
import { makeServices, uuid } from './helpers.js';

async function createProject(projectService: ProjectService): Promise<string> {
  const { project } = await projectService.createProject({ id: uuid(), name: 'Proj' });
  return project.id;
}

describe('StageService', () => {
  it('creates a stage with default not_started status and version 1', async () => {
    const { projectService, stageService } = makeServices();
    const projectId = await createProject(projectService);
    const result = await stageService.createStage(projectId, {
      id: uuid(),
      name: '第一关',
    });
    expect(result.created).toBe(true);
    expect(result.stage.status).toBe('not_started');
    expect(result.stage.version).toBe(1);
    expect(result.stage.position).toBe(1);
    expect(result.stage.projectId).toBe(projectId);
  });

  it('auto-assigns increasing positions when position is not provided', async () => {
    const { projectService, stageService } = makeServices();
    const projectId = await createProject(projectService);
    const a = await stageService.createStage(projectId, { id: uuid(), name: 'A' });
    const b = await stageService.createStage(projectId, { id: uuid(), name: 'B' });
    const c = await stageService.createStage(projectId, { id: uuid(), name: 'C' });
    expect([a.stage.position, b.stage.position, c.stage.position]).toEqual([1, 2, 3]);
  });

  it('honours an explicitly provided position', async () => {
    const { projectService, stageService } = makeServices();
    const projectId = await createProject(projectService);
    const result = await stageService.createStage(projectId, {
      id: uuid(),
      name: 'B',
      position: 9,
    });
    expect(result.stage.position).toBe(9);
  });

  it('auto-assigns unique consecutive positions when 20 stages are created concurrently without a position', async () => {
    const { projectService, stageService } = makeServices();
    const projectId = await createProject(projectService);
    const results = await Promise.all(
      Array.from({ length: 20 }, () =>
        stageService.createStage(projectId, { id: uuid(), name: 'auto' }),
      ),
    );
    expect(results.every((r) => r.created)).toBe(true);
    const positions = results.map((r) => r.stage.position).sort((a, b) => a - b);
    expect(positions).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
    expect(new Set(positions).size).toBe(20);
  });

  it('throws ProjectNotFoundError when the project does not exist', async () => {
    const { stageService } = makeServices();
    await expect(
      stageService.createStage(uuid(), { id: uuid(), name: 'X' }),
    ).rejects.toBeInstanceOf(ProjectNotFoundError);
  });

  it('treats a retry with the same id and content as idempotent', async () => {
    const { projectService, stageService } = makeServices();
    const projectId = await createProject(projectService);
    const input = { id: uuid(), name: '第一关', description: 'd' };
    const first = await stageService.createStage(projectId, input);
    const second = await stageService.createStage(projectId, input);
    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.stage.id).toBe(first.stage.id);
    expect(second.stage.name).toBe('第一关');
    expect(second.stage.position).toBe(first.stage.position);
  });

  it('treats an auto-position retry as idempotent even though the recomputed position differs', async () => {
    const { projectService, stageService } = makeServices();
    const projectId = await createProject(projectService);
    const input = { id: uuid(), name: '第一关' };
    const first = await stageService.createStage(projectId, input);
    // 重试时未显式提供 position，重算出的位置会不同；但语义一致，仍应视为幂等。
    const second = await stageService.createStage(projectId, input);
    expect(second.created).toBe(false);
    expect(second.stage.position).toBe(first.stage.position);
  });

  it('rejects reusing the same id with different content', async () => {
    const { projectService, stageService } = makeServices();
    const projectId = await createProject(projectService);
    const id = uuid();
    await stageService.createStage(projectId, { id, name: 'A' });
    await expect(
      stageService.createStage(projectId, { id, name: 'B' }),
    ).rejects.toBeInstanceOf(StageIdempotencyConflictError);
    await expect(
      stageService.createStage(projectId, { id, name: 'A', position: 5 }),
    ).rejects.toBeInstanceOf(StageIdempotencyConflictError);
  });

  it('rejects reusing the same id with a different project', async () => {
    const { projectService, stageService } = makeServices();
    const projectA = await createProject(projectService);
    const projectB = await createProject(projectService);
    const id = uuid();
    await stageService.createStage(projectA, { id, name: 'A' });
    await expect(
      stageService.createStage(projectB, { id, name: 'A' }),
    ).rejects.toBeInstanceOf(StageIdempotencyConflictError);
  });

  it('rejects reusing the same id with an explicit different position', async () => {
    const { projectService, stageService } = makeServices();
    const projectId = await createProject(projectService);
    const id = uuid();
    await stageService.createStage(projectId, { id, name: 'A', position: 1 });
    await expect(
      stageService.createStage(projectId, { id, name: 'A', position: 2 }),
    ).rejects.toBeInstanceOf(StageIdempotencyConflictError);
  });

  it('gets a stage by id', async () => {
    const { projectService, stageService } = makeServices();
    const projectId = await createProject(projectService);
    const created = await stageService.createStage(projectId, { id: uuid(), name: '第一关' });
    const stage = await stageService.getStage(created.stage.id);
    expect(stage.name).toBe('第一关');
  });

  it('throws StageNotFoundError for an unknown stage', async () => {
    const { stageService } = makeServices();
    await expect(stageService.getStage(uuid())).rejects.toBeInstanceOf(StageNotFoundError);
  });
});
