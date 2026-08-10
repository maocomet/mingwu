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
    studySessionDetailService,
    studySessionCurrentService,
    studySummaryService,
  } = makeServices();
  const app = buildApp({
    config,
    projectService,
    stageService,
    taskService,
    projectStatusService,
    studySessionService,
    studySessionDetailService,
    studySessionCurrentService,
    studySummaryService,
  });
  return { app, projectService };
}

describe('Project API', () => {
  it('creates a project and returns 201', async () => {
    const { app } = setup();
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/projects',
      payload: { id: uuid(), name: 'Mingwu v0.1' },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.id).toBeTruthy();
    expect(body.name).toBe('Mingwu v0.1');
    expect(body.status).toBe('active');
    expect(body.version).toBe(1);
  });

  it('returns 200 with the same project on an idempotent retry', async () => {
    const { app } = setup();
    const payload = { id: uuid(), name: 'Mingwu v0.1' };
    const first = await app.inject({ method: 'POST', url: '/api/v1/projects', payload });
    const second = await app.inject({ method: 'POST', url: '/api/v1/projects', payload });
    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(200);
    expect(second.json().id).toBe(first.json().id);
    expect(second.json().version).toBe(first.json().version);
  });

  it('rejects a create without the required id or name', async () => {
    const { app } = setup();
    const noId = await app.inject({
      method: 'POST',
      url: '/api/v1/projects',
      payload: { name: 'x' },
    });
    expect(noId.statusCode).toBe(400);
    const noName = await app.inject({
      method: 'POST',
      url: '/api/v1/projects',
      payload: { id: uuid() },
    });
    expect(noName.statusCode).toBe(400);
  });

  it('rejects a create with a malformed id', async () => {
    const { app } = setup();
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/projects',
      payload: { id: 'not-a-uuid', name: 'x' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('rejects unknown fields in the create body', async () => {
    const { app } = setup();
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/projects',
      payload: { id: uuid(), name: 'x', unknownField: 1 },
    });
    expect(res.statusCode).toBe(400);
  });

  it('gets a project by id', async () => {
    const { app } = setup();
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/projects',
      payload: { id: uuid(), name: 'Mingwu v0.1' },
    });
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/projects/${created.json().id}`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().name).toBe('Mingwu v0.1');
  });

  it('returns 404 for an unknown project', async () => {
    const { app } = setup();
    const res = await app.inject({ method: 'GET', url: `/api/v1/projects/${uuid()}` });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe('project_not_found');
  });

  it('updates a project with a valid expectedVersion', async () => {
    const { app } = setup();
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/projects',
      payload: { id: uuid(), name: 'old' },
    });
    const project = created.json();
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/v1/projects/${project.id}`,
      payload: { expectedVersion: project.version, name: 'new', description: 'desc' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().name).toBe('new');
    expect(res.json().description).toBe('desc');
    expect(res.json().version).toBe(project.version + 1);
  });

  it('returns 409 on a stale expectedVersion', async () => {
    const { app } = setup();
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/projects',
      payload: { id: uuid(), name: 'x' },
    });
    const project = created.json();
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/v1/projects/${project.id}`,
      payload: { expectedVersion: project.version + 3, name: 'y' },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('project_version_conflict');
    expect(res.json().currentVersion).toBe(project.version);
  });

  it('returns 404 when patching an unknown project', async () => {
    const { app } = setup();
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/v1/projects/${uuid()}`,
      payload: { expectedVersion: 1, name: 'y' },
    });
    expect(res.statusCode).toBe(404);
  });

  it('rejects a patch with unknown fields', async () => {
    const { app } = setup();
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/projects',
      payload: { id: uuid(), name: 'x' },
    });
    const project = created.json();
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/v1/projects/${project.id}`,
      payload: { expectedVersion: project.version, bogus: true },
    });
    expect(res.statusCode).toBe(400);
  });

  it('returns 409 with a stable error code when the same id is reused with different content', async () => {
    const { app } = setup();
    const id = uuid();
    const first = await app.inject({
      method: 'POST',
      url: '/api/v1/projects',
      payload: { id, name: 'A' },
    });
    expect(first.statusCode).toBe(201);
    const second = await app.inject({
      method: 'POST',
      url: '/api/v1/projects',
      payload: { id, name: 'B' },
    });
    expect(second.statusCode).toBe(409);
    expect(second.json().error).toBe('project_idempotency_conflict');
  });

  it('concurrent POST with the same id and content: one 201, rest 200', async () => {
    const { app } = setup();
    const payload = { id: uuid(), name: 'same' };
    const results = await Promise.all(
      Array.from({ length: 20 }, () =>
        app.inject({ method: 'POST', url: '/api/v1/projects', payload }),
      ),
    );
    const codes = results.map((r) => r.statusCode);
    expect(codes.filter((c) => c === 201)).toHaveLength(1);
    expect(codes.filter((c) => c === 200)).toHaveLength(19);
  });

  it('concurrent PATCH with the same expectedVersion: one 200, rest 409', async () => {
    const { app } = setup();
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/projects',
      payload: { id: uuid(), name: 'x' },
    });
    const project = created.json();
    const results = await Promise.all(
      Array.from({ length: 20 }, () =>
        app.inject({
          method: 'PATCH',
          url: `/api/v1/projects/${project.id}`,
          payload: { expectedVersion: project.version, name: 'new' },
        }),
      ),
    );
    const codes = results.map((r) => r.statusCode);
    expect(codes.filter((c) => c === 200)).toHaveLength(1);
    expect(codes.filter((c) => c === 409)).toHaveLength(19);
  });
});
