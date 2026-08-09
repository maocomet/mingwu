import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { makeServices, uuid } from './helpers.js';

function setup() {
  const config = loadConfig({ NODE_ENV: 'test' });
  const { projectService, stageService } = makeServices();
  const app = buildApp({ config, projectService, stageService });
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

  it('builds a progress tree with the project and stages sorted by position', async () => {
    const { app } = setup();
    const projectId = await createProject(app);
    await app.inject({
      method: 'POST',
      url: `/api/v1/projects/${projectId}/stages`,
      payload: { id: uuid(), name: 'B' },
    });
    await app.inject({
      method: 'POST',
      url: `/api/v1/projects/${projectId}/stages`,
      payload: { id: uuid(), name: 'A' },
    });
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/projects/${projectId}/progress-tree`,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.project.id).toBe(projectId);
    expect(body.stages.map((s: { name: string }) => s.name)).toEqual(['B', 'A']);
  });

  it('returns 404 for the progress tree of an unknown project', async () => {
    const { app } = setup();
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/projects/${uuid()}/progress-tree`,
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe('project_not_found');
  });

  it('rejects a malformed projectId in the URL', async () => {
    const { app } = setup();
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/projects/not-a-uuid/progress-tree',
    });
    expect(res.statusCode).toBe(400);
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
});
