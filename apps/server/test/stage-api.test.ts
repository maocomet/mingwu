import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { makeServices, uuid } from './helpers.js';

function setup() {
  const config = loadConfig({ NODE_ENV: 'test' });
  const {
    projectService,
    stageService,
    taskService,
    projectStatusService,
    studySessionService,
    studySummaryService,
  } = makeServices();
  const app = buildApp({
    config,
    projectService,
    stageService,
    taskService,
    projectStatusService,
    studySessionService,
    studySummaryService,
  });
  return { app, projectService };
}

async function createProject(app: ReturnType<typeof setup>['app']): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/projects',
    payload: { id: uuid(), name: 'Mingwu v0.1' },
  });
  return res.json().id;
}

async function createStage(
  app: ReturnType<typeof setup>['app'],
  projectId: string,
  payload: Record<string, unknown> = {},
): Promise<{ id: string; version: number }> {
  const res = await app.inject({
    method: 'POST',
    url: `/api/v1/projects/${projectId}/stages`,
    payload: { id: uuid(), name: '第一关', ...payload },
  });
  expect(res.statusCode).toBe(201);
  return { id: res.json().id, version: res.json().version };
}

describe('Stage API', () => {
  it('creates a stage under a project and returns 201', async () => {
    const { app } = setup();
    const projectId = await createProject(app);
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/projects/${projectId}/stages`,
      payload: { id: uuid(), name: '第一关', position: 1 },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.projectId).toBe(projectId);
    expect(body.name).toBe('第一关');
    expect(body.position).toBe(1);
    expect(body.status).toBe('not_started');
    expect(body.version).toBe(1);
  });

  it('returns 200 with the same stage on an idempotent retry', async () => {
    const { app } = setup();
    const projectId = await createProject(app);
    const payload = { id: uuid(), name: '第一关' };
    const first = await app.inject({
      method: 'POST',
      url: `/api/v1/projects/${projectId}/stages`,
      payload,
    });
    const second = await app.inject({
      method: 'POST',
      url: `/api/v1/projects/${projectId}/stages`,
      payload,
    });
    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(200);
    expect(second.json().id).toBe(first.json().id);
    expect(second.json().position).toBe(first.json().position);
  });

  it('returns 404 when creating a stage under an unknown project', async () => {
    const { app } = setup();
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/projects/${uuid()}/stages`,
      payload: { id: uuid(), name: 'X' },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe('project_not_found');
  });

  it('rejects a stage create without a name', async () => {
    const { app } = setup();
    const projectId = await createProject(app);
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/projects/${projectId}/stages`,
      payload: { id: uuid() },
    });
    expect(res.statusCode).toBe(400);
  });

  it('rejects unknown fields in the stage create body', async () => {
    const { app } = setup();
    const projectId = await createProject(app);
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/projects/${projectId}/stages`,
      payload: { id: uuid(), name: 'X', bogus: 1 },
    });
    expect(res.statusCode).toBe(400);
  });

  it('returns 409 with a stable error code when the same stage id is reused with different content', async () => {
    const { app } = setup();
    const projectId = await createProject(app);
    const id = uuid();
    const first = await app.inject({
      method: 'POST',
      url: `/api/v1/projects/${projectId}/stages`,
      payload: { id, name: 'A' },
    });
    expect(first.statusCode).toBe(201);
    const second = await app.inject({
      method: 'POST',
      url: `/api/v1/projects/${projectId}/stages`,
      payload: { id, name: 'B' },
    });
    expect(second.statusCode).toBe(409);
    expect(second.json().error).toBe('stage_idempotency_conflict');
  });

  it('returns 409 stage_position_conflict when another stage takes the same position', async () => {
    const { app } = setup();
    const projectId = await createProject(app);
    const first = await app.inject({
      method: 'POST',
      url: `/api/v1/projects/${projectId}/stages`,
      payload: { id: uuid(), name: 'A', position: 3 },
    });
    expect(first.statusCode).toBe(201);
    const second = await app.inject({
      method: 'POST',
      url: `/api/v1/projects/${projectId}/stages`,
      payload: { id: uuid(), name: 'B', position: 3 },
    });
    expect(second.statusCode).toBe(409);
    expect(second.json().error).toBe('stage_position_conflict');
  });

  it('gets a stage by id', async () => {
    const { app } = setup();
    const projectId = await createProject(app);
    const created = await app.inject({
      method: 'POST',
      url: `/api/v1/projects/${projectId}/stages`,
      payload: { id: uuid(), name: '第一关' },
    });
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/stages/${created.json().id}`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().name).toBe('第一关');
  });

  it('returns 404 for an unknown stage', async () => {
    const { app } = setup();
    const res = await app.inject({ method: 'GET', url: `/api/v1/stages/${uuid()}` });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe('stage_not_found');
  });

  it('concurrent POST with the same stage id and content: one 201, rest 200', async () => {
    const { app } = setup();
    const projectId = await createProject(app);
    const payload = { id: uuid(), name: 'same' };
    const results = await Promise.all(
      Array.from({ length: 20 }, () =>
        app.inject({
          method: 'POST',
          url: `/api/v1/projects/${projectId}/stages`,
          payload,
        }),
      ),
    );
    const codes = results.map((r) => r.statusCode);
    expect(codes.filter((c) => c === 201)).toHaveLength(1);
    expect(codes.filter((c) => c === 200)).toHaveLength(19);
  });

  it('concurrent POST with the same position but different ids: one 201, rest 409', async () => {
    const { app } = setup();
    const projectId = await createProject(app);
    const results = await Promise.all(
      Array.from({ length: 20 }, () =>
        app.inject({
          method: 'POST',
          url: `/api/v1/projects/${projectId}/stages`,
          payload: { id: uuid(), name: 'x', position: 5 },
        }),
      ),
    );
    const codes = results.map((r) => r.statusCode);
    expect(codes.filter((c) => c === 201)).toHaveLength(1);
    expect(codes.filter((c) => c === 409)).toHaveLength(19);
  });

  it('concurrent auto-position POST with distinct ids: all 201 and positions become 1..20', async () => {
    const { app } = setup();
    const projectId = await createProject(app);
    const results = await Promise.all(
      Array.from({ length: 20 }, () =>
        app.inject({
          method: 'POST',
          url: `/api/v1/projects/${projectId}/stages`,
          payload: { id: uuid(), name: 'auto' },
        }),
      ),
    );
    expect(results.every((r) => r.statusCode === 201)).toBe(true);
    const tree = await app.inject({
      method: 'GET',
      url: `/api/v1/projects/${projectId}/progress-tree`,
    });
    expect(tree.statusCode).toBe(200);
    const positions = tree
      .json()
      .stages.map((s: { position: number }) => s.position)
      .sort((a: number, b: number) => a - b);
    expect(positions).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
  });

  describe('PATCH /api/v1/stages/:id', () => {
    it('modifies metadata, bumps version and refreshes updatedAt while keeping other fields', async () => {
      const { app } = setup();
      const projectId = await createProject(app);
      const { id, version } = await createStage(app, projectId, {
        name: '旧名',
        description: '旧描述',
        completionCriteria: '旧条件',
        position: 1,
      });
      const res = await app.inject({
        method: 'PATCH',
        url: `/api/v1/stages/${id}`,
        payload: { expectedVersion: version, name: '新名', completionCriteria: '新条件' },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.name).toBe('新名');
      expect(body.description).toBe('旧描述');
      expect(body.completionCriteria).toBe('新条件');
      expect(body.position).toBe(1);
      expect(body.version).toBe(version + 1);
      expect(body.updatedAt > body.createdAt).toBe(true);
    });

    it('clears a nullable field when set to null', async () => {
      const { app } = setup();
      const projectId = await createProject(app);
      const { id, version } = await createStage(app, projectId, { description: '要清空' });
      const res = await app.inject({
        method: 'PATCH',
        url: `/api/v1/stages/${id}`,
        payload: { expectedVersion: version, description: null },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().description).toBeNull();
    });

    it('returns 400 for an empty body without expectedVersion', async () => {
      const { app } = setup();
      const projectId = await createProject(app);
      const { id } = await createStage(app, projectId);
      const res = await app.inject({ method: 'PATCH', url: `/api/v1/stages/${id}`, payload: {} });
      expect(res.statusCode).toBe(400);
    });

    it('returns 400 for a body with only expectedVersion and no modifiable field', async () => {
      const { app } = setup();
      const projectId = await createProject(app);
      const { id, version } = await createStage(app, projectId);
      const res = await app.inject({
        method: 'PATCH',
        url: `/api/v1/stages/${id}`,
        payload: { expectedVersion: version },
      });
      expect(res.statusCode).toBe(400);
    });

    it('returns 400 for unknown fields (cannot inject protected fields)', async () => {
      const { app } = setup();
      const projectId = await createProject(app);
      const { id, version } = await createStage(app, projectId);
      const res = await app.inject({
        method: 'PATCH',
        url: `/api/v1/stages/${id}`,
        payload: { expectedVersion: version, name: 'A', projectId: uuid() },
      });
      expect(res.statusCode).toBe(400);
    });

    it('returns 400 for a forged identity field (actorId / status / version)', async () => {
      const { app } = setup();
      const projectId = await createProject(app);
      const { id, version } = await createStage(app, projectId);
      for (const forged of [
        { actorId: 'forged-actor' },
        { status: 'completed' },
        { version: 999 },
        { startedAt: '2099-01-01T00:00:00.000Z' },
      ]) {
        const res = await app.inject({
          method: 'PATCH',
          url: `/api/v1/stages/${id}`,
          payload: { expectedVersion: version, ...forged },
        });
        expect(res.statusCode).toBe(400);
      }
    });

    it('returns 400 for an empty name', async () => {
      const { app } = setup();
      const projectId = await createProject(app);
      const { id, version } = await createStage(app, projectId);
      const res = await app.inject({
        method: 'PATCH',
        url: `/api/v1/stages/${id}`,
        payload: { expectedVersion: version, name: '' },
      });
      expect(res.statusCode).toBe(400);
    });

    it('returns 400 for an invalid position', async () => {
      const { app } = setup();
      const projectId = await createProject(app);
      const { id, version } = await createStage(app, projectId);
      for (const position of [0, -1, 1.5]) {
        const res = await app.inject({
          method: 'PATCH',
          url: `/api/v1/stages/${id}`,
          payload: { expectedVersion: version, position },
        });
        expect(res.statusCode).toBe(400);
      }
    });

    it('returns 400 for an invalid UUID in the path', async () => {
      const { app } = setup();
      const res = await app.inject({
        method: 'PATCH',
        url: '/api/v1/stages/not-a-uuid',
        payload: { expectedVersion: 1, name: 'X' },
      });
      expect(res.statusCode).toBe(400);
    });

    it('returns 404 for an unknown stage', async () => {
      const { app } = setup();
      const res = await app.inject({
        method: 'PATCH',
        url: `/api/v1/stages/${uuid()}`,
        payload: { expectedVersion: 1, name: 'X' },
      });
      expect(res.statusCode).toBe(404);
      expect(res.json().error).toBe('stage_not_found');
    });

    it('returns 409 stage_version_conflict on a stale expectedVersion', async () => {
      const { app } = setup();
      const projectId = await createProject(app);
      const { id, version } = await createStage(app, projectId);
      await app.inject({
        method: 'PATCH',
        url: `/api/v1/stages/${id}`,
        payload: { expectedVersion: version, name: 'B' },
      });
      const res = await app.inject({
        method: 'PATCH',
        url: `/api/v1/stages/${id}`,
        payload: { expectedVersion: version, name: 'C' },
      });
      expect(res.statusCode).toBe(409);
      expect(res.json().error).toBe('stage_version_conflict');
    });

    it('returns 409 stage_position_conflict when the target position is taken', async () => {
      const { app } = setup();
      const projectId = await createProject(app);
      const { id, version } = await createStage(app, projectId, { position: 1 });
      await createStage(app, projectId, { name: 'B', position: 2 });
      const res = await app.inject({
        method: 'PATCH',
        url: `/api/v1/stages/${id}`,
        payload: { expectedVersion: version, position: 2 },
      });
      expect(res.statusCode).toBe(409);
      expect(res.json().error).toBe('stage_position_conflict');
    });

    it('concurrent PATCH with the same expectedVersion: one 200, rest 409', async () => {
      const { app } = setup();
      const projectId = await createProject(app);
      const { id, version } = await createStage(app, projectId);
      const results = await Promise.all(
        Array.from({ length: 20 }, () =>
          app.inject({
            method: 'PATCH',
            url: `/api/v1/stages/${id}`,
            payload: { expectedVersion: version, name: '并发' },
          }),
        ),
      );
      const codes = results.map((r) => r.statusCode);
      expect(codes.filter((c) => c === 200)).toHaveLength(1);
      expect(codes.filter((c) => c === 409)).toHaveLength(19);
    });
  });

  describe('PATCH /api/v1/stages/:id/status', () => {
    it('accepts each of the seven legal statuses', async () => {
      const { app } = setup();
      const projectId = await createProject(app);
      const { id, version } = await createStage(app, projectId);
      const statuses = ['locked', 'not_started', 'in_progress', 'pending_review', 'needs_changes', 'blocked', 'completed'];
      let currentVersion = version;
      for (const status of statuses) {
        if (status === 'not_started') continue;
        const res = await app.inject({
          method: 'PATCH',
          url: `/api/v1/stages/${id}/status`,
          payload: { expectedVersion: currentVersion, status },
        });
        expect(res.statusCode).toBe(200);
        expect(res.json().status).toBe(status);
        currentVersion = res.json().version;
      }
    });

    it('writes startedAt on first entry into in_progress and completedAt on completed', async () => {
      const { app } = setup();
      const projectId = await createProject(app);
      const { id, version } = await createStage(app, projectId);
      const inProgress = await app.inject({
        method: 'PATCH',
        url: `/api/v1/stages/${id}/status`,
        payload: { expectedVersion: version, status: 'in_progress' },
      });
      expect(inProgress.statusCode).toBe(200);
      expect(inProgress.json().startedAt).not.toBeNull();
      expect(inProgress.json().completedAt).toBeNull();
      const completed = await app.inject({
        method: 'PATCH',
        url: `/api/v1/stages/${id}/status`,
        payload: { expectedVersion: inProgress.json().version, status: 'completed' },
      });
      expect(completed.statusCode).toBe(200);
      expect(completed.json().startedAt).not.toBeNull();
      expect(completed.json().completedAt).not.toBeNull();
    });

    it('clears completedAt when leaving completed but retains startedAt', async () => {
      const { app } = setup();
      const projectId = await createProject(app);
      const { id, version } = await createStage(app, projectId);
      const completed = await app.inject({
        method: 'PATCH',
        url: `/api/v1/stages/${id}/status`,
        payload: { expectedVersion: version, status: 'completed' },
      });
      const startedAt = completed.json().startedAt;
      expect(completed.json().completedAt).not.toBeNull();
      const reopened = await app.inject({
        method: 'PATCH',
        url: `/api/v1/stages/${id}/status`,
        payload: { expectedVersion: completed.json().version, status: 'in_progress' },
      });
      expect(reopened.statusCode).toBe(200);
      expect(reopened.json().completedAt).toBeNull();
      expect(reopened.json().startedAt).toBe(startedAt);
    });

    it('does not bump version when the status is unchanged', async () => {
      const { app } = setup();
      const projectId = await createProject(app);
      const { id, version } = await createStage(app, projectId);
      const res = await app.inject({
        method: 'PATCH',
        url: `/api/v1/stages/${id}/status`,
        payload: { expectedVersion: version, status: 'not_started' },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().version).toBe(version);
    });

    it('returns 400 for an unknown status', async () => {
      const { app } = setup();
      const projectId = await createProject(app);
      const { id, version } = await createStage(app, projectId);
      const res = await app.inject({
        method: 'PATCH',
        url: `/api/v1/stages/${id}/status`,
        payload: { expectedVersion: version, status: 'done' },
      });
      expect(res.statusCode).toBe(400);
    });

    it('returns 400 for an empty body or a missing status', async () => {
      const { app } = setup();
      const projectId = await createProject(app);
      const { id } = await createStage(app, projectId);
      for (const payload of [{}, { status: 'in_progress' }, { expectedVersion: 1 }]) {
        const res = await app.inject({
          method: 'PATCH',
          url: `/api/v1/stages/${id}/status`,
          payload,
        });
        expect(res.statusCode).toBe(400);
      }
    });

    it('returns 400 for unknown fields including forged identity', async () => {
      const { app } = setup();
      const projectId = await createProject(app);
      const { id, version } = await createStage(app, projectId);
      for (const forged of [{ actorId: 'x' }, { startedAt: '2099-01-01T00:00:00.000Z' }, { completedAt: '2099-01-01T00:00:00.000Z' }]) {
        const res = await app.inject({
          method: 'PATCH',
          url: `/api/v1/stages/${id}/status`,
          payload: { expectedVersion: version, status: 'in_progress', ...forged },
        });
        expect(res.statusCode).toBe(400);
      }
    });

    it('returns 404 for an unknown stage', async () => {
      const { app } = setup();
      const res = await app.inject({
        method: 'PATCH',
        url: `/api/v1/stages/${uuid()}/status`,
        payload: { expectedVersion: 1, status: 'in_progress' },
      });
      expect(res.statusCode).toBe(404);
      expect(res.json().error).toBe('stage_not_found');
    });

    it('returns 409 stage_version_conflict on a stale expectedVersion', async () => {
      const { app } = setup();
      const projectId = await createProject(app);
      const { id, version } = await createStage(app, projectId);
      await app.inject({
        method: 'PATCH',
        url: `/api/v1/stages/${id}/status`,
        payload: { expectedVersion: version, status: 'in_progress' },
      });
      const res = await app.inject({
        method: 'PATCH',
        url: `/api/v1/stages/${id}/status`,
        payload: { expectedVersion: version, status: 'blocked' },
      });
      expect(res.statusCode).toBe(409);
      expect(res.json().error).toBe('stage_version_conflict');
    });

    it('concurrent status PATCH with the same expectedVersion: one 200, rest 409', async () => {
      const { app } = setup();
      const projectId = await createProject(app);
      const { id, version } = await createStage(app, projectId);
      const results = await Promise.all(
        Array.from({ length: 20 }, () =>
          app.inject({
            method: 'PATCH',
            url: `/api/v1/stages/${id}/status`,
            payload: { expectedVersion: version, status: 'completed' },
          }),
        ),
      );
      const codes = results.map((r) => r.statusCode);
      expect(codes.filter((c) => c === 200)).toHaveLength(1);
      expect(codes.filter((c) => c === 409)).toHaveLength(19);
    });
  });
});
