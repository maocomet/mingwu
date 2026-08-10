import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { makeServices, makeTask, uuid } from './helpers.js';

type App = ReturnType<typeof buildApp>;

function setup() {
  const config = loadConfig({ NODE_ENV: 'test' });
  const {
    projectService,
    stageService,
    taskService,
    taskRepository,
    projectStatusService,
    studySessionService,
  } = makeServices();
  const app = buildApp({
    config,
    projectService,
    stageService,
    taskService,
    projectStatusService,
    studySessionService,
  });
  return { app, taskRepository };
}

async function createProject(app: App): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/projects',
    payload: { id: uuid(), name: 'Mingwu v0.1' },
  });
  return res.json().id;
}

async function createStage(app: App, projectId: string): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: `/api/v1/projects/${projectId}/stages`,
    payload: { id: uuid(), name: '第一关' },
  });
  return res.json().id;
}

describe('ProjectTask API', () => {
  it('creates a main task and returns 201', async () => {
    const { app } = setup();
    const projectId = await createProject(app);
    const stageId = await createStage(app, projectId);
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/projects/${projectId}/stages/${stageId}/tasks`,
      payload: { id: uuid(), title: '主任务' },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.stageId).toBe(stageId);
    expect(body.projectId).toBe(projectId);
    expect(body.parentTaskId).toBeNull();
    expect(body.status).toBe('not_started');
    expect(body.position).toBe(1);
    expect(body.version).toBe(1);
  });

  it('creates a sub-task under a parent task', async () => {
    const { app } = setup();
    const projectId = await createProject(app);
    const stageId = await createStage(app, projectId);
    const parent = await app.inject({
      method: 'POST',
      url: `/api/v1/projects/${projectId}/stages/${stageId}/tasks`,
      payload: { id: uuid(), title: '父任务' },
    });
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/projects/${projectId}/stages/${stageId}/tasks`,
      payload: { id: uuid(), title: '分任务', parentTaskId: parent.json().id },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().parentTaskId).toBe(parent.json().id);
  });

  it('returns 200 with the same task on an idempotent retry', async () => {
    const { app } = setup();
    const projectId = await createProject(app);
    const stageId = await createStage(app, projectId);
    const payload = { id: uuid(), title: '任务' };
    const first = await app.inject({
      method: 'POST',
      url: `/api/v1/projects/${projectId}/stages/${stageId}/tasks`,
      payload,
    });
    const second = await app.inject({
      method: 'POST',
      url: `/api/v1/projects/${projectId}/stages/${stageId}/tasks`,
      payload,
    });
    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(200);
    expect(second.json().id).toBe(first.json().id);
  });

  it('returns 404 when the stage does not exist', async () => {
    const { app } = setup();
    const projectId = await createProject(app);
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/projects/${projectId}/stages/${uuid()}/tasks`,
      payload: { id: uuid(), title: 'X' },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe('stage_not_found');
  });

  it('returns 409 scope conflict when the stage belongs to another project', async () => {
    const { app } = setup();
    const projectA = await createProject(app);
    const stageInA = await createStage(app, projectA);
    const projectB = await createProject(app);
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/projects/${projectB}/stages/${stageInA}/tasks`,
      payload: { id: uuid(), title: 'X' },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('project_task_scope_conflict');
  });

  it('returns 404 parent_task_not_found for an unknown parent', async () => {
    const { app } = setup();
    const projectId = await createProject(app);
    const stageId = await createStage(app, projectId);
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/projects/${projectId}/stages/${stageId}/tasks`,
      payload: { id: uuid(), title: 'X', parentTaskId: uuid() },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe('parent_task_not_found');
  });

  it('returns 409 scope conflict for a parent task in another stage', async () => {
    const { app } = setup();
    const projectId = await createProject(app);
    const stageA = await createStage(app, projectId);
    const stageB = await createStage(app, projectId);
    const parent = await app.inject({
      method: 'POST',
      url: `/api/v1/projects/${projectId}/stages/${stageA}/tasks`,
      payload: { id: uuid(), title: '父任务' },
    });
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/projects/${projectId}/stages/${stageB}/tasks`,
      payload: { id: uuid(), title: 'X', parentTaskId: parent.json().id },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('project_task_scope_conflict');
  });

  it('rejects a task create without a title', async () => {
    const { app } = setup();
    const projectId = await createProject(app);
    const stageId = await createStage(app, projectId);
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/projects/${projectId}/stages/${stageId}/tasks`,
      payload: { id: uuid() },
    });
    expect(res.statusCode).toBe(400);
  });

  it('rejects unknown fields in the task create body', async () => {
    const { app } = setup();
    const projectId = await createProject(app);
    const stageId = await createStage(app, projectId);
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/projects/${projectId}/stages/${stageId}/tasks`,
      payload: { id: uuid(), title: 'X', bogus: 1 },
    });
    expect(res.statusCode).toBe(400);
  });

  it('returns 409 idempotency conflict when the same id is reused with different content', async () => {
    const { app } = setup();
    const projectId = await createProject(app);
    const stageId = await createStage(app, projectId);
    const id = uuid();
    const first = await app.inject({
      method: 'POST',
      url: `/api/v1/projects/${projectId}/stages/${stageId}/tasks`,
      payload: { id, title: 'A' },
    });
    expect(first.statusCode).toBe(201);
    const second = await app.inject({
      method: 'POST',
      url: `/api/v1/projects/${projectId}/stages/${stageId}/tasks`,
      payload: { id, title: 'B' },
    });
    expect(second.statusCode).toBe(409);
    expect(second.json().error).toBe('project_task_idempotency_conflict');
  });

  it('returns 409 position conflict when a sibling takes the same explicit position', async () => {
    const { app } = setup();
    const projectId = await createProject(app);
    const stageId = await createStage(app, projectId);
    const first = await app.inject({
      method: 'POST',
      url: `/api/v1/projects/${projectId}/stages/${stageId}/tasks`,
      payload: { id: uuid(), title: 'A', position: 3 },
    });
    expect(first.statusCode).toBe(201);
    const second = await app.inject({
      method: 'POST',
      url: `/api/v1/projects/${projectId}/stages/${stageId}/tasks`,
      payload: { id: uuid(), title: 'B', position: 3 },
    });
    expect(second.statusCode).toBe(409);
    expect(second.json().error).toBe('project_task_position_conflict');
  });

  it('gets a task by id', async () => {
    const { app } = setup();
    const projectId = await createProject(app);
    const stageId = await createStage(app, projectId);
    const created = await app.inject({
      method: 'POST',
      url: `/api/v1/projects/${projectId}/stages/${stageId}/tasks`,
      payload: { id: uuid(), title: '任务' },
    });
    const res = await app.inject({ method: 'GET', url: `/api/v1/tasks/${created.json().id}` });
    expect(res.statusCode).toBe(200);
    expect(res.json().title).toBe('任务');
  });

  it('returns 404 for an unknown task', async () => {
    const { app } = setup();
    const res = await app.inject({ method: 'GET', url: `/api/v1/tasks/${uuid()}` });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe('project_task_not_found');
  });

  it('returns a full progress tree with nested tasks sorted by position', async () => {
    const { app } = setup();
    const projectId = await createProject(app);
    const stageId = await createStage(app, projectId);
    const parent = await app.inject({
      method: 'POST',
      url: `/api/v1/projects/${projectId}/stages/${stageId}/tasks`,
      payload: { id: uuid(), title: 'B', position: 2 },
    });
    const child = await app.inject({
      method: 'POST',
      url: `/api/v1/projects/${projectId}/stages/${stageId}/tasks`,
      payload: { id: uuid(), title: 'child2', parentTaskId: parent.json().id, position: 2 },
    });
    await app.inject({
      method: 'POST',
      url: `/api/v1/projects/${projectId}/stages/${stageId}/tasks`,
      payload: { id: uuid(), title: 'A', position: 1 },
    });
    await app.inject({
      method: 'POST',
      url: `/api/v1/projects/${projectId}/stages/${stageId}/tasks`,
      payload: { id: uuid(), title: 'child1', parentTaskId: parent.json().id, position: 1 },
    });
    await app.inject({
      method: 'POST',
      url: `/api/v1/projects/${projectId}/stages/${stageId}/tasks`,
      payload: { id: uuid(), title: 'grand', parentTaskId: child.json().id },
    });

    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/projects/${projectId}/progress-tree`,
    });
    expect(res.statusCode).toBe(200);
    const stage = res.json().stages[0];
    expect(stage.id).toBe(stageId);
    expect(stage.tasks.map((t: { title: string }) => t.title)).toEqual(['A', 'B']);
    const [b] = stage.tasks.filter((t: { title: string }) => t.title === 'B');
    expect(b.children.map((t: { title: string }) => t.title)).toEqual(['child1', 'child2']);
    const [, c2] = b.children;
    expect(c2.children.map((t: { title: string }) => t.title)).toEqual(['grand']);
  });

  it('returns an empty stage list for a project with no stages', async () => {
    const { app } = setup();
    const projectId = await createProject(app);
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/projects/${projectId}/progress-tree`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().stages).toEqual([]);
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

  it('rejects a malformed projectId in the progress tree URL', async () => {
    const { app } = setup();
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/projects/not-a-uuid/progress-tree',
    });
    expect(res.statusCode).toBe(400);
  });

  it('returns 500 with a stable code and no internal ids for a corrupted task tree', async () => {
    const { app, taskRepository } = setup();
    const projectId = await createProject(app);
    const stageId = await createStage(app, projectId);
    // 直接向仓储注入脏数据（孤儿父引用），绕过创建服务的归属校验。
    const orphanId = uuid();
    await taskRepository.createIfAbsent(
      makeTask({ id: orphanId, projectId, stageId, parentTaskId: uuid(), title: '孤儿分任务' }),
    );
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/projects/${projectId}/progress-tree`,
    });
    expect(res.statusCode).toBe(500);
    const body = res.json();
    expect(body.error).toBe('project_task_tree_corrupt');
    // 不泄露内部数据：响应不得包含被污染的孤儿任务 id。
    expect(JSON.stringify(body)).not.toContain(orphanId);
  });

  it('concurrent POST with the same task id and content: one 201, rest 200', async () => {
    const { app } = setup();
    const projectId = await createProject(app);
    const stageId = await createStage(app, projectId);
    const payload = { id: uuid(), title: 'same' };
    const results = await Promise.all(
      Array.from({ length: 20 }, () =>
        app.inject({
          method: 'POST',
          url: `/api/v1/projects/${projectId}/stages/${stageId}/tasks`,
          payload,
        }),
      ),
    );
    const codes = results.map((r) => r.statusCode);
    expect(codes.filter((c) => c === 201)).toHaveLength(1);
    expect(codes.filter((c) => c === 200)).toHaveLength(19);
  });

  it('concurrent auto-position POST with distinct ids: all 201 and positions become 1..20', async () => {
    const { app } = setup();
    const projectId = await createProject(app);
    const stageId = await createStage(app, projectId);
    const results = await Promise.all(
      Array.from({ length: 20 }, () =>
        app.inject({
          method: 'POST',
          url: `/api/v1/projects/${projectId}/stages/${stageId}/tasks`,
          payload: { id: uuid(), title: 'auto' },
        }),
      ),
    );
    expect(results.every((r) => r.statusCode === 201)).toBe(true);
    const tree = await app.inject({
      method: 'GET',
      url: `/api/v1/projects/${projectId}/progress-tree`,
    });
    const positions = tree
      .json()
      .stages[0].tasks.map((t: { position: number }) => t.position)
      .sort((a: number, b: number) => a - b);
    expect(positions).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
  });
});
