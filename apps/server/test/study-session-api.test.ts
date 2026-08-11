import { describe, expect, it } from 'vitest';
import type { StudySession } from '@mingwu/contracts';
import { buildApp } from '../src/app.js';
import { StudySessionService } from '../src/application/study-session/study-session-service.js';
import { loadConfig } from '../src/config.js';
import { makeServices, makeStudySession, uuid } from './helpers.js';

type App = ReturnType<typeof buildApp>;

function setup(now?: () => string) {
  const config = loadConfig({ NODE_ENV: 'test' });
  const services = makeServices();
  const app = buildApp({
    config,
    projectService: services.projectService,
    stageService: services.stageService,
    taskService: services.taskService,
    projectStatusService: services.projectStatusService,
    studySessionService: now
      ? new StudySessionService(services.studySessionRepository, now)
      : services.studySessionService,
    studySessionDetailService: services.studySessionDetailService,
    studySessionCurrentService: services.studySessionCurrentService,
    studySummaryService: services.studySummaryService,
    studyReportService: services.studyReportService,
    stageUpdateRequestService: services.stageUpdateRequestService,
    projectWorkReportService: services.projectWorkReportService,
  });
  return { app, services };
}

describe('POST /api/v1/study-sessions', () => {
  it('creates a count_down session and returns 201 with all create invariants', async () => {
    const { app } = setup();
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/study-sessions',
      payload: {
        id: uuid(),
        timerMode: 'count_down',
        taskText: '  背 50 个单词  ',
        plannedDurationSeconds: 2400,
      },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.timerMode).toBe('count_down');
    expect(body.taskText).toBe('背 50 个单词');
    expect(body.plannedDurationSeconds).toBe(2400);
    expect(body.status).toBe('created');
    expect(body.version).toBe(1);
    expect(body.startedAt).toBeNull();
    expect(body.endedAt).toBeNull();
    expect(body.actualDurationSeconds).toBe(0);
    expect(body.pausedDurationSeconds).toBe(0);
  });

  it('creates a count_up draft without a duration', async () => {
    const { app } = setup();
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/study-sessions',
      payload: { id: uuid(), timerMode: 'count_up' },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().plannedDurationSeconds).toBeNull();
  });

  it('is idempotent: retrying the same id and content returns 200 with the existing session', async () => {
    const { app } = setup();
    const id = uuid();
    const payload = { id, timerMode: 'count_down', taskText: '复习', plannedDurationSeconds: 3600 };
    const first = await app.inject({ method: 'POST', url: '/api/v1/study-sessions', payload });
    const retry = await app.inject({ method: 'POST', url: '/api/v1/study-sessions', payload });
    expect(first.statusCode).toBe(201);
    expect(retry.statusCode).toBe(200);
    expect(retry.json().id).toBe(id);
    expect(retry.json().version).toBe(1);
  });

  it('returns a stable 409 when the same id is reused with different content', async () => {
    const { app } = setup();
    const id = uuid();
    await app.inject({
      method: 'POST',
      url: '/api/v1/study-sessions',
      payload: { id, timerMode: 'count_down', plannedDurationSeconds: 600 },
    });
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/study-sessions',
      payload: { id, timerMode: 'count_down', plannedDurationSeconds: 1200 },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('study_session_idempotency_conflict');
  });

  it('returns a stable mode-conflict 409 for a count_up session carrying a duration', async () => {
    const { app } = setup();
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/study-sessions',
      payload: { id: uuid(), timerMode: 'count_up', plannedDurationSeconds: 600 },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('study_session_timer_mode_conflict');
  });

  it('rejects unknown fields strictly, including identity fields like actorId', async () => {
    const { app } = setup();
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/study-sessions',
      payload: { id: uuid(), timerMode: 'count_down', actorId: 'x', extra: 1 },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('validation_failed');
  });

  it('rejects a missing timerMode', async () => {
    const { app } = setup();
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/study-sessions',
      payload: { id: uuid() },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('validation_failed');
  });

  it('rejects a non-uuid id', async () => {
    const { app } = setup();
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/study-sessions',
      payload: { id: 'not-a-uuid', timerMode: 'count_down' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('validation_failed');
  });

  it('rejects out-of-range and non-integer plannedDurationSeconds', async () => {
    const { app } = setup();
    for (const plannedDurationSeconds of [0, 86401, 1.5, -1]) {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/study-sessions',
        payload: { id: uuid(), timerMode: 'count_down', plannedDurationSeconds },
      });
      expect(res.statusCode).toBe(400);
    }
  });

  it('rejects a numeric-string duration as a strict type violation', async () => {
    const { app } = setup();
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/study-sessions',
      payload: { id: uuid(), timerMode: 'count_down', plannedDurationSeconds: '600' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('validation_failed');
  });

  it('rejects a taskText longer than the limit', async () => {
    const { app } = setup();
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/study-sessions',
      payload: { id: uuid(), timerMode: 'count_down', taskText: 'x'.repeat(2001) },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('validation_failed');
  });
});

