import { describe, expect, it } from 'vitest';
import type { StudySession } from '@mingwu/contracts';
import { SUMMARY_CONTENT_MAX_LENGTH } from '@mingwu/contracts';
import { buildApp } from '../src/app.js';
import { StudySummaryService } from '../src/application/study-summary/study-summary-service.js';
import { loadConfig } from '../src/config.js';
import { makeServices, makeStudySession, uuid } from './helpers.js';

type App = ReturnType<typeof buildApp>;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function setup(now?: () => string) {
  const config = loadConfig({ NODE_ENV: 'test' });
  const services = makeServices();
  const app = buildApp({
    config,
    projectService: services.projectService,
    stageService: services.stageService,
    taskService: services.taskService,
    projectStatusService: services.projectStatusService,
    studySessionService: services.studySessionService,
    studySummaryService: now
      ? new StudySummaryService(
          services.studySummaryRepository,
          services.studySessionRepository,
          now,
        )
      : services.studySummaryService,
    studySessionDetailService: services.studySessionDetailService,
  studySessionCurrentService: services.studySessionCurrentService,
  studyReportService: services.studyReportService,
  stageUpdateRequestService: services.stageUpdateRequestService,
  projectWorkReportService: services.projectWorkReportService,
  });
  return { app, services };
}

/** 直接向仓储播种一个终态 Session，绕过 API 无法产生的状态。 */
async function seedTerminalSession(
  services: ReturnType<typeof makeServices>,
  overrides: Partial<StudySession> = {},
): Promise<StudySession> {
  const session = makeStudySession({
    status: 'completed',
    endedAt: '2026-01-01T08:00:00.000Z',
    ...overrides,
  });
  await services.studySessionRepository.createIfAbsent(session);
  return session;
}

