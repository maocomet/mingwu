import { describe, expect, it } from 'vitest';
import type { StudySession } from '@mingwu/contracts';
import { SUMMARY_CONTENT_MAX_LENGTH } from '@mingwu/contracts';
import { StudySummaryService } from '../src/application/study-summary/study-summary-service.js';
import {
  StudySummaryContentInvalidError,
  StudySummaryExpectedRevisionInvalidError,
  StudySummaryIdempotencyConflictError,
  StudySummaryNotFoundError,
  StudySummaryRevisionConflictError,
  StudySummarySessionNotTerminalError,
} from '../src/domain/study-summary/errors.js';
import { StudySessionNotFoundError } from '../src/domain/study-session/errors.js';
import type { StudySessionRepository } from '../src/domain/study-session/repository.js';
import type { StudySummaryRepository } from '../src/domain/study-summary/repository.js';
import { makeServices, makeStudySession, makeStudySummary, uuid } from './helpers.js';

function setup(now?: () => string) {
  const { studySummaryRepository, studySessionRepository } = makeServices();
  const service = new StudySummaryService(studySummaryRepository, studySessionRepository, now);
  return { service, studySummaryRepository, studySessionRepository };
}

/** 直接向仓储播种一个终态 Session，绕过 API 无法产生的状态。 */
async function seedTerminalSession(
  repository: StudySessionRepository,
  overrides: Partial<StudySession> = {},
): Promise<StudySession> {
  const session = makeStudySession({
    status: 'completed',
    endedAt: '2026-01-01T08:00:00.000Z',
    ...overrides,
  });
  await repository.createIfAbsent(session);
  return session;
}

/** 直接向仓储播种一个已有总结，用于测试更新路径与 GET。 */
async function seedSummary(
  repository: StudySummaryRepository,
  studySessionId: string,
  overrides: Parameters<typeof makeStudySummary>[0] = {},
) {
  const summary = makeStudySummary({ studySessionId, ...overrides });
  await repository.createIfAbsent(summary);
  return summary;
}

describe('StudySummaryService.getBySessionId', () => {
  it('returns the existing summary for a terminal session', async () => {
    const { service, studySessionRepository, studySummaryRepository } = setup();
    const session = await seedTerminalSession(studySessionRepository);
    const summary = await seedSummary(studySummaryRepository, session.id);
    await expect(service.getBySessionId(session.id)).resolves.toEqual(summary);
  });

  it('throws StudySessionNotFoundError when the session does not exist', async () => {
    const { service } = setup();
    await expect(service.getBySessionId(uuid())).rejects.toBeInstanceOf(StudySessionNotFoundError);
  });

  it('throws StudySummaryNotFoundError when the session exists but has no summary', async () => {
    const { service, studySessionRepository } = setup();
    const session = await seedTerminalSession(studySessionRepository);
    await expect(service.getBySessionId(session.id)).rejects.toBeInstanceOf(
      StudySummaryNotFoundError,
    );
  });
});

