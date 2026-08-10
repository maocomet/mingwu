import { describe, expect, it } from 'vitest';
import type { CreateStudySessionInput, StudySession } from '@mingwu/contracts';
import { TASK_TEXT_MAX_LENGTH } from '@mingwu/contracts';
import { StudySessionService } from '../src/application/study-session/study-session-service.js';
import {
  StudySessionIdempotencyConflictError,
  StudySessionNotFoundError,
  StudySessionPlannedDurationInvalidError,
  StudySessionStatusConflictError,
  StudySessionTaskTextInvalidError,
  StudySessionTimerModeConflictError,
  StudySessionVersionConflictError,
} from '../src/domain/study-session/errors.js';
import type { StudySessionRepository } from '../src/domain/study-session/repository.js';
import { makeServices, makeStudySession, uuid } from './helpers.js';

function setup() {
  const { studySessionRepository } = makeServices();
  const service = new StudySessionService(studySessionRepository);
  return { service, studySessionRepository };
}

/** 直接向仓储播种 Session，用于测试服务层不变量（绕过 API 无法产生的状态）。 */
async function seedSession(
  repository: StudySessionRepository,
  overrides: Partial<StudySession> = {},
): Promise<StudySession> {
  const session = makeStudySession(overrides);
  await repository.createIfAbsent(session);
  return session;
}