describe('PATCH /api/v1/study-sessions/:id/task', () => {
  async function createCountDown(app: App): Promise<StudySession> {
    const id = uuid();
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/study-sessions',
      payload: { id, timerMode: 'count_down' },
    });
    return res.json();
  }

  it('sets the task text, bumps version and keeps other fields', async () => {
    const { app } = setup();
    const session = await createCountDown(app);
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/v1/study-sessions/${session.id}/task`,
      payload: { expectedVersion: session.version, taskText: '  新的任务  ' },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.taskText).toBe('新的任务');
    expect(body.version).toBe(session.version + 1);
    expect(body.timerMode).toBe('count_down');
    expect(body.plannedDurationSeconds).toBeNull();
  });

  it('returns 404 for an unknown session', async () => {
    const { app } = setup();
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/v1/study-sessions/${uuid()}/task`,
      payload: { expectedVersion: 1, taskText: '任务' },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe('study_session_not_found');
  });

  it('rejects a whitespace-only taskText as invalid instead of silently storing it', async () => {
    const { app } = setup();
    const session = await createCountDown(app);
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/v1/study-sessions/${session.id}/task`,
      payload: { expectedVersion: session.version, taskText: '   ' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('study_session_task_text_invalid');
  });

  it('returns a stable 409 on a stale expectedVersion', async () => {
    const { app } = setup();
    const session = await createCountDown(app);
    await app.inject({
      method: 'PATCH',
      url: `/api/v1/study-sessions/${session.id}/task`,
      payload: { expectedVersion: session.version, taskText: '第一次' },
    });
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/v1/study-sessions/${session.id}/task`,
      payload: { expectedVersion: session.version, taskText: '第二次' },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('study_session_version_conflict');
  });

  it('does not advance version when the new value equals the current value', async () => {
    const { app } = setup();
    const session = await createCountDown(app);
    await app.inject({
      method: 'PATCH',
      url: `/api/v1/study-sessions/${session.id}/task`,
      payload: { expectedVersion: session.version, taskText: '保持不变' },
    });
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/v1/study-sessions/${session.id}/task`,
      payload: { expectedVersion: session.version + 1, taskText: '保持不变' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().version).toBe(session.version + 1);
  });

  it('rejects unknown fields in the body', async () => {
    const { app } = setup();
    const session = await createCountDown(app);
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/v1/study-sessions/${session.id}/task`,
      payload: { expectedVersion: session.version, taskText: '任务', actorId: 'x' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('validation_failed');
  });

  it('rejects a string expectedVersion as a strict type violation', async () => {
    const { app } = setup();
    const session = await createCountDown(app);
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/v1/study-sessions/${session.id}/task`,
      payload: { expectedVersion: '1', taskText: '任务' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('validation_failed');
  });

  it('returns a stable status-conflict 409 for a non-created session', async () => {
    const { app, services } = setup();
    const session = makeStudySession({ status: 'running' });
    await services.studySessionRepository.createIfAbsent(session);
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/v1/study-sessions/${session.id}/task`,
      payload: { expectedVersion: session.version, taskText: '任务' },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('study_session_status_conflict');
  });

  it('concurrent PATCH with the same expectedVersion: exactly one succeeds, the rest return 409', async () => {
    const { app } = setup();
    const session = await createCountDown(app);
    const results = await Promise.all(
      Array.from({ length: 20 }, () =>
        app.inject({
          method: 'PATCH',
          url: `/api/v1/study-sessions/${session.id}/task`,
          payload: { expectedVersion: session.version, taskText: '并发' },
        }),
      ),
    );
    expect(results.filter((r) => r.statusCode === 200)).toHaveLength(1);
    expect(results.filter((r) => r.statusCode === 409)).toHaveLength(19);
  });
});

describe('PATCH /api/v1/study-sessions/:id/countdown', () => {
  it('sets the countdown duration and bumps version', async () => {
    const { app } = setup();
    const id = uuid();
    await app.inject({
      method: 'POST',
      url: '/api/v1/study-sessions',
      payload: { id, timerMode: 'count_down' },
    });
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/v1/study-sessions/${id}/countdown`,
      payload: { expectedVersion: 1, plannedDurationSeconds: 1500 },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().plannedDurationSeconds).toBe(1500);
    expect(res.json().version).toBe(2);
  });

  it('returns a stable mode-conflict 409 for a count_up session', async () => {
    const { app } = setup();
    const id = uuid();
    await app.inject({
      method: 'POST',
      url: '/api/v1/study-sessions',
      payload: { id, timerMode: 'count_up' },
    });
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/v1/study-sessions/${id}/countdown`,
      payload: { expectedVersion: 1, plannedDurationSeconds: 600 },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('study_session_timer_mode_conflict');
  });

  it('returns a stable status-conflict 409 for a non-created session', async () => {
    const { app, services } = setup();
    const session = makeStudySession({ timerMode: 'count_down', status: 'paused' });
    await services.studySessionRepository.createIfAbsent(session);
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/v1/study-sessions/${session.id}/countdown`,
      payload: { expectedVersion: session.version, plannedDurationSeconds: 600 },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('study_session_status_conflict');
  });

  it('rejects out-of-range and non-integer durations with 400', async () => {
    const { app } = setup();
    const id = uuid();
    await app.inject({
      method: 'POST',
      url: '/api/v1/study-sessions',
      payload: { id, timerMode: 'count_down' },
    });
    for (const plannedDurationSeconds of [0, 86401, 1.5]) {
      const res = await app.inject({
        method: 'PATCH',
        url: `/api/v1/study-sessions/${id}/countdown`,
        payload: { expectedVersion: 1, plannedDurationSeconds },
      });
      expect(res.statusCode).toBe(400);
    }
  });

  it('rejects a numeric-string duration as a strict type violation', async () => {
    const { app } = setup();
    const id = uuid();
    await app.inject({
      method: 'POST',
      url: '/api/v1/study-sessions',
      payload: { id, timerMode: 'count_down' },
    });
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/v1/study-sessions/${id}/countdown`,
      payload: { expectedVersion: 1, plannedDurationSeconds: '600' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('validation_failed');
  });

  it('rejects a string expectedVersion as a strict type violation', async () => {
    const { app } = setup();
    const id = uuid();
    await app.inject({
      method: 'POST',
      url: '/api/v1/study-sessions',
      payload: { id, timerMode: 'count_down' },
    });
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/v1/study-sessions/${id}/countdown`,
      payload: { expectedVersion: '1', plannedDurationSeconds: 600 },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('validation_failed');
  });

  it('returns a stable 409 on a stale expectedVersion', async () => {
    const { app } = setup();
    const id = uuid();
    await app.inject({
      method: 'POST',
      url: '/api/v1/study-sessions',
      payload: { id, timerMode: 'count_down' },
    });
    await app.inject({
      method: 'PATCH',
      url: `/api/v1/study-sessions/${id}/countdown`,
      payload: { expectedVersion: 1, plannedDurationSeconds: 600 },
    });
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/v1/study-sessions/${id}/countdown`,
      payload: { expectedVersion: 1, plannedDurationSeconds: 900 },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('study_session_version_conflict');
  });

  it('does not advance version when the new value equals the current value', async () => {
    const { app } = setup();
    const id = uuid();
    await app.inject({
      method: 'POST',
      url: '/api/v1/study-sessions',
      payload: { id, timerMode: 'count_down', plannedDurationSeconds: 900 },
    });
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/v1/study-sessions/${id}/countdown`,
      payload: { expectedVersion: 1, plannedDurationSeconds: 900 },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().version).toBe(1);
  });

  it('returns 404 for an unknown session', async () => {
    const { app } = setup();
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/v1/study-sessions/${uuid()}/countdown`,
      payload: { expectedVersion: 1, plannedDurationSeconds: 600 },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe('study_session_not_found');
  });

  it('concurrent PATCH with the same expectedVersion: exactly one succeeds, the rest return 409', async () => {
    const { app } = setup();
    const id = uuid();
    await app.inject({
      method: 'POST',
      url: '/api/v1/study-sessions',
      payload: { id, timerMode: 'count_down' },
    });
    const results = await Promise.all(
      Array.from({ length: 20 }, () =>
        app.inject({
          method: 'PATCH',
          url: `/api/v1/study-sessions/${id}/countdown`,
          payload: { expectedVersion: 1, plannedDurationSeconds: 300 },
        }),
      ),
    );
    expect(results.filter((r) => r.statusCode === 200)).toHaveLength(1);
    expect(results.filter((r) => r.statusCode === 409)).toHaveLength(19);
  });
});

describe('GET /api/v1/study-sessions/:id', () => {
  it('returns the session core state', async () => {
    const { app } = setup();
    const id = uuid();
    await app.inject({
      method: 'POST',
      url: '/api/v1/study-sessions',
      payload: { id, timerMode: 'count_down', taskText: '背单词', plannedDurationSeconds: 600 },
    });
    const res = await app.inject({ method: 'GET', url: `/api/v1/study-sessions/${id}` });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.id).toBe(id);
    expect(body.timerMode).toBe('count_down');
    expect(body.taskText).toBe('背单词');
    expect(body.plannedDurationSeconds).toBe(600);
    expect(body.status).toBe('created');
    expect(body.version).toBe(1);
  });

  it('returns 404 for an unknown session', async () => {
    const { app } = setup();
    const res = await app.inject({ method: 'GET', url: `/api/v1/study-sessions/${uuid()}` });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe('study_session_not_found');
  });
});