describe('StudySummaryService.putBySessionId create (expectedRevision = 0)', () => {
  it('creates a summary with server-generated invariants and created=true', async () => {
    const now = '2026-01-02T09:30:00.000Z';
    const { service, studySessionRepository } = setup(() => now);
    const session = await seedTerminalSession(studySessionRepository);
    const result = await service.putBySessionId(session.id, {
      content: '  今天完成了 30 分钟专注学习  ',
      source: 'user',
      expectedRevision: 0,
    });
    expect(result.created).toBe(true);
    const s = result.summary;
    expect(s.studySessionId).toBe(session.id);
    expect(s.content).toBe('今天完成了 30 分钟专注学习');
    expect(s.source).toBe('user');
    expect(s.revision).toBe(1);
    expect(typeof s.id).toBe('string');
    expect(s.id).not.toBe(session.id);
    expect(s.confirmedByUserAt).toBe(now);
    expect(s.createdAt).toBe(now);
    expect(s.updatedAt).toBe(now);
  });

  it('throws StudySessionNotFoundError when the session does not exist', async () => {
    const { service } = setup();
    await expect(
      service.putBySessionId(uuid(), { content: '总结', source: 'user', expectedRevision: 0 }),
    ).rejects.toBeInstanceOf(StudySessionNotFoundError);
  });

  it('throws StudySummarySessionNotTerminalError for a non-terminal session', async () => {
    const { service, studySessionRepository } = setup();
    const running = await seedTerminalSession(studySessionRepository, {
      status: 'running',
      startedAt: '2026-01-01T08:00:00.000Z',
      endedAt: null,
    });
    await expect(
      service.putBySessionId(running.id, { content: '总结', source: 'user', expectedRevision: 0 }),
    ).rejects.toBeInstanceOf(StudySummarySessionNotTerminalError);
  });

  it('throws StudySummaryContentInvalidError for whitespace-only or oversized content', async () => {
    const { service, studySessionRepository } = setup();
    const session = await seedTerminalSession(studySessionRepository);
    await expect(
      service.putBySessionId(session.id, {
        content: '   ',
        source: 'user',
        expectedRevision: 0,
      }),
    ).rejects.toBeInstanceOf(StudySummaryContentInvalidError);
    await expect(
      service.putBySessionId(session.id, {
        content: 'x'.repeat(SUMMARY_CONTENT_MAX_LENGTH + 1),
        source: 'user',
        expectedRevision: 0,
      }),
    ).rejects.toBeInstanceOf(StudySummaryContentInvalidError);
  });

  it('accepts content at exactly max Unicode code points (emoji)', async () => {
    const { service, studySessionRepository } = setup();
    const session = await seedTerminalSession(studySessionRepository);
    // 5000 个 emoji 的 UTF-16 length 是 10000，但 code point 数正好 5000；
    // 服务层必须与 JSON Schema maxLength 一样按 code point 计数，否则这里会误拒。
    const result = await service.putBySessionId(session.id, {
      content: '😀'.repeat(SUMMARY_CONTENT_MAX_LENGTH),
      source: 'user',
      expectedRevision: 0,
    });
    expect(result.created).toBe(true);
    expect(result.summary.revision).toBe(1);
    expect(result.summary.content.length).toBe(SUMMARY_CONTENT_MAX_LENGTH * 2);
  });

  it('rejects content beyond max Unicode code points (emoji)', async () => {
    const { service, studySessionRepository } = setup();
    const session = await seedTerminalSession(studySessionRepository);
    await expect(
      service.putBySessionId(session.id, {
        content: '😀'.repeat(SUMMARY_CONTENT_MAX_LENGTH + 1),
        source: 'user',
        expectedRevision: 0,
      }),
    ).rejects.toBeInstanceOf(StudySummaryContentInvalidError);
  });

  it('throws StudySummaryExpectedRevisionInvalidError for negative or non-integer revisions', async () => {
    const { service, studySessionRepository } = setup();
    const session = await seedTerminalSession(studySessionRepository);
    await expect(
      service.putBySessionId(session.id, { content: '总结', source: 'user', expectedRevision: -1 }),
    ).rejects.toBeInstanceOf(StudySummaryExpectedRevisionInvalidError);
    await expect(
      service.putBySessionId(session.id, {
        content: '总结',
        source: 'user',
        expectedRevision: 1.5,
      }),
    ).rejects.toBeInstanceOf(StudySummaryExpectedRevisionInvalidError);
  });

  it('is idempotent: retrying the same content and source returns the existing summary', async () => {
    const { service, studySessionRepository } = setup();
    const session = await seedTerminalSession(studySessionRepository);
    const payload = { content: '总结内容', source: 'user' as const, expectedRevision: 0 };
    const first = await service.putBySessionId(session.id, payload);
    expect(first.created).toBe(true);
    const retry = await service.putBySessionId(session.id, payload);
    expect(retry.created).toBe(false);
    expect(retry.summary).toEqual(first.summary);
    expect(retry.summary.revision).toBe(1);
  });

  it('throws StudySummaryIdempotencyConflictError on a retry with different content and never overwrites', async () => {
    const { service, studySessionRepository, studySummaryRepository } = setup();
    const session = await seedTerminalSession(studySessionRepository);
    await service.putBySessionId(session.id, {
      content: '原始总结',
      source: 'user',
      expectedRevision: 0,
    });
    await expect(
      service.putBySessionId(session.id, {
        content: '不同的总结',
        source: 'user',
        expectedRevision: 0,
      }),
    ).rejects.toBeInstanceOf(StudySummaryIdempotencyConflictError);
    const stored = await studySummaryRepository.findByStudySessionId(session.id);
    expect(stored!.content).toBe('原始总结');
    expect(stored!.revision).toBe(1);
  });
});