describe('StudySessionService.createStudySession', () => {
  it('creates a count_down session with task and duration and all create invariants', async () => {
    const { service } = setup();
    const id = uuid();
    const result = await service.createStudySession({
      id,
      timerMode: 'count_down',
      taskText: '  做完 5 道数学题  ',
      plannedDurationSeconds: 1800,
    });
    expect(result.created).toBe(true);
    const s = result.studySession;
    expect(s.id).toBe(id);
    expect(s.timerMode).toBe('count_down');
    expect(s.taskText).toBe('做完 5 道数学题');
    expect(s.plannedDurationSeconds).toBe(1800);
    expect(s.status).toBe('created');
    expect(s.version).toBe(1);
    expect(s.startedAt).toBeNull();
    expect(s.endedAt).toBeNull();
    expect(s.actualDurationSeconds).toBe(0);
    expect(s.pausedDurationSeconds).toBe(0);
    expect(typeof s.createdAt).toBe('string');
    expect(s.updatedAt).toBe(s.createdAt);
  });

  it('creates a count_down draft with no task and no duration', async () => {
    const { service } = setup();
    const result = await service.createStudySession({ id: uuid(), timerMode: 'count_down' });
    expect(result.created).toBe(true);
    expect(result.studySession.taskText).toBeNull();
    expect(result.studySession.plannedDurationSeconds).toBeNull();
  });

  it('normalizes a whitespace-only taskText to null', async () => {
    const { service } = setup();
    const result = await service.createStudySession({
      id: uuid(),
      timerMode: 'count_down',
      taskText: '   ',
    });
    expect(result.studySession.taskText).toBeNull();
  });

  it('creates a count_up session without a duration', async () => {
    const { service } = setup();
    const result = await service.createStudySession({ id: uuid(), timerMode: 'count_up' });
    expect(result.created).toBe(true);
    expect(result.studySession.timerMode).toBe('count_up');
    expect(result.studySession.plannedDurationSeconds).toBeNull();
  });

  it('rejects a count_up session carrying a countdown duration with a mode conflict', async () => {
    const { service } = setup();
    const id = uuid();
    await expect(
      service.createStudySession({ id, timerMode: 'count_up', plannedDurationSeconds: 600 }),
    ).rejects.toBeInstanceOf(StudySessionTimerModeConflictError);
  });

  it('rejects out-of-range and non-integer durations at the service layer', async () => {
    const { service } = setup();
    for (const plannedDurationSeconds of [0, 86401, 1.5, -1]) {
      await expect(
        service.createStudySession({
          id: uuid(),
          timerMode: 'count_down',
          plannedDurationSeconds,
        }),
      ).rejects.toBeInstanceOf(StudySessionPlannedDurationInvalidError);
    }
  });

  it('rejects a taskText longer than the limit at the service layer', async () => {
    const { service } = setup();
    await expect(
      service.createStudySession({
        id: uuid(),
        timerMode: 'count_down',
        taskText: 'x'.repeat(TASK_TEXT_MAX_LENGTH + 1),
      }),
    ).rejects.toBeInstanceOf(StudySessionTaskTextInvalidError);
  });

  it('accepts the boundary durations 1 and 86400 at the service layer', async () => {
    const { service } = setup();
    for (const plannedDurationSeconds of [1, 86400]) {
      const result = await service.createStudySession({
        id: uuid(),
        timerMode: 'count_down',
        plannedDurationSeconds,
      });
      expect(result.studySession.plannedDurationSeconds).toBe(plannedDurationSeconds);
    }
  });

  it('is idempotent: retrying the same id and content returns the existing session', async () => {
    const { service } = setup();
    const input: CreateStudySessionInput = {
      id: uuid(),
      timerMode: 'count_down',
      taskText: '复习英语',
      plannedDurationSeconds: 3600,
    };
    const first = await service.createStudySession(input);
    const retry = await service.createStudySession(input);
    expect(retry.created).toBe(false);
    expect(retry.studySession.id).toBe(input.id);
    expect(retry.studySession.taskText).toBe('复习英语');
    expect(retry.studySession.plannedDurationSeconds).toBe(3600);
    expect(retry.studySession.version).toBe(first.studySession.version);
  });

  it('treats retries that differ only in taskText whitespace as the same semantic', async () => {
    const { service } = setup();
    const id = uuid();
    await service.createStudySession({ id, timerMode: 'count_down', taskText: '刷题' });
    const retry = await service.createStudySession({
      id,
      timerMode: 'count_down',
      taskText: '  刷题  ',
    });
    expect(retry.created).toBe(false);
  });

  it('rejects reusing the same id with different content as an idempotency conflict', async () => {
    const { service } = setup();
    const id = uuid();
    await service.createStudySession({
      id,
      timerMode: 'count_down',
      plannedDurationSeconds: 1800,
    });
    await expect(
      service.createStudySession({ id, timerMode: 'count_down', plannedDurationSeconds: 3600 }),
    ).rejects.toBeInstanceOf(StudySessionIdempotencyConflictError);
  });

  it('rejects reusing the same id with a different timer mode', async () => {
    const { service } = setup();
    const id = uuid();
    await service.createStudySession({ id, timerMode: 'count_down' });
    await expect(
      service.createStudySession({ id, timerMode: 'count_up' }),
    ).rejects.toBeInstanceOf(StudySessionIdempotencyConflictError);
  });

  it('20 concurrent creates with the same id and content: exactly one created, the rest idempotent', async () => {
    const { service } = setup();
    const input: CreateStudySessionInput = {
      id: uuid(),
      timerMode: 'count_down',
      taskText: '并发幂等',
      plannedDurationSeconds: 900,
    };
    const results = await Promise.all(
      Array.from({ length: 20 }, () => service.createStudySession(input)),
    );
    expect(results.filter((r) => r.created)).toHaveLength(1);
    expect(results.filter((r) => !r.created)).toHaveLength(19);
    for (const r of results) {
      expect(r.studySession.id).toBe(input.id);
      expect(r.studySession.taskText).toBe('并发幂等');
      expect(r.studySession.plannedDurationSeconds).toBe(900);
    }
  });
});

