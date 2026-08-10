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
    studySessionDetailService,
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
    studySummaryService,
  });
  return { app, taskRepository };
}

async function createProject(app: App): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/projects',
    payload: { id: uuid(), name: 'Mingwu v0.1' },
  });
  expect(res.statusCode).toBe(201);
  return res.json().id;
}

async function createStage(
  app: App,
  projectId: string,
  overrides: { name?: string; position?: number } = {},
): Promise<{ id: string; version: number }> {
  const res = await app.inject({
    method: 'POST',
    url: `/api/v1/projects/${projectId}/stages`,
    payload: { id: uuid(), name: overrides.name ?? '第一关', position: overrides.position },
  });
  expect(res.statusCode).toBe(201);
  return { id: res.json().id, version: res.json().version };
}

async function setStageStatus(
  app: App,
  stageId: string,
  expectedVersion: number,
  status: string,
): Promise<number> {
  const res = await app.inject({
    method: 'PATCH',
    url: `/api/v1/stages/${stageId}/status`,
    payload: { expectedVersion, status },
  });
  expect(res.statusCode).toBe(200);
  return res.json().version;
}

describe('GET /api/v1/projects/:projectId/status', () => {
  it('returns the full zeroed shape for an empty project', async () => {
    const { app } = setup();
    const projectId = await createProject(app);
    const res = await app.inject({ method: 'GET', url: `/api/v1/projects/${projectId}/status` });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.project).toEqual({ id: projectId, name: 'Mingwu v0.1', status: 'active', version: 1 });
    expect(body.currentStage).toBeNull();
    expect(body.overallProgressPercent).toBe(0);
    expect(body.activeTasks).toEqual([]);
    // byStatus 必须包含完整枚举键，即使计数为 0。
    expect(Object.keys(body.stageSummary.byStatus).sort()).toEqual([
      'blocked',
      'completed',
      'in_progress',
      'locked',
      'needs_changes',
      'not_started',
      'pending_review',
    ]);
    expect(Object.keys(body.taskSummary.byStatus).sort()).toEqual([
      'blocked',
      'completed',
      'in_progress',
      'needs_changes',
      'not_started',
      'pending_review',
    ]);
  });

  it('reflects stage and task data with currentStage and progress', async () => {
    const { app } = setup();
    const projectId = await createProject(app);
    const stage = await createStage(app, projectId, { name: '第一关', position: 1 });
    await setStageStatus(app, stage.id, stage.version, 'in_progress');

    // 创建主任务 + 分任务
    const t1 = await app.inject({
      method: 'POST',
      url: `/api/v1/projects/${projectId}/stages/${stage.id}/tasks`,
      payload: { id: uuid(), title: 'T1', position: 1 },
    });
    const t1Body = t1.json();
    const t1s = await app.inject({
      method: 'POST',
      url: `/api/v1/projects/${projectId}/stages/${stage.id}/tasks`,
      payload: { id: uuid(), title: 'T1s', parentTaskId: t1Body.id, position: 1 },
    });
    expect(t1s.statusCode).toBe(201);

    const res = await app.inject({ method: 'GET', url: `/api/v1/projects/${projectId}/status` });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.currentStage?.id).toBe(stage.id);
    expect(body.currentStage?.status).toBe('in_progress');
    expect(body.stageSummary.total).toBe(1);
    expect(body.taskSummary.total).toBe(2);
    expect(body.taskSummary.byStatus.not_started).toBe(2);
    // 有正式任务但 0 完成 → 任务进度 0%
    expect(body.overallProgressPercent).toBe(0);
  });

  it('returns 404 for an unknown project', async () => {
    const { app } = setup();
    const res = await app.inject({ method: 'GET', url: `/api/v1/projects/${uuid()}/status` });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe('project_not_found');
  });

  it('returns 400 for an invalid project UUID', async () => {
    const { app } = setup();
    const res = await app.inject({ method: 'GET', url: '/api/v1/projects/not-a-uuid/status' });
    expect(res.statusCode).toBe(400);
  });

  it('ignores a GET request body instead of treating it as semantics', async () => {
    const { app } = setup();
    const projectId = await createProject(app);
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/projects/${projectId}/status`,
      payload: { actorId: 'forged', status: 'completed', bogus: true },
    });
    // 请求体不得注入身份或影响只读聚合：要么被忽略返回 200，要么被拒绝 400。
    // 关键是不返回被"伪造"的数据。
    expect([200, 400]).toContain(res.statusCode);
    if (res.statusCode === 200) {
      const body = res.json();
      expect(body.project.status).toBe('active');
      expect(body.stageSummary.total).toBe(0);
    }
  });

  it('returns a controlled 500 without leaking internal ids on task.projectId mismatch', async () => {
    const { app, taskRepository } = setup();
    const projectId = await createProject(app);
    const stage = await createStage(app, projectId, { position: 1 });

    const otherProjectId = uuid();
    const dirtyId = uuid();
    await taskRepository.createIfAbsent(
      makeTask({ id: dirtyId, projectId: otherProjectId, stageId: stage.id, position: 1 }),
    );

    const res = await app.inject({ method: 'GET', url: `/api/v1/projects/${projectId}/status` });
    expect(res.statusCode).toBe(500);
    const body = res.json();
    expect(body.error).toBe('project_task_tree_corrupt');
    // 受控文案，不泄露内部 id。
    expect(res.body).not.toContain(dirtyId);
    expect(res.body).not.toContain(otherProjectId);
    expect(res.body).not.toContain(stage.id);
  });

  it('reflects a stage status change immediately across requests', async () => {
    const { app } = setup();
    const projectId = await createProject(app);
    const stage = await createStage(app, projectId, { position: 1 });

    const before = await app.inject({ method: 'GET', url: `/api/v1/projects/${projectId}/status` });
    expect(before.json().currentStage?.id).toBe(stage.id);
    expect(before.json().stageSummary.completed).toBe(0);

    await setStageStatus(app, stage.id, stage.version, 'completed');

    const after = await app.inject({ method: 'GET', url: `/api/v1/projects/${projectId}/status` });
    expect(after.json().currentStage).toBeNull();
    expect(after.json().stageSummary.completed).toBe(1);
    expect(after.json().overallProgressPercent).toBe(100);
  });
});