describe('StudySummaryService.putBySessionId update (expectedRevision > 0)', () => {
  it('updates content, bumps revision and refreshes confirmedByUserAt and updatedAt', async () => {
    let t = '2026-01-02T09:30:00.000Z';
    const { service, studySessionRepository, studySummaryRepository } = setup(() => t);
    const session = await seedTerminalSession(studySessionRepository);
    const created = await service.putBySessionId(session.id, {
      content: '第一版',
      source: 'user',
      expectedRevision: 0,
    });
    t = '2026-01-02T10:00:00.000Z';
    const result = await service.putBySessionId(session.id, {
      content: '修订后的总结',
      source: 'ai_assisted',
      expectedRevision: 1,
    });
    expect(result.created).toBe(false);
    const s = result.summary;
    expect(s.id).toBe(created.summary.id);
    expect(s.studySessionId).toBe(session.id);
    expect(s.content).toBe('修订后的总结');
    expect(s.source).toBe('ai_assisted');
    expect(s.revision).toBe(2);
    expect(s.createdAt).toBe(created.summary.createdAt);
    expect(s.confirmedByUserAt).toBe(t);
    expect(s.updatedAt).toBe(t);
    const stored = await studySummaryRepository.findByStudySessionId(session.id);
    expect(stored!.content).toBe('修订后的总结');
    expect(stored!.revision).toBe(2);
  });

  it('throws StudySummaryRevisionConflictError on a stale expectedRevision without overwriting', async () => {
    const { service, studySessionRepository, studySummaryRepository } = setup();
    const session = await seedTerminalSession(studySessionRepository);
    await service.putBySessionId(session.id, {
      content: '原始总结',
      source: 'user',
      expectedRevision: 0,
    });
    await expect(
      service.putBySessionId(session.id, {
        content: '陈旧写入',
        source: 'user',
        expectedRevision: 99,
      }),
    ).rejects.toBeInstanceOf(StudySummaryRevisionConflictError);
    const stored = await studySummaryRepository.findByStudySessionId(session.id);
    expect(stored!.content).toBe('原始总结');
    expect(stored!.revision).toBe(1);
  });

  it('throws StudySummaryRevisionConflictError when updating a session with no summary yet', async () => {
    const { service, studySessionRepository } = setup();
    const session = await seedTerminalSession(studySessionRepository);
    await expect(
      service.putBySessionId(session.id, {
        content: '总结',
        source: 'user',
        expectedRevision: 1,
      }),
    ).rejects.toBeInstanceOf(StudySummaryRevisionConflictError);
  });

  it('applies only one revision per CAS even under concurrent updates with the same revision', async () => {
    const { service, studySessionRepository, studySummaryRepository } = setup();
    const session = await seedTerminalSession(studySessionRepository);
    await service.putBySessionId(session.id, {
      content: '初始',
      source: 'user',
      expectedRevision: 0,
    });
    const results = await Promise.allSettled(
      Array.from({ length: 20 }, () =>
        service.putBySessionId(session.id, {
          content: '并发修改',
          source: 'user',
          expectedRevision: 1,
        }),
      ),
    );
    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(19);
    for (const r of rejected) {
      expect((r as PromiseRejectedResult).reason).toBeInstanceOf(StudySummaryRevisionConflictError);
    }
    const stored = await studySummaryRepository.findByStudySessionId(session.id);
    expect(stored!.content).toBe('并发修改');
    expect(stored!.revision).toBe(2);
  });
});