describe('StudySessionService.setTask', () => {
  it('sets the task text and bumps version', async () => {
    const { service, studySessionRepository } = setup();
    const session = await seedSession(studySessionRepository);
    const result = await service.setTask(session.id, {
      expectedVersion: session.version,
      taskText: '  新的学习任务  ',
    });
    expect(result.taskText).toBe('新的学习任务');
    expect(result.version).toBe(session.version + 1);
    expect(result.status).toBe('created');
    expect(result.timerMode).toBe(session.timerMode);
    expect(result.plannedDurationSeconds).toBe(session.plannedDurationSeconds);
  });

  it('throws not-found for an unknown session', async () => {
    const { service } = setup();
    await expect(
      service.setTask(uuid(), { expectedVersion: 1, taskText: '任务' }),
    ).rejects.toBeInstanceOf(StudySessionNotFoundError);
  });

  it('rejects a whitespace-only taskText as invalid', async () => {
    const { service, studySessionRepository } = setup();
    const session = await seedSession(studySessionRepository);
    await expect(
      service.setTask(session.id, { expectedVersion: session.version, taskText: '   ' }),
    ).rejects.toBeInstanceOf(StudySessionTaskTextInvalidError);
  });

  it('rejects a taskText exceeding the length limit', async () => {
    const { service, studySessionRepository } = setup();
    const session = await seedSession(studySessionRepository);
    await expect(
      service.setTask(session.id, {
        expectedVersion: session.version,
        taskText: 'x'.repeat(TASK_TEXT_MAX_LENGTH + 1),
      }),
    ).rejects.toBeInstanceOf(StudySessionTaskTextInvalidError);
  });

  it('throws a version conflict on a stale expectedVersion', async () => {
    const { service, studySessionRepository } = setup();
    const session = await seedSession(studySessionRepository);
    await service.setTask(session.id, { expectedVersion: session.version, taskText: '第一次' });
    await expect(
      service.setTask(session.id, { expectedVersion: session.version, taskText: '第二次' }),
    ).rejects.toBeInstanceOf(StudySessionVersionConflictError);
  });

  it('is a no-op when the value is unchanged: no version or updatedAt advance', async () => {
    const { service, studySessionRepository } = setup();
    const session = await seedSession(studySessionRepository, { taskText: '原任务' });
    const result = await service.setTask(session.id, {
      expectedVersion: session.version,
      taskText: '原任务',
    });
    expect(result.version).toBe(session.version);
    expect(result.updatedAt).toBe(session.updatedAt);
    expect(result.taskText).toBe('原任务');
  });

  it('no-op still throws a version conflict when the expectedVersion is stale', async () => {
    const { service, studySessionRepository } = setup();
    const session = await seedSession(studySessionRepository, { taskText: '原任务' });
    await service.setTask(session.id, { expectedVersion: session.version, taskText: '改动一次' });
    await expect(
      service.setTask(session.id, { expectedVersion: session.version, taskText: '原任务' }),
    ).rejects.toBeInstanceOf(StudySessionVersionConflictError);
  });

  it('rejects editing a session that is not in created status', async () => {
    const { service, studySessionRepository } = setup();
    const session = await seedSession(studySessionRepository, { status: 'running' });
    await expect(
      service.setTask(session.id, { expectedVersion: session.version, taskText: '任务' }),
    ).rejects.toBeInstanceOf(StudySessionStatusConflictError);
  });

  it('20 concurrent updates with the same expectedVersion: exactly one succeeds', async () => {
    const { service, studySessionRepository } = setup();
    const session = await seedSession(studySessionRepository);
    const results = await Promise.all(
      Array.from({ length: 20 }, () =>
        service
          .setTask(session.id, { expectedVersion: session.version, taskText: '并发' })
          .then(() => 'ok')
          .catch((e) =>
            e instanceof StudySessionVersionConflictError ? 'conflict' : 'other',
          ),
      ),
    );
    expect(results.filter((r) => r === 'ok')).toHaveLength(1);
    expect(results.filter((r) => r === 'conflict')).toHaveLength(19);
  });
});