describe('GET /api/v1/study-sessions/:id/summary', () => {
  it('returns the summary after a PUT created it', async () => {
    const now = '2026-01-02T09:30:00.000Z';
    const { app, services } = setup(() => now);
    const session = await seedTerminalSession(services);
    await app.inject({
      method: 'PUT',
      url: `/api/v1/study-sessions/${session.id}/summary`,
      payload: { content: '今天完成了 30 分钟专注', source: 'user', expectedRevision: 0 },
    });
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/study-sessions/${session.id}/summary`,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.studySessionId).toBe(session.id);
    expect(body.content).toBe('今天完成了 30 分钟专注');
    expect(body.revision).toBe(1);
    expect(body.confirmedByUserAt).toBe(now);
    expect(body.createdAt).toBe(now);
    expect(body.updatedAt).toBe(now);
  });

  it('returns study_session_not_found when the session does not exist', async () => {
    const { app } = setup();
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/study-sessions/${uuid()}/summary`,
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe('study_session_not_found');
  });

  it('returns study_summary_not_found when the session exists but has no summary', async () => {
    const { app, services } = setup();
    const session = await seedTerminalSession(services);
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/study-sessions/${session.id}/summary`,
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe('study_summary_not_found');
  });
});

describe('PUT /api/v1/study-sessions/:id/summary', () => {
  it('creates a summary with 201 and server-generated invariants', async () => {
    const now = '2026-01-02T09:30:00.000Z';
    const { app, services } = setup(() => now);
    const session = await seedTerminalSession(services);
    const res = await app.inject({
      method: 'PUT',
      url: `/api/v1/study-sessions/${session.id}/summary`,
      payload: {
        content: '  今天完成了 30 分钟专注学习  ',
        source: 'user',
        expectedRevision: 0,
      },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.studySessionId).toBe(session.id);
    expect(body.content).toBe('今天完成了 30 分钟专注学习');
    expect(body.source).toBe('user');
    expect(body.revision).toBe(1);
    expect(body.id).toMatch(UUID_RE);
    expect(body.id).not.toBe(session.id);
    expect(body.confirmedByUserAt).toBe(now);
    expect(body.createdAt).toBe(now);
    expect(body.updatedAt).toBe(now);
  });

  it('is idempotent: retrying the same content and source returns 200 with the existing summary', async () => {
    const { app, services } = setup();
    const session = await seedTerminalSession(services);
    const payload = { content: '总结内容', source: 'user', expectedRevision: 0 };
    const first = await app.inject({
      method: 'PUT',
      url: `/api/v1/study-sessions/${session.id}/summary`,
      payload,
    });
    const retry = await app.inject({
      method: 'PUT',
      url: `/api/v1/study-sessions/${session.id}/summary`,
      payload,
    });
    expect(first.statusCode).toBe(201);
    expect(retry.statusCode).toBe(200);
    expect(retry.json()).toEqual(first.json());
  });

  it('returns a stable 409 for a retry with different content and does not overwrite', async () => {
    const { app, services } = setup();
    const session = await seedTerminalSession(services);
    await app.inject({
      method: 'PUT',
      url: `/api/v1/study-sessions/${session.id}/summary`,
      payload: { content: '原始总结', source: 'user', expectedRevision: 0 },
    });
    const res = await app.inject({
      method: 'PUT',
      url: `/api/v1/study-sessions/${session.id}/summary`,
      payload: { content: '不同的总结', source: 'user', expectedRevision: 0 },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('study_summary_idempotency_conflict');
    const get = await app.inject({
      method: 'GET',
      url: `/api/v1/study-sessions/${session.id}/summary`,
    });
    expect(get.json().content).toBe('原始总结');
  });

  it('rejects a non-terminal session with a stable 409', async () => {
    const { app, services } = setup();
    const running = await seedTerminalSession(services, {
      status: 'running',
      startedAt: '2026-01-01T08:00:00.000Z',
      endedAt: null,
    });
    const res = await app.inject({
      method: 'PUT',
      url: `/api/v1/study-sessions/${running.id}/summary`,
      payload: { content: '总结', source: 'user', expectedRevision: 0 },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('study_summary_session_not_terminal');
  });

  it('returns study_session_not_found when the session does not exist', async () => {
    const { app } = setup();
    const res = await app.inject({
      method: 'PUT',
      url: `/api/v1/study-sessions/${uuid()}/summary`,
      payload: { content: '总结', source: 'user', expectedRevision: 0 },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe('study_session_not_found');
  });

  it('updates an existing summary with expectedRevision and returns 200', async () => {
    const { app, services } = setup();
    const session = await seedTerminalSession(services);
    await app.inject({
      method: 'PUT',
      url: `/api/v1/study-sessions/${session.id}/summary`,
      payload: { content: '第一版', source: 'user', expectedRevision: 0 },
    });
    const res = await app.inject({
      method: 'PUT',
      url: `/api/v1/study-sessions/${session.id}/summary`,
      payload: { content: '修订后的总结', source: 'ai_assisted', expectedRevision: 1 },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.content).toBe('修订后的总结');
    expect(body.source).toBe('ai_assisted');
    expect(body.revision).toBe(2);
  });

  it('returns a stable 409 for a stale expectedRevision', async () => {
    const { app, services } = setup();
    const session = await seedTerminalSession(services);
    await app.inject({
      method: 'PUT',
      url: `/api/v1/study-sessions/${session.id}/summary`,
      payload: { content: '原始总结', source: 'user', expectedRevision: 0 },
    });
    const res = await app.inject({
      method: 'PUT',
      url: `/api/v1/study-sessions/${session.id}/summary`,
      payload: { content: '陈旧写入', source: 'user', expectedRevision: 99 },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('study_summary_revision_conflict');
    const get = await app.inject({
      method: 'GET',
      url: `/api/v1/study-sessions/${session.id}/summary`,
    });
    expect(get.json().content).toBe('原始总结');
  });

  it('returns a stable 409 when updating a session that has no summary yet', async () => {
    const { app, services } = setup();
    const session = await seedTerminalSession(services);
    const res = await app.inject({
      method: 'PUT',
      url: `/api/v1/study-sessions/${session.id}/summary`,
      payload: { content: '总结', source: 'user', expectedRevision: 1 },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('study_summary_revision_conflict');
  });

  it('rejects whitespace-only content after trimming with study_summary_content_invalid', async () => {
    const { app, services } = setup();
    const session = await seedTerminalSession(services);
    const res = await app.inject({
      method: 'PUT',
      url: `/api/v1/study-sessions/${session.id}/summary`,
      payload: { content: '   ', source: 'user', expectedRevision: 0 },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('study_summary_content_invalid');
  });

  it('rejects empty or oversized content at the schema level with validation_failed', async () => {
    const { app, services } = setup();
    const session = await seedTerminalSession(services);
    const empty = await app.inject({
      method: 'PUT',
      url: `/api/v1/study-sessions/${session.id}/summary`,
      payload: { content: '', source: 'user', expectedRevision: 0 },
    });
    expect(empty.statusCode).toBe(400);
    expect(empty.json().error).toBe('validation_failed');
    const oversized = await app.inject({
      method: 'PUT',
      url: `/api/v1/study-sessions/${session.id}/summary`,
      payload: { content: 'x'.repeat(5001), source: 'user', expectedRevision: 0 },
    });
    expect(oversized.statusCode).toBe(400);
    expect(oversized.json().error).toBe('validation_failed');
  });

  it('saves exactly max Unicode code points (emoji) and rejects one more', async () => {
    const { app, services } = setup();
    const session = await seedTerminalSession(services);
    const url = `/api/v1/study-sessions/${session.id}/summary`;
    // 5000 个 emoji 的 UTF-16 length 是 10000，但 code point 数正好 5000：
    // 契约 maxLength 与服务层都按 code point 计数，恰好边界应保存成功。
    const ok = await app.inject({
      method: 'PUT',
      url,
      payload: {
        content: '😀'.repeat(SUMMARY_CONTENT_MAX_LENGTH),
        source: 'user',
        expectedRevision: 0,
      },
    });
    expect(ok.statusCode).toBe(201);
    expect(ok.json().revision).toBe(1);
    // 5001 个 emoji 超过 code point 上限，schema 先行拒绝。
    const over = await app.inject({
      method: 'PUT',
      url,
      payload: {
        content: '😀'.repeat(SUMMARY_CONTENT_MAX_LENGTH + 1),
        source: 'user',
        expectedRevision: 0,
      },
    });
    expect(over.statusCode).toBe(400);
    expect(over.json().error).toBe('validation_failed');
  });

  it('rejects protected and identity fields strictly, including actorId', async () => {
    const { app, services } = setup();
    const session = await seedTerminalSession(services);
    const url = `/api/v1/study-sessions/${session.id}/summary`;
    for (const extra of [
      { actorId: 'x' },
      { id: uuid() },
      { studySessionId: session.id },
      { revision: 1 },
      { confirmedByUserAt: '2026-01-01T00:00:00.000Z' },
      { createdAt: '2026-01-01T00:00:00.000Z' },
      { updatedAt: '2026-01-01T00:00:00.000Z' },
    ]) {
      const res = await app.inject({
        method: 'PUT',
        url,
        payload: { content: '总结', source: 'user', expectedRevision: 0, ...extra },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe('validation_failed');
    }
  });

  it('rejects an invalid expectedRevision without coercion', async () => {
    const { app, services } = setup();
    const session = await seedTerminalSession(services);
    const url = `/api/v1/study-sessions/${session.id}/summary`;
    for (const expectedRevision of [-1, 1.5, '1']) {
      const res = await app.inject({
        method: 'PUT',
        url,
        payload: { content: '总结', source: 'user', expectedRevision },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe('validation_failed');
    }
  });
});