describe('POST /api/v1/study-sessions/:id/start', () => {
  const FIXED_NOW = '2026-01-01T08:00:00.000Z';

  it('starts a count_down session and returns running with server-side startedAt', async () => {
    const { app } = setup(() => FIXED_NOW);
    const id = uuid();
    await app.inject({
      method: 'POST',
      url: '/api/v1/study-sessions',
      payload: { id, timerMode: 'count_down', taskText: '背单词', plannedDurationSeconds: 600 },
    });
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/study-sessions/${id}/start`,
      payload: { expectedVersion: 1 },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.status).toBe('running');
    expect(body.startedAt).toBe(FIXED_NOW);
    expect(body.version).toBe(2);
    expect(body.endedAt).toBeNull();
    expect(body.actualDurationSeconds).toBe(0);
    expect(body.pausedDurationSeconds).toBe(0);
  });

  it('starts a count_up session without a duration', async () => {
    const { app } = setup();
    const id = uuid();
    await app.inject({
      method: 'POST',
      url: '/api/v1/study-sessions',
      payload: { id, timerMode: 'count_up', taskText: '专注' },
    });
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/study-sessions/${id}/start`,
      payload: { expectedVersion: 1 },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.status).toBe('running');
    expect(body.timerMode).toBe('count_up');
    expect(body.plannedDurationSeconds).toBeNull();
  });

  it('returns a stable 409 with reason missing_task when the task is not set', async () => {
    const { app } = setup();
    const id = uuid();
    await app.inject({
      method: 'POST',
      url: '/api/v1/study-sessions',
      payload: { id, timerMode: 'count_down', plannedDurationSeconds: 600 },
    });
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/study-sessions/${id}/start`,
      payload: { expectedVersion: 1 },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('study_session_start_precondition_failed');
    expect(res.json().reason).toBe('missing_task');
  });

  it('returns a stable 409 with reason missing_duration for a count_down without a duration', async () => {
    const { app } = setup();
    const id = uuid();
    await app.inject({
      method: 'POST',
      url: '/api/v1/study-sessions',
      payload: { id, timerMode: 'count_down', taskText: '任务' },
    });
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/study-sessions/${id}/start`,
      payload: { expectedVersion: 1 },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().reason).toBe('missing_duration');
  });

  it('returns 409 with reason invalid_duration for a count_down with an illegal stored duration and keeps state unchanged', async () => {
    const { app, services } = setup();
    const session = makeStudySession({
      timerMode: 'count_down',
      taskText: '任务',
      plannedDurationSeconds: 0,
    });
    await services.studySessionRepository.createIfAbsent(session);
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/study-sessions/${session.id}/start`,
      payload: { expectedVersion: session.version },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('study_session_start_precondition_failed');
    expect(res.json().reason).toBe('invalid_duration');
    const latest = await app.inject({ method: 'GET', url: `/api/v1/study-sessions/${session.id}` });
    expect(latest.json().status).toBe('created');
    expect(latest.json().version).toBe(session.version);
    expect(latest.json().startedAt).toBeNull();
  });

  it('returns a stable status-conflict 409 for a non-created session and does not rewrite startedAt', async () => {
    const { app, services } = setup();
    const session = makeStudySession({
      timerMode: 'count_down',
      taskText: '任务',
      plannedDurationSeconds: 600,
      status: 'running',
      startedAt: '2026-01-01T01:00:00.000Z',
    });
    await services.studySessionRepository.createIfAbsent(session);
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/study-sessions/${session.id}/start`,
      payload: { expectedVersion: session.version },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('study_session_status_conflict');
    const latest = await app.inject({ method: 'GET', url: `/api/v1/study-sessions/${session.id}` });
    expect(latest.json().startedAt).toBe('2026-01-01T01:00:00.000Z');
    expect(latest.json().version).toBe(session.version);
  });

  it('returns a stable 409 on a stale expectedVersion', async () => {
    const { app } = setup();
    const id = uuid();
    await app.inject({
      method: 'POST',
      url: '/api/v1/study-sessions',
      payload: { id, timerMode: 'count_down', taskText: '任务', plannedDurationSeconds: 600 },
    });
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/study-sessions/${id}/start`,
      payload: { expectedVersion: 99 },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('study_session_version_conflict');
  });

  it('rejects unknown fields in the body', async () => {
    const { app } = setup();
    const id = uuid();
    await app.inject({
      method: 'POST',
      url: '/api/v1/study-sessions',
      payload: { id, timerMode: 'count_down', taskText: '任务', plannedDurationSeconds: 600 },
    });
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/study-sessions/${id}/start`,
      payload: { expectedVersion: 1, actorId: 'x' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('validation_failed');
  });

  it('rejects a string expectedVersion as a strict type violation', async () => {
    const { app } = setup();
    const id = uuid();
    await app.inject({
      method: 'POST',
      url: '/api/v1/study-sessions',
      payload: { id, timerMode: 'count_down', taskText: '任务', plannedDurationSeconds: 600 },
    });
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/study-sessions/${id}/start`,
      payload: { expectedVersion: '1' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('validation_failed');
  });

  it('concurrent start with the same expectedVersion: exactly one succeeds and startedAt is written once', async () => {
    const { app } = setup(() => FIXED_NOW);
    const id = uuid();
    await app.inject({
      method: 'POST',
      url: '/api/v1/study-sessions',
      payload: { id, timerMode: 'count_down', taskText: '并发', plannedDurationSeconds: 600 },
    });
    const results = await Promise.all(
      Array.from({ length: 20 }, () =>
        app.inject({
          method: 'POST',
          url: `/api/v1/study-sessions/${id}/start`,
          payload: { expectedVersion: 1 },
        }),
      ),
    );
    expect(results.filter((r) => r.statusCode === 200)).toHaveLength(1);
    expect(results.filter((r) => r.statusCode === 409)).toHaveLength(19);
    const latest = await app.inject({ method: 'GET', url: `/api/v1/study-sessions/${id}` });
    expect(latest.json().status).toBe('running');
    expect(latest.json().startedAt).toBe(FIXED_NOW);
    expect(latest.json().version).toBe(2);
  });
});

describe('POST /api/v1/study-sessions/:id/pause', () => {
  const FIXED_NOW = '2026-01-01T08:00:00.000Z';

  async function createRunning(app: App): Promise<StudySession> {
    const id = uuid();
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/study-sessions',
      payload: { id, timerMode: 'count_down', taskText: '任务', plannedDurationSeconds: 600 },
    });
    const session = res.json();
    const started = await app.inject({
      method: 'POST',
      url: `/api/v1/study-sessions/${id}/start`,
      payload: { expectedVersion: session.version },
    });
    return started.json();
  }

  it('pauses a running session and writes server-side pausedAt', async () => {
    const { app } = setup(() => FIXED_NOW);
    const running = await createRunning(app);
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/study-sessions/${running.id}/pause`,
      payload: { expectedVersion: running.version },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.status).toBe('paused');
    expect(body.pausedAt).toBe(FIXED_NOW);
    expect(body.version).toBe(running.version + 1);
    expect(body.startedAt).toBe(FIXED_NOW);
  });

  it('returns a stable status-conflict 409 for a non-running session', async () => {
    const { app } = setup();
    const id = uuid();
    await app.inject({
      method: 'POST',
      url: '/api/v1/study-sessions',
      payload: { id, timerMode: 'count_down', taskText: '任务', plannedDurationSeconds: 600 },
    });
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/study-sessions/${id}/pause`,
      payload: { expectedVersion: 1 },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('study_session_status_conflict');
  });

  it('returns a controlled 500 when startedAt is missing (time corruption)', async () => {
    const { app, services } = setup();
    const session = makeStudySession({ status: 'running' });
    await services.studySessionRepository.createIfAbsent(session);
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/study-sessions/${session.id}/pause`,
      payload: { expectedVersion: session.version },
    });
    expect(res.statusCode).toBe(500);
    expect(res.json().error).toBe('study_session_time_corrupt');
  });

  it('returns a controlled 500 and does not leak the raw bad clock when the server clock is unparseable', async () => {
    const { app, services } = setup(() => 'not-a-time');
    const session = makeStudySession({
      status: 'running',
      startedAt: '2026-01-01T08:00:00.000Z',
    });
    await services.studySessionRepository.createIfAbsent(session);
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/study-sessions/${session.id}/pause`,
      payload: { expectedVersion: session.version },
    });
    expect(res.statusCode).toBe(500);
    expect(res.json().error).toBe('study_session_time_corrupt');
    expect(JSON.stringify(res.json())).not.toContain('not-a-time');
  });

  it('returns a stable 409 on a stale expectedVersion', async () => {
    const { app } = setup();
    const running = await createRunning(app);
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/study-sessions/${running.id}/pause`,
      payload: { expectedVersion: 99 },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('study_session_version_conflict');
  });

  it('returns 404 for an unknown session', async () => {
    const { app } = setup();
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/study-sessions/${uuid()}/pause`,
      payload: { expectedVersion: 1 },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe('study_session_not_found');
  });

  it('rejects unknown fields in the body', async () => {
    const { app } = setup();
    const running = await createRunning(app);
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/study-sessions/${running.id}/pause`,
      payload: { expectedVersion: running.version, actorId: 'x' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('validation_failed');
  });

  it('rejects a string expectedVersion as a strict type violation', async () => {
    const { app } = setup();
    const running = await createRunning(app);
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/study-sessions/${running.id}/pause`,
      payload: { expectedVersion: '1' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('validation_failed');
  });

  it('concurrent pause with the same expectedVersion: exactly one succeeds', async () => {
    const { app } = setup(() => FIXED_NOW);
    const running = await createRunning(app);
    const results = await Promise.all(
      Array.from({ length: 20 }, () =>
        app.inject({
          method: 'POST',
          url: `/api/v1/study-sessions/${running.id}/pause`,
          payload: { expectedVersion: running.version },
        }),
      ),
    );
    expect(results.filter((r) => r.statusCode === 200)).toHaveLength(1);
    expect(results.filter((r) => r.statusCode === 409)).toHaveLength(19);
    const latest = await app.inject({ method: 'GET', url: `/api/v1/study-sessions/${running.id}` });
    expect(latest.json().status).toBe('paused');
    expect(latest.json().pausedAt).toBe(FIXED_NOW);
    expect(latest.json().version).toBe(running.version + 1);
  });
});

describe('POST /api/v1/study-sessions/:id/resume', () => {
  const FIXED_NOW = '2026-01-01T08:00:00.000Z';

  async function createPaused(app: App): Promise<StudySession> {
    const id = uuid();
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/study-sessions',
      payload: { id, timerMode: 'count_down', taskText: '任务', plannedDurationSeconds: 600 },
    });
    const session = res.json();
    const started = await app.inject({
      method: 'POST',
      url: `/api/v1/study-sessions/${id}/start`,
      payload: { expectedVersion: session.version },
    });
    const running = started.json();
    const paused = await app.inject({
      method: 'POST',
      url: `/api/v1/study-sessions/${id}/pause`,
      payload: { expectedVersion: running.version },
    });
    return paused.json();
  }

  it('resumes a paused session and accumulates whole paused seconds', async () => {
    let current = Date.parse(FIXED_NOW);
    const clock = () => new Date(current).toISOString();
    const { app } = setup(clock);
    const paused = await createPaused(app);
    expect(paused.pausedAt).toBe(FIXED_NOW);
    current += 65_900; // 暂停 65.9 秒 → 整秒 65
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/study-sessions/${paused.id}/resume`,
      payload: { expectedVersion: paused.version },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.status).toBe('running');
    expect(body.pausedAt).toBeNull();
    expect(body.pausedDurationSeconds).toBe(65);
    expect(body.startedAt).toBe(FIXED_NOW);
    expect(body.version).toBe(paused.version + 1);
  });

  it('accumulates across multiple pause/resume rounds through the HTTP API', async () => {
    let current = Date.parse(FIXED_NOW);
    const clock = () => new Date(current).toISOString();
    const { app } = setup(clock);
    const id = uuid();
    await app.inject({
      method: 'POST',
      url: '/api/v1/study-sessions',
      payload: { id, timerMode: 'count_down', taskText: '任务', plannedDurationSeconds: 600 },
    });
    await app.inject({
      method: 'POST',
      url: `/api/v1/study-sessions/${id}/start`,
      payload: { expectedVersion: 1 },
    });
    // 第 1 轮：暂停 65.9 秒 → 65
    await app.inject({
      method: 'POST',
      url: `/api/v1/study-sessions/${id}/pause`,
      payload: { expectedVersion: 2 },
    });
    current += 65_900;
    let s = await app.inject({
      method: 'POST',
      url: `/api/v1/study-sessions/${id}/resume`,
      payload: { expectedVersion: 3 },
    });
    expect(s.json().pausedDurationSeconds).toBe(65);
    // 第 2 轮：暂停 60 秒 → 累计 125
    await app.inject({
      method: 'POST',
      url: `/api/v1/study-sessions/${id}/pause`,
      payload: { expectedVersion: s.json().version },
    });
    current += 60_000;
    s = await app.inject({
      method: 'POST',
      url: `/api/v1/study-sessions/${id}/resume`,
      payload: { expectedVersion: s.json().version + 1 },
    });
    expect(s.statusCode).toBe(200);
    expect(s.json().pausedDurationSeconds).toBe(125);
    expect(s.json().startedAt).toBe(FIXED_NOW);
  });

  it('returns a stable status-conflict 409 for a non-paused session', async () => {
    const { app } = setup();
    const running = await (async () => {
      const id = uuid();
      await app.inject({
        method: 'POST',
        url: '/api/v1/study-sessions',
        payload: { id, timerMode: 'count_down', taskText: '任务', plannedDurationSeconds: 600 },
      });
      const started = await app.inject({
        method: 'POST',
        url: `/api/v1/study-sessions/${id}/start`,
        payload: { expectedVersion: 1 },
      });
      return started.json();
    })();
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/study-sessions/${running.id}/resume`,
      payload: { expectedVersion: running.version },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('study_session_status_conflict');
  });

  it('returns a controlled 500 and keeps the store unchanged when pausedAt is before startedAt', async () => {
    const { app, services } = setup(() => FIXED_NOW);
    const session = makeStudySession({
      status: 'paused',
      startedAt: '2026-01-01T09:00:00.000Z',
      pausedAt: '2026-01-01T08:00:00.000Z',
    });
    await services.studySessionRepository.createIfAbsent(session);
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/study-sessions/${session.id}/resume`,
      payload: { expectedVersion: session.version },
    });
    expect(res.statusCode).toBe(500);
    expect(res.json().error).toBe('study_session_time_corrupt');
    const latest = await app.inject({ method: 'GET', url: `/api/v1/study-sessions/${session.id}` });
    expect(latest.json().status).toBe('paused');
    expect(latest.json().pausedAt).toBe('2026-01-01T08:00:00.000Z');
    expect(latest.json().version).toBe(session.version);
  });

  it('returns a controlled 500 and keeps the store unchanged when the server clock is unparseable', async () => {
    const { app, services } = setup(() => 'not-a-time');
    const session = makeStudySession({
      status: 'paused',
      startedAt: FIXED_NOW,
      pausedAt: FIXED_NOW,
    });
    await services.studySessionRepository.createIfAbsent(session);
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/study-sessions/${session.id}/resume`,
      payload: { expectedVersion: session.version },
    });
    expect(res.statusCode).toBe(500);
    expect(res.json().error).toBe('study_session_time_corrupt');
    expect(JSON.stringify(res.json())).not.toContain('not-a-time');
    const latest = await app.inject({ method: 'GET', url: `/api/v1/study-sessions/${session.id}` });
    expect(latest.json().status).toBe('paused');
    expect(latest.json().pausedDurationSeconds).toBe(0);
    expect(latest.json().version).toBe(session.version);
  });

  it('returns a stable 409 on a stale expectedVersion', async () => {
    const { app } = setup();
    const paused = await createPaused(app);
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/study-sessions/${paused.id}/resume`,
      payload: { expectedVersion: 99 },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('study_session_version_conflict');
  });

  it('returns 404 for an unknown session', async () => {
    const { app } = setup();
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/study-sessions/${uuid()}/resume`,
      payload: { expectedVersion: 1 },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe('study_session_not_found');
  });

  it('rejects unknown fields in the body', async () => {
    const { app } = setup();
    const paused = await createPaused(app);
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/study-sessions/${paused.id}/resume`,
      payload: { expectedVersion: paused.version, status: 'running' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('validation_failed');
  });

  it('rejects a string expectedVersion as a strict type violation', async () => {
    const { app } = setup();
    const paused = await createPaused(app);
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/study-sessions/${paused.id}/resume`,
      payload: { expectedVersion: '1' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('validation_failed');
  });

  it('concurrent resume with the same expectedVersion: exactly one succeeds', async () => {
    const { app } = setup(() => FIXED_NOW);
    const paused = await createPaused(app);
    const results = await Promise.all(
      Array.from({ length: 20 }, () =>
        app.inject({
          method: 'POST',
          url: `/api/v1/study-sessions/${paused.id}/resume`,
          payload: { expectedVersion: paused.version },
        }),
      ),
    );
    expect(results.filter((r) => r.statusCode === 200)).toHaveLength(1);
    expect(results.filter((r) => r.statusCode === 409)).toHaveLength(19);
    const latest = await app.inject({ method: 'GET', url: `/api/v1/study-sessions/${paused.id}` });
    expect(latest.json().status).toBe('running');
    expect(latest.json().pausedAt).toBeNull();
    expect(latest.json().version).toBe(paused.version + 1);
  });
});

describe('POST /api/v1/study-sessions/:id/end', () => {
  const FIXED_NOW = '2026-01-01T08:00:00.000Z';

  async function createRunning(app: App): Promise<StudySession> {
    const id = uuid();
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/study-sessions',
      payload: { id, timerMode: 'count_down', taskText: '任务', plannedDurationSeconds: 600 },
    });
    const session = res.json();
    const started = await app.inject({
      method: 'POST',
      url: `/api/v1/study-sessions/${id}/start`,
      payload: { expectedVersion: session.version },
    });
    return started.json();
  }

  it('ends a running session with accumulated pauses (125.9s wall / 65s paused → 60s actual)', async () => {
    let current = Date.parse(FIXED_NOW);
    const clock = () => new Date(current).toISOString();
    const { app, services } = setup(clock);
    const running = makeStudySession({
      timerMode: 'count_down',
      taskText: '任务',
      plannedDurationSeconds: 600,
      status: 'running',
      startedAt: FIXED_NOW,
      pausedDurationSeconds: 65,
    });
    await services.studySessionRepository.createIfAbsent(running);
    current += 125_900;
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/study-sessions/${running.id}/end`,
      payload: { expectedVersion: running.version },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.status).toBe('completed');
    expect(body.endedAt).toBe(clock());
    expect(body.pausedAt).toBeNull();
    expect(body.actualDurationSeconds).toBe(60);
    expect(body.pausedDurationSeconds).toBe(65);
    expect(body.startedAt).toBe(FIXED_NOW);
    expect(body.version).toBe(running.version + 1);
  });

  it('ends a paused session and settles the current pause interval', async () => {
    let current = Date.parse(FIXED_NOW);
    const clock = () => new Date(current).toISOString();
    const { app, services } = setup(clock);
    const paused = makeStudySession({
      status: 'paused',
      startedAt: FIXED_NOW,
      pausedAt: new Date(current + 60_000).toISOString(),
      pausedDurationSeconds: 0,
    });
    await services.studySessionRepository.createIfAbsent(paused);
    current += 125_900;
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/study-sessions/${paused.id}/end`,
      payload: { expectedVersion: paused.version },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.status).toBe('completed');
    expect(body.pausedAt).toBeNull();
    expect(body.pausedDurationSeconds).toBe(65);
    expect(body.actualDurationSeconds).toBe(60);
  });

  it('returns a stable status-conflict 409 for a created session', async () => {
    const { app } = setup();
    const id = uuid();
    await app.inject({
      method: 'POST',
      url: '/api/v1/study-sessions',
      payload: { id, timerMode: 'count_down', taskText: '任务', plannedDurationSeconds: 600 },
    });
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/study-sessions/${id}/end`,
      payload: { expectedVersion: 1 },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('study_session_status_conflict');
  });

  it('returns a stable status-conflict 409 for an already completed session without rewriting results', async () => {
    const { app, services } = setup();
    const session = makeStudySession({
      status: 'completed',
      startedAt: FIXED_NOW,
      endedAt: '2026-01-01T08:30:00.000Z',
      actualDurationSeconds: 1800,
      pausedDurationSeconds: 60,
    });
    await services.studySessionRepository.createIfAbsent(session);
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/study-sessions/${session.id}/end`,
      payload: { expectedVersion: session.version },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('study_session_status_conflict');
    const latest = await app.inject({ method: 'GET', url: `/api/v1/study-sessions/${session.id}` });
    expect(latest.json().endedAt).toBe('2026-01-01T08:30:00.000Z');
    expect(latest.json().actualDurationSeconds).toBe(1800);
    expect(latest.json().version).toBe(session.version);
  });

  it('returns a controlled 500 and does not leak raw times when the server clock is unparseable', async () => {
    const { app, services } = setup(() => 'not-a-time');
    const session = makeStudySession({ status: 'running', startedAt: FIXED_NOW });
    await services.studySessionRepository.createIfAbsent(session);
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/study-sessions/${session.id}/end`,
      payload: { expectedVersion: session.version },
    });
    expect(res.statusCode).toBe(500);
    expect(res.json().error).toBe('study_session_time_corrupt');
    expect(JSON.stringify(res.json())).not.toContain('not-a-time');
    const latest = await app.inject({ method: 'GET', url: `/api/v1/study-sessions/${session.id}` });
    expect(latest.json().status).toBe('running');
    expect(latest.json().endedAt).toBeNull();
  });

  it('returns a controlled 500 when a running session carries a pausedAt (time corruption)', async () => {
    const { app, services } = setup(() => FIXED_NOW);
    const session = makeStudySession({
      status: 'running',
      startedAt: FIXED_NOW,
      pausedAt: FIXED_NOW,
    });
    await services.studySessionRepository.createIfAbsent(session);
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/study-sessions/${session.id}/end`,
      payload: { expectedVersion: session.version },
    });
    expect(res.statusCode).toBe(500);
    expect(res.json().error).toBe('study_session_time_corrupt');
  });

  it('returns a controlled 500 when a paused session lacks a pausedAt (time corruption)', async () => {
    const { app, services } = setup(() => FIXED_NOW);
    const session = makeStudySession({ status: 'paused', startedAt: FIXED_NOW });
    await services.studySessionRepository.createIfAbsent(session);
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/study-sessions/${session.id}/end`,
      payload: { expectedVersion: session.version },
    });
    expect(res.statusCode).toBe(500);
    expect(res.json().error).toBe('study_session_time_corrupt');
  });

  it('returns a controlled 500 and keeps the store unchanged when paused seconds exceed the wall clock', async () => {
    const { app, services } = setup(() => FIXED_NOW);
    const session = makeStudySession({
      status: 'running',
      startedAt: FIXED_NOW,
      pausedDurationSeconds: 200,
    });
    await services.studySessionRepository.createIfAbsent(session);
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/study-sessions/${session.id}/end`,
      payload: { expectedVersion: session.version },
    });
    expect(res.statusCode).toBe(500);
    expect(res.json().error).toBe('study_session_time_corrupt');
    const latest = await app.inject({ method: 'GET', url: `/api/v1/study-sessions/${session.id}` });
    expect(latest.json().status).toBe('running');
    expect(latest.json().endedAt).toBeNull();
    expect(latest.json().version).toBe(session.version);
  });

  it('returns a stable 409 on a stale expectedVersion', async () => {
    const { app } = setup();
    const running = await createRunning(app);
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/study-sessions/${running.id}/end`,
      payload: { expectedVersion: 99 },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('study_session_version_conflict');
  });

  it('returns 404 for an unknown session', async () => {
    const { app } = setup();
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/study-sessions/${uuid()}/end`,
      payload: { expectedVersion: 1 },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe('study_session_not_found');
  });

  it('rejects unknown fields in the body', async () => {
    const { app } = setup();
    const running = await createRunning(app);
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/study-sessions/${running.id}/end`,
      payload: { expectedVersion: running.version, endedAt: FIXED_NOW },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('validation_failed');
  });

  it('rejects a string expectedVersion as a strict type violation', async () => {
    const { app } = setup();
    const running = await createRunning(app);
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/study-sessions/${running.id}/end`,
      payload: { expectedVersion: '1' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('validation_failed');
  });

  it('concurrent end with the same expectedVersion: exactly one succeeds', async () => {
    const { app } = setup(() => FIXED_NOW);
    const running = await createRunning(app);
    const results = await Promise.all(
      Array.from({ length: 20 }, () =>
        app.inject({
          method: 'POST',
          url: `/api/v1/study-sessions/${running.id}/end`,
          payload: { expectedVersion: running.version },
        }),
      ),
    );
    expect(results.filter((r) => r.statusCode === 200)).toHaveLength(1);
    expect(results.filter((r) => r.statusCode === 409)).toHaveLength(19);
    const latest = await app.inject({ method: 'GET', url: `/api/v1/study-sessions/${running.id}` });
    expect(latest.json().status).toBe('completed');
    expect(latest.json().version).toBe(running.version + 1);
  });
});

describe('GET /api/v1/study-sessions/history', () => {
  const T0 = '2026-01-01T08:00:00.000Z';

  async function seedTerminal(
    services: ReturnType<typeof makeServices>,
    overrides: Partial<StudySession> = {},
  ): Promise<StudySession> {
    const session = makeStudySession({ status: 'completed', endedAt: T0, ...overrides });
    await services.studySessionRepository.createIfAbsent(session);
    return session;
  }

  /** 与服务层一致的游标编码：`endedAt\0id` base64url。 */
  function historyCursor(endedAt: string, id: string): string {
    return Buffer.from(`${endedAt}\u0000${id}`, 'utf8').toString('base64url');
  }

  it('returns an empty page when no terminal sessions exist', async () => {
    const { app, services } = setup();
    await services.studySessionRepository.createIfAbsent(makeStudySession({ status: 'created' }));
    const res = await app.inject({ method: 'GET', url: '/api/v1/study-sessions/history' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ items: [], nextCursor: null });
  });

  it('returns only terminal sessions sorted by endedAt desc and drops client-only fields', async () => {
    const { app, services } = setup();
    const a = await seedTerminal(services, { taskText: '最早', endedAt: T0 });
    const b = await seedTerminal(services, {
      taskText: '最晚',
      timerMode: 'count_up',
      startedAt: T0,
      endedAt: '2026-01-01T10:00:00.000Z',
      actualDurationSeconds: 120,
    });
    await services.studySessionRepository.createIfAbsent(
      makeStudySession({ status: 'running', startedAt: T0 }),
    );
    const res = await app.inject({ method: 'GET', url: '/api/v1/study-sessions/history' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.items).toHaveLength(2);
    expect(body.items[0].id).toBe(b.id);
    expect(body.items[0].taskText).toBe('最晚');
    expect(body.items[0].timerMode).toBe('count_up');
    expect(body.items[0].actualDurationSeconds).toBe(120);
    expect(body.items[1].id).toBe(a.id);
    for (const item of body.items) {
      expect(item).not.toHaveProperty('version');
      expect(item).not.toHaveProperty('pausedAt');
      expect(item).not.toHaveProperty('updatedAt');
    }
    expect(body.nextCursor).toBeNull();
  });

  it('defaults limit to 20 and pages through the whole list without duplicates', async () => {
    const { app, services } = setup();
    const ids: string[] = [];
    for (let i = 0; i < 25; i += 1) {
      const s = await seedTerminal(services, {
        endedAt: new Date(Date.parse(T0) + i * 60_000).toISOString(),
      });
      ids.push(s.id);
    }
    const expected = [...ids].reverse(); // endedAt 升序播种 → 降序展示为倒序
    const first = await app.inject({ method: 'GET', url: '/api/v1/study-sessions/history' });
    expect(first.statusCode).toBe(200);
    expect(first.json().items).toHaveLength(20);
    expect(first.json().nextCursor).not.toBeNull();
    const collected: string[] = first.json().items.map((i: { id: string }) => i.id);
    let cursor: string | null = first.json().nextCursor;
    while (cursor !== null) {
      const page = await app.inject({
        method: 'GET',
        url: `/api/v1/study-sessions/history?cursor=${encodeURIComponent(cursor)}`,
      });
      expect(page.statusCode).toBe(200);
      collected.push(...page.json().items.map((i: { id: string }) => i.id));
      cursor = page.json().nextCursor;
    }
    expect(collected).toEqual(expected);
  });

  it('honours an explicit limit and continues from its cursor', async () => {
    const { app, services } = setup();
    const ids: string[] = [];
    for (let i = 0; i < 5; i += 1) {
      const s = await seedTerminal(services, {
        endedAt: new Date(Date.parse(T0) + i * 60_000).toISOString(),
      });
      ids.push(s.id);
    }
    const all = await app.inject({ method: 'GET', url: '/api/v1/study-sessions/history?limit=100' });
    expect(all.json().items).toHaveLength(5);
    const first = await app.inject({ method: 'GET', url: '/api/v1/study-sessions/history?limit=2' });
    expect(first.json().items).toHaveLength(2);
    expect(first.json().nextCursor).not.toBeNull();
    const second = await app.inject({
      method: 'GET',
      url: `/api/v1/study-sessions/history?limit=2&cursor=${encodeURIComponent(first.json().nextCursor)}`,
    });
    expect(second.json().items).toHaveLength(2);
    expect(second.json().nextCursor).not.toBeNull();
    const third = await app.inject({
      method: 'GET',
      url: `/api/v1/study-sessions/history?limit=2&cursor=${encodeURIComponent(second.json().nextCursor)}`,
    });
    expect(third.json().items).toHaveLength(1);
    expect(third.json().nextCursor).toBeNull();
    const pageIds = [...first.json().items, ...second.json().items, ...third.json().items].map(
      (i: { id: string }) => i.id,
    );
    expect(new Set(pageIds).size).toBe(5);
    expect(pageIds).toEqual([...ids].reverse());
  });

  it('does not repeat already-seen items when a newer terminal session is inserted between pages', async () => {
    const { app, services } = setup();
    const ids: string[] = [];
    for (let i = 0; i < 3; i += 1) {
      const s = await seedTerminal(services, {
        endedAt: new Date(Date.parse(T0) + i * 60_000).toISOString(),
      });
      ids.push(s.id);
    }
    // 播种按 endedAt 升序：[最早, 中间, 最新] → 历史降序 [ids[2], ids[1], ids[0]]。
    const first = await app.inject({ method: 'GET', url: '/api/v1/study-sessions/history?limit=1' });
    expect(first.json().items.map((i: { id: string }) => i.id)).toEqual([ids[2]!]);
    expect(first.json().nextCursor).not.toBeNull();
    // 翻页之间插入 endedAt 更新的记录：排序在最前，但旧 cursor 只向后取，
    // 后续页不得出现新记录，也不得重复已经看过的项目。
    await seedTerminal(services, {
      endedAt: new Date(Date.parse(T0) + 10 * 60_000).toISOString(),
    });
    const second = await app.inject({
      method: 'GET',
      url: `/api/v1/study-sessions/history?limit=1&cursor=${encodeURIComponent(first.json().nextCursor)}`,
    });
    expect(second.statusCode).toBe(200);
    expect(second.json().items.map((i: { id: string }) => i.id)).toEqual([ids[1]!]);
    expect(second.json().nextCursor).not.toBeNull();
    const third = await app.inject({
      method: 'GET',
      url: `/api/v1/study-sessions/history?limit=1&cursor=${encodeURIComponent(second.json().nextCursor)}`,
    });
    expect(third.json().items.map((i: { id: string }) => i.id)).toEqual([ids[0]!]);
    expect(third.json().nextCursor).toBeNull();
  });

  it('returns a controlled 400 for a limit above 100', async () => {
    const { app } = setup();
    const res = await app.inject({ method: 'GET', url: '/api/v1/study-sessions/history?limit=101' });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('study_session_history_limit_invalid');
  });

  it('rejects a non-digit or zero limit as a validation failure', async () => {
    const { app } = setup();
    for (const limit of ['0', '01', 'abc', '-1']) {
      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/study-sessions/history?limit=${limit}`,
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe('validation_failed');
    }
  });

  it('returns a controlled 400 for an invalid cursor without echoing it', async () => {
    const { app } = setup();
    const raw = '%%%not-a-real-cursor%%%';
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/study-sessions/history?cursor=${encodeURIComponent(raw)}`,
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('study_session_history_cursor_invalid');
    expect(JSON.stringify(res.json())).not.toContain(raw);
  });

  it('rejects a cursor with appended garbage or base64url padding as a controlled 400', async () => {
    const { app } = setup();
    const good = historyCursor(T0, uuid());
    for (const cursor of [`${good}!!!`, `${good}==`, `=${good}`, `${good}\u0000`]) {
      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/study-sessions/history?cursor=${encodeURIComponent(cursor)}`,
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe('study_session_history_cursor_invalid');
      expect(JSON.stringify(res.json())).not.toContain(encodeURIComponent(cursor));
    }
  });

  it('rejects a cursor whose time is parseable but not canonical UTC ISO as a controlled 400', async () => {
    const { app } = setup();
    for (const endedAt of [
      '2026-01-01T08:00:00Z',
      '2026-01-01 08:00:00',
      '2026-01-01T08:00:00.000+08:00',
    ]) {
      const cursor = historyCursor(endedAt, uuid());
      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/study-sessions/history?cursor=${encodeURIComponent(cursor)}`,
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe('study_session_history_cursor_invalid');
    }
  });

  it('returns a controlled 500 without leaking ids when a terminal record has a null endedAt', async () => {
    const { app, services } = setup();
    const corrupt = makeStudySession({ status: 'completed', endedAt: null });
    await services.studySessionRepository.createIfAbsent(corrupt);
    const res = await app.inject({ method: 'GET', url: '/api/v1/study-sessions/history' });
    expect(res.statusCode).toBe(500);
    expect(res.json().error).toBe('study_session_history_data_corrupt');
    const body = JSON.stringify(res.json());
    expect(body).not.toContain(corrupt.id);
  });

  it('returns a controlled 500 without leaking ids when a terminal record has a non-canonical endedAt', async () => {
    const { app, services } = setup();
    const corrupt = makeStudySession({ status: 'completed', endedAt: '2026-01-01T08:00:00Z' });
    await services.studySessionRepository.createIfAbsent(corrupt);
    const res = await app.inject({ method: 'GET', url: '/api/v1/study-sessions/history' });
    expect(res.statusCode).toBe(500);
    expect(res.json().error).toBe('study_session_history_data_corrupt');
    expect(JSON.stringify(res.json())).not.toContain(corrupt.id);
  });

  it('returns a controlled 500 without leaking ids when a terminal record has an invalid id', async () => {
    const { app, services } = setup();
    const corrupt = makeStudySession({ id: 'not-a-uuid', status: 'completed', endedAt: T0 });
    await services.studySessionRepository.createIfAbsent(corrupt);
    const res = await app.inject({ method: 'GET', url: '/api/v1/study-sessions/history' });
    expect(res.statusCode).toBe(500);
    expect(res.json().error).toBe('study_session_history_data_corrupt');
    expect(JSON.stringify(res.json())).not.toContain('not-a-uuid');
  });

  it('rejects an empty cursor as a validation failure', async () => {
    const { app } = setup();
    const res = await app.inject({ method: 'GET', url: '/api/v1/study-sessions/history?cursor=' });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('validation_failed');
  });

  it('rejects unknown query fields, including identity fields like actorId', async () => {
    const { app } = setup();
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/study-sessions/history?limit=20&actorId=x',
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('validation_failed');
  });

  it('static route wins over the parameterized /:id route', async () => {
    const { app } = setup();
    const history = await app.inject({ method: 'GET', url: '/api/v1/study-sessions/history' });
    expect(history.statusCode).toBe(200);
    const unknown = await app.inject({ method: 'GET', url: `/api/v1/study-sessions/${uuid()}` });
    expect(unknown.statusCode).toBe(404);
    expect(unknown.json().error).toBe('study_session_not_found');
  });
});
