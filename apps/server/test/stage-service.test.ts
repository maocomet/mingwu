import { describe, expect, it, vi } from 'vitest';
import type { ProjectService } from '../src/application/project/project-service.js';
import { ProjectNotFoundError } from '../src/domain/project/errors.js';
import {
  StageIdempotencyConflictError,
  StageNotFoundError,
  StagePositionConflictError,
  StageVersionConflictError,
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

  describe('updateStage', () => {
    it('modifies metadata, bumps version and refreshes updatedAt while keeping other fields', async () => {
      // 创建与修改可能落在同一毫秒，用假时钟推进一毫秒，确定性地验证 updatedAt 被刷新。
      vi.useFakeTimers();
      try {
        const { projectService, stageService } = makeServices();
        const projectId = await createProject(projectService);
        const { stage } = await stageService.createStage(projectId, {
          id: uuid(),
          name: '旧名',
          description: '旧描述',
          completionCriteria: '旧条件',
          position: 1,
        });
        vi.setSystemTime(new Date(Date.parse(stage.updatedAt) + 1));
        const result = await stageService.updateStage(stage.id, {
          expectedVersion: stage.version,
          name: '新名',
          completionCriteria: '新条件',
        });
        expect(result.name).toBe('新名');
        expect(result.description).toBe('旧描述');
        expect(result.completionCriteria).toBe('新条件');
        expect(result.position).toBe(1);
        expect(result.status).toBe(stage.status);
        expect(result.version).toBe(stage.version + 1);
        expect(result.updatedAt > stage.updatedAt).toBe(true);
        expect(result.createdAt).toBe(stage.createdAt);
      } finally {
        vi.useRealTimers();
      }
    });

    it('clears a nullable field when explicitly set to null', async () => {
      const { projectService, stageService } = makeServices();
      const projectId = await createProject(projectService);
      const { stage } = await stageService.createStage(projectId, {
        id: uuid(),
        name: '关卡',
        description: '要清空',
      });
      const result = await stageService.updateStage(stage.id, {
        expectedVersion: stage.version,
        description: null,
      });
      expect(result.description).toBeNull();
      expect(result.name).toBe('关卡');
    });

    it('keeps the existing value when a field is not provided', async () => {
      const { projectService, stageService } = makeServices();
      const projectId = await createProject(projectService);
      const { stage } = await stageService.createStage(projectId, {
        id: uuid(),
        name: '关卡',
        description: '保留',
      });
      const result = await stageService.updateStage(stage.id, {
        expectedVersion: stage.version,
        name: '改名',
      });
      expect(result.description).toBe('保留');
    });

    it('allows changing position to an unused value', async () => {
      const { projectService, stageService } = makeServices();
      const projectId = await createProject(projectService);
      const { stage } = await stageService.createStage(projectId, { id: uuid(), name: 'A', position: 1 });
      const result = await stageService.updateStage(stage.id, {
        expectedVersion: stage.version,
        position: 9,
      });
      expect(result.position).toBe(9);
    });

    it('rejects a position already taken by another stage in the same project', async () => {
      const { projectService, stageService } = makeServices();
      const projectId = await createProject(projectService);
      const { stage: a } = await stageService.createStage(projectId, { id: uuid(), name: 'A', position: 1 });
      const { stage: b } = await stageService.createStage(projectId, { id: uuid(), name: 'B', position: 2 });
      await expect(
        stageService.updateStage(a.id, { expectedVersion: a.version, position: b.position }),
      ).rejects.toBeInstanceOf(StagePositionConflictError);
    });

    it('throws StageNotFoundError for an unknown stage', async () => {
      const { stageService } = makeServices();
      await expect(
        stageService.updateStage(uuid(), { expectedVersion: 1, name: 'X' }),
      ).rejects.toBeInstanceOf(StageNotFoundError);
    });

    it('throws StageVersionConflictError on a stale expectedVersion', async () => {
      const { projectService, stageService } = makeServices();
      const projectId = await createProject(projectService);
      const { stage } = await stageService.createStage(projectId, { id: uuid(), name: 'A' });
      await stageService.updateStage(stage.id, { expectedVersion: stage.version, name: 'B' });
      await expect(
        stageService.updateStage(stage.id, { expectedVersion: stage.version, name: 'C' }),
      ).rejects.toBeInstanceOf(StageVersionConflictError);
    });

    it('concurrent updateStage with the same expectedVersion: only one succeeds', async () => {
      const { projectService, stageService } = makeServices();
      const projectId = await createProject(projectService);
      const { stage } = await stageService.createStage(projectId, { id: uuid(), name: 'A' });
      const results = await Promise.all(
        Array.from({ length: 20 }, () =>
          stageService
            .updateStage(stage.id, { expectedVersion: stage.version, name: '并发' })
            .then(() => 'ok')
            .catch((e) => (e instanceof StageVersionConflictError ? 'conflict' : 'other')),
        ),
      );
      expect(results.filter((r) => r === 'ok')).toHaveLength(1);
      expect(results.filter((r) => r === 'conflict')).toHaveLength(19);
      const final = await stageService.getStage(stage.id);
      expect(final.version).toBe(stage.version + 1);
    });
  });

  describe('setStageStatus', () => {
    it('accepts each of the seven legal statuses and bumps version', async () => {
      const { projectService, stageService } = makeServices();
      const projectId = await createProject(projectService);
      const { stage } = await stageService.createStage(projectId, { id: uuid(), name: '关卡' });
      const statuses = ['locked', 'not_started', 'in_progress', 'pending_review', 'needs_changes', 'blocked', 'completed'] as const;
      let current = stage;
      for (const status of statuses) {
        if (status === current.status) continue;
        current = await stageService.setStageStatus(current.id, {
          expectedVersion: current.version,
          status,
        });
        expect(current.status).toBe(status);
        expect(current.version).toBeGreaterThan(0);
      }
    });

    it('writes startedAt on first entry into in_progress', async () => {
      const { projectService, stageService } = makeServices();
      const projectId = await createProject(projectService);
      const { stage } = await stageService.createStage(projectId, { id: uuid(), name: '关卡' });
      expect(stage.startedAt).toBeNull();
      const result = await stageService.setStageStatus(stage.id, {
        expectedVersion: stage.version,
        status: 'in_progress',
      });
      expect(result.startedAt).not.toBeNull();
      expect(result.completedAt).toBeNull();
    });

    it('ensures startedAt is non-null and writes completedAt when entering completed', async () => {
      const { projectService, stageService } = makeServices();
      const projectId = await createProject(projectService);
      const { stage } = await stageService.createStage(projectId, { id: uuid(), name: '关卡' });
      // 直接从 not_started 进入 completed：startedAt 应被补写
      const result = await stageService.setStageStatus(stage.id, {
        expectedVersion: stage.version,
        status: 'completed',
      });
      expect(result.startedAt).not.toBeNull();
      expect(result.completedAt).not.toBeNull();
      expect(result.status).toBe('completed');
    });

    it('clears completedAt when leaving completed but retains startedAt', async () => {
      const { projectService, stageService } = makeServices();
      const projectId = await createProject(projectService);
      const { stage } = await stageService.createStage(projectId, { id: uuid(), name: '关卡' });
      const completed = await stageService.setStageStatus(stage.id, {
        expectedVersion: stage.version,
        status: 'completed',
      });
      expect(completed.completedAt).not.toBeNull();
      const reopened = await stageService.setStageStatus(completed.id, {
        expectedVersion: completed.version,
        status: 'in_progress',
      });
      expect(reopened.completedAt).toBeNull();
      expect(reopened.startedAt).toBe(completed.startedAt);
    });

    it('does not bump version when status is set to the current value', async () => {
      const { projectService, stageService } = makeServices();
      const projectId = await createProject(projectService);
      const { stage } = await stageService.createStage(projectId, { id: uuid(), name: '关卡' });
      const result = await stageService.setStageStatus(stage.id, {
        expectedVersion: stage.version,
        status: 'not_started',
      });
      expect(result.version).toBe(stage.version);
      expect(result.updatedAt).toBe(stage.updatedAt);
    });

    it('throws StageNotFoundError for an unknown stage', async () => {
      const { stageService } = makeServices();
      await expect(
        stageService.setStageStatus(uuid(), { expectedVersion: 1, status: 'in_progress' }),
      ).rejects.toBeInstanceOf(StageNotFoundError);
    });

    it('throws StageVersionConflictError on a stale expectedVersion', async () => {
      const { projectService, stageService } = makeServices();
      const projectId = await createProject(projectService);
      const { stage } = await stageService.createStage(projectId, { id: uuid(), name: '关卡' });
      await stageService.setStageStatus(stage.id, {
        expectedVersion: stage.version,
        status: 'in_progress',
      });
      await expect(
        stageService.setStageStatus(stage.id, { expectedVersion: stage.version, status: 'blocked' }),
      ).rejects.toBeInstanceOf(StageVersionConflictError);
    });

    it('concurrent setStageStatus with the same expectedVersion: only one succeeds', async () => {
      const { projectService, stageService } = makeServices();
      const projectId = await createProject(projectService);
      const { stage } = await stageService.createStage(projectId, { id: uuid(), name: '关卡' });
      const results = await Promise.all(
        Array.from({ length: 20 }, () =>
          stageService
            .setStageStatus(stage.id, { expectedVersion: stage.version, status: 'completed' })
            .then(() => 'ok')
            .catch((e) => (e instanceof StageVersionConflictError ? 'conflict' : 'other')),
        ),
      );
      expect(results.filter((r) => r === 'ok')).toHaveLength(1);
      expect(results.filter((r) => r === 'conflict')).toHaveLength(19);
      const final = await stageService.getStage(stage.id);
      expect(final.version).toBe(stage.version + 1);
      expect(final.status).toBe('completed');
    });
  });

  describe('listStages', () => {
    it('returns all stages of a project ordered by position', async () => {
      const { projectService, stageService } = makeServices();
      const projectId = await createProject(projectService);
      const c = await stageService.createStage(projectId, { id: uuid(), name: 'C', position: 3 });
      const a = await stageService.createStage(projectId, { id: uuid(), name: 'A', position: 1 });
      await stageService.createStage(projectId, { id: uuid(), name: 'B', position: 2 });
      void c;
      void a;
      const stages = await stageService.listStages(projectId);
      expect(stages.map((s) => s.position)).toEqual([1, 2, 3]);
      expect(stages.map((s) => s.name)).toEqual(['A', 'B', 'C']);
    });

    it('returns an empty list for a project without stages', async () => {
      const { projectService, stageService } = makeServices();
      const projectId = await createProject(projectService);
      const stages = await stageService.listStages(projectId);
      expect(stages).toEqual([]);
    });

    it('throws ProjectNotFoundError for an unknown project instead of returning an empty list', async () => {
      const { stageService } = makeServices();
      await expect(stageService.listStages(uuid())).rejects.toBeInstanceOf(ProjectNotFoundError);
    });

    it('is read-only: listing stages does not change any stage version or timestamp', async () => {
      const { projectService, stageService } = makeServices();
      const projectId = await createProject(projectService);
      const { stage } = await stageService.createStage(projectId, { id: uuid(), name: 'S' });
      const before = await stageService.getStage(stage.id);
      await stageService.listStages(projectId);
      const after = await stageService.getStage(stage.id);
      expect(after).toEqual(before);
    });
  });
});