describe('StudySessionService.setCountdown', () => {
  it('sets the countdown duration and bumps version', async () => {
    const { service, studySessionRepository } = setup();
    const session = await seedSession(studySessionRepository, { timerMode: 'count_down' });
    const result = await service.setCountdown(session.id, {
      expectedVersion: session.version,
      plannedDurationSeconds: 1500,
    });
    expect(result.plannedDurationSeconds).toBe(1500);
    expect(result.version).toBe(session.version + 1);
    expect(result.timerMode).toBe('count_down');
  });

  it('throws a mode conflict for a count_up session', async () => {
    const { service, studySessionRepository } = setup();
    const session = await seedSession(studySessionRepository, { timerMode: 'count_up' });
    await expect(
      service.setCountdown(session.id, {
        expectedVersion: session.version,
        plannedDurationSeconds: 600,
      }),
    ).rejects.toBeInstanceOf(StudySessionTimerModeConflictError);
  });

  it('rejects out-of-range and non-integer durations at the service layer', async () => {
    const { service, studySessionRepository } = setup();
    const session = await seedSession(studySessionRepository, { timerMode: 'count_down' });
    for (const plannedDurationSeconds of [0, 86401, 1.5]) {
      await expect(
        service.setCountdown(session.id, {
          expectedVersion: session.version,
          plannedDurationSeconds,
        }),
      ).rejects.toBeInstanceOf(StudySessionPlannedDurationInvalidError);
    }
  });

  it('throws not-found for an unknown session', async () => {
    const { service } = setup();
    await expect(
      service.setCountdown(uuid(), { expectedVersion: 1, plannedDurationSeconds: 600 }),
    ).rejects.toBeInstanceOf(StudySessionNotFoundError);
  });

  it('rejects editing a session that is not in created status', async () => {
    const { service, studySessionRepository } = setup();
    const session = await seedSession(studySessionRepository, {
      timerMode: 'count_down',
      status: 'paused',
    });
    await expect(
      service.setCountdown(session.id, {
        expectedVersion: session.version,
        plannedDurationSeconds: 600,
      }),
    ).rejects.toBeInstanceOf(StudySessionStatusConflictError);
  });

  it('throws a version conflict on a stale expectedVersion', async () => {
    const { service, studySessionRepository } = setup();
    const session = await seedSession(studySessionRepository, { timerMode: 'count_down' });
    await service.setCountdown(session.id, {
      expectedVersion: session.version,
      plannedDurationSeconds: 600,
    });
    await expect(
      service.setCountdown(session.id, {
        expectedVersion: session.version,
        plannedDurationSeconds: 1200,
      }),
    ).rejects.toBeInstanceOf(StudySessionVersionConflictError);
  });

  it('is a no-op when the value is unchanged: no version or updatedAt advance', async () => {
    const { service, studySessionRepository } = setup();
    const session = await seedSession(studySessionRepository, {
      timerMode: 'count_down',
      plannedDurationSeconds: 900,
    });
    const result = await service.setCountdown(session.id, {
      expectedVersion: session.version,
      plannedDurationSeconds: 900,
    });
    expect(result.version).toBe(session.version);
    expect(result.updatedAt).toBe(session.updatedAt);
    expect(result.plannedDurationSeconds).toBe(900);
  });

  it('no-op still throws a version conflict when the expectedVersion is stale', async () => {
    const { service, studySessionRepository } = setup();
    const session = await seedSession(studySessionRepository, {
      timerMode: 'count_down',
      plannedDurationSeconds: 900,
    });
    await service.setCountdown(session.id, {
      expectedVersion: session.version,
      plannedDurationSeconds: 1800,
    });
    await expect(
      service.setCountdown(session.id, {
        expectedVersion: session.version,
        plannedDurationSeconds: 900,
      }),
    ).rejects.toBeInstanceOf(StudySessionVersionConflictError);
  });

  it('20 concurrent updates with the same expectedVersion: exactly one succeeds', async () => {
    const { service, studySessionRepository } = setup();
    const session = await seedSession(studySessionRepository, { timerMode: 'count_down' });
    const results = await Promise.all(
      Array.from({ length: 20 }, () =>
        service
          .setCountdown(session.id, {
            expectedVersion: session.version,
            plannedDurationSeconds: 300,
          })
          .then(() => 'ok')
          .catch((e) =>
            e instanceof StudySessionVersionConflictError ? 'conflict' : 'other',
          ),
      ),
    );
    expect(results.filter((r) => r === 'ok')).toHaveLength(1);
    expect(results.filter((r) => r === 'conflict')).toHaveLength(19);
  });
});
