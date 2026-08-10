import { describe, expect, it } from 'vitest';
import type { CreateStudySessionInput, StudySession } from '@mingwu/contracts';
import { TASK_TEXT_MAX_LENGTH } from '@mingwu/contracts';
import { StudySessionService } from '../src/application/study-session/study-session-service.js';
import {
  StudySessionIdempotencyConflictError,
  StudySessionNotFoundError,
  StudySessionPlannedDurationInvalidError,
  StudySessionStartPreconditionError,
  StudySessionStatusConflictError,
  StudySessionTaskTextInvalidError,
  StudySessionTimeCorruptionError,
  StudySessionTimerModeConflictError,
  StudySessionVersionConflictError,
} from '../src/domain/study-session/errors.js';
import type { StudySessionRepository } from '../src/domain/study-session/repository.js';
import { makeServices, makeStudySession, uuid } from './helpers.js';

function setup(now?: () => string) {
  const { studySessionRepository } = makeServices();
  const service = new StudySessionService(studySessionRepository, now);
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

describe('StudySessionService.startStudySession', () => {
  const FIXED_NOW = '2026-01-01T08:00:00.000Z';

  it('starts a count_down session and writes server-side startedAt', async () => {
    const { service, studySessionRepository } = setup(() => FIXED_NOW);
    const session = await seedSession(studySessionRepository, {
      timerMode: 'count_down',
      taskText: '背 50 个单词',
      plannedDurationSeconds: 600,
    });
    const result = await service.startStudySession(session.id, {
      expectedVersion: session.version,
    });
    expect(result.status).toBe('running');
    expect(result.startedAt).toBe(FIXED_NOW);
    expect(result.updatedAt).toBe(FIXED_NOW);
    expect(result.version).toBe(session.version + 1);
    expect(result.endedAt).toBeNull();
    expect(result.actualDurationSeconds).toBe(0);
    expect(result.pausedDurationSeconds).toBe(0);
    expect(result.taskText).toBe('背 50 个单词');
  });

  it('starts a count_up session without a duration', async () => {
    const { service, studySessionRepository } = setup(() => FIXED_NOW);
    const session = await seedSession(studySessionRepository, {
      timerMode: 'count_up',
      taskText: '专注工作',
    });
    const result = await service.startStudySession(session.id, {
      expectedVersion: session.version,
    });
    expect(result.status).toBe('running');
    expect(result.timerMode).toBe('count_up');
    expect(result.plannedDurationSeconds).toBeNull();
    expect(result.startedAt).toBe(FIXED_NOW);
  });

  it('rejects starting without a task with reason missing_task', async () => {
    const { service, studySessionRepository } = setup();
    const session = await seedSession(studySessionRepository, {
      timerMode: 'count_down',
      plannedDurationSeconds: 600,
    });
    await expect(
      service.startStudySession(session.id, { expectedVersion: session.version }),
    ).rejects.toMatchObject({ reason: 'missing_task' });
  });

  it('rejects starting a count_down session without a duration with reason missing_duration', async () => {
    const { service, studySessionRepository } = setup();
    const session = await seedSession(studySessionRepository, {
      timerMode: 'count_down',
      taskText: '任务',
    });
    await expect(
      service.startStudySession(session.id, { expectedVersion: session.version }),
    ).rejects.toMatchObject({ reason: 'missing_duration' });
  });

  it('rejects starting a count_down session with an illegal stored duration with reason invalid_duration', async () => {
    const { service, studySessionRepository } = setup();
    for (const plannedDurationSeconds of [0, 86401, 1.5]) {
      const session = await seedSession(studySessionRepository, {
        timerMode: 'count_down',
        taskText: '任务',
        plannedDurationSeconds,
      });
      await expect(
        service.startStudySession(session.id, { expectedVersion: session.version }),
      ).rejects.toMatchObject({ reason: 'invalid_duration' });
    }
  });

  it('samples the server time exactly once for a successful start', async () => {
    let calls = 0;
    const countingClock = () => {
      calls += 1;
      return '2026-01-01T08:00:00.000Z';
    };
    const { service, studySessionRepository } = setup(countingClock);
    const session = await seedSession(studySessionRepository, {
      timerMode: 'count_down',
      taskText: '任务',
      plannedDurationSeconds: 600,
    });
    const result = await service.startStudySession(session.id, {
      expectedVersion: session.version,
    });
    expect(calls).toBe(1);
    expect(result.startedAt).toBe('2026-01-01T08:00:00.000Z');
    expect(result.updatedAt).toBe('2026-01-01T08:00:00.000Z');
  });

  it('rejects a count_up session carrying a duration with reason count_up_duration_set', async () => {
    const { service, studySessionRepository } = setup();
    const session = await seedSession(studySessionRepository, {
      timerMode: 'count_up',
      taskText: '任务',
      plannedDurationSeconds: 600,
    });
    await expect(
      service.startStudySession(session.id, { expectedVersion: session.version }),
    ).rejects.toMatchObject({ reason: 'count_up_duration_set' });
  });

  it('throws a status conflict for a non-created session without rewriting startedAt', async () => {
    const { service, studySessionRepository } = setup();
    const session = await seedSession(studySessionRepository, {
      status: 'running',
      startedAt: '2026-01-01T01:00:00.000Z',
    });
    await expect(
      service.startStudySession(session.id, { expectedVersion: session.version }),
    ).rejects.toBeInstanceOf(StudySessionStatusConflictError);
    const latest = await studySessionRepository.findById(session.id);
    expect(latest!.startedAt).toBe('2026-01-01T01:00:00.000Z');
    expect(latest!.version).toBe(session.version);
  });

  it('throws a version conflict on a stale expectedVersion', async () => {
    const { service, studySessionRepository } = setup();
    const session = await seedSession(studySessionRepository, {
      timerMode: 'count_down',
      taskText: '任务',
      plannedDurationSeconds: 600,
    });
    await expect(
      service.startStudySession(session.id, { expectedVersion: session.version + 99 }),
    ).rejects.toBeInstanceOf(StudySessionVersionConflictError);
  });

  it('20 concurrent starts with the same expectedVersion: exactly one succeeds and startedAt is written once', async () => {
    const { service, studySessionRepository } = setup(() => FIXED_NOW);
    const session = await seedSession(studySessionRepository, {
      timerMode: 'count_down',
      taskText: '并发开始',
      plannedDurationSeconds: 600,
    });
    const results = await Promise.all(
      Array.from({ length: 20 }, () =>
        service
          .startStudySession(session.id, { expectedVersion: session.version })
          .then(() => 'ok')
          .catch((e) =>
            e instanceof StudySessionVersionConflictError ? 'conflict' : 'other',
          ),
      ),
    );
    expect(results.filter((r) => r === 'ok')).toHaveLength(1);
    expect(results.filter((r) => r === 'conflict')).toHaveLength(19);
    const latest = await studySessionRepository.findById(session.id);
    expect(latest!.status).toBe('running');
    expect(latest!.startedAt).toBe(FIXED_NOW);
    expect(latest!.version).toBe(session.version + 1);
  });
});

describe('StudySessionService.pauseStudySession', () => {
  const FIXED_NOW = '2026-01-01T08:00:00.000Z';

  it('pauses a running session and writes server-side pausedAt', async () => {
    const { service, studySessionRepository } = setup(() => FIXED_NOW);
    const session = await seedSession(studySessionRepository, {
      timerMode: 'count_down',
      taskText: '任务',
      plannedDurationSeconds: 600,
      status: 'running',
      startedAt: '2026-01-01T08:00:00.000Z',
    });
    const result = await service.pauseStudySession(session.id, {
      expectedVersion: session.version,
    });
    expect(result.status).toBe('paused');
    expect(result.pausedAt).toBe(FIXED_NOW);
    expect(result.updatedAt).toBe(FIXED_NOW);
    expect(result.version).toBe(session.version + 1);
    expect(result.startedAt).toBe('2026-01-01T08:00:00.000Z');
    expect(result.taskText).toBe('任务');
    expect(result.actualDurationSeconds).toBe(0);
    expect(result.pausedDurationSeconds).toBe(0);
  });

  it('rejects pausing a session that is not running', async () => {
    const { service, studySessionRepository } = setup();
    const session = await seedSession(studySessionRepository, {
      status: 'created',
      taskText: '任务',
      plannedDurationSeconds: 600,
    });
    await expect(
      service.pauseStudySession(session.id, { expectedVersion: session.version }),
    ).rejects.toBeInstanceOf(StudySessionStatusConflictError);
  });

  it('rejects pausing when startedAt is missing (time corruption)', async () => {
    const { service, studySessionRepository } = setup();
    const session = await seedSession(studySessionRepository, { status: 'running' });
    await expect(
      service.pauseStudySession(session.id, { expectedVersion: session.version }),
    ).rejects.toBeInstanceOf(StudySessionTimeCorruptionError);
  });

  it('rejects pausing when pausedAt is already set (time corruption)', async () => {
    const { service, studySessionRepository } = setup();
    const session = await seedSession(studySessionRepository, {
      status: 'running',
      startedAt: '2026-01-01T08:00:00.000Z',
      pausedAt: '2026-01-01T08:00:00.000Z',
    });
    await expect(
      service.pauseStudySession(session.id, { expectedVersion: session.version }),
    ).rejects.toBeInstanceOf(StudySessionTimeCorruptionError);
  });

  it('does not rewrite pausedAt on a repeated pause', async () => {
    const { service, studySessionRepository } = setup(() => FIXED_NOW);
    const session = await seedSession(studySessionRepository, {
      timerMode: 'count_down',
      taskText: '任务',
      plannedDurationSeconds: 600,
      status: 'running',
      startedAt: '2026-01-01T08:00:00.000Z',
    });
    const paused = await service.pauseStudySession(session.id, {
      expectedVersion: session.version,
    });
    await expect(
      service.pauseStudySession(session.id, { expectedVersion: paused.version }),
    ).rejects.toBeInstanceOf(StudySessionStatusConflictError);
    const latest = await studySessionRepository.findById(session.id);
    expect(latest!.status).toBe('paused');
    expect(latest!.pausedAt).toBe(FIXED_NOW);
    expect(latest!.version).toBe(paused.version);
  });

  it('throws a version conflict on a stale expectedVersion', async () => {
    const { service, studySessionRepository } = setup();
    const session = await seedSession(studySessionRepository, {
      status: 'running',
      startedAt: '2026-01-01T08:00:00.000Z',
    });
    await expect(
      service.pauseStudySession(session.id, { expectedVersion: session.version + 99 }),
    ).rejects.toBeInstanceOf(StudySessionVersionConflictError);
  });

  it('rejects pausing when the server clock is unparseable (time corruption) and keeps the store unchanged', async () => {
    const { service, studySessionRepository } = setup(() => 'not-a-time');
    const session = await seedSession(studySessionRepository, {
      status: 'running',
      startedAt: '2026-01-01T08:00:00.000Z',
    });
    await expect(
      service.pauseStudySession(session.id, { expectedVersion: session.version }),
    ).rejects.toBeInstanceOf(StudySessionTimeCorruptionError);
    const latest = await studySessionRepository.findById(session.id);
    expect(latest!.status).toBe('running');
    expect(latest!.startedAt).toBe('2026-01-01T08:00:00.000Z');
    expect(latest!.pausedAt).toBeNull();
    expect(latest!.version).toBe(session.version);
  });

  it('rejects pausing when the server clock is earlier than startedAt (time corruption) and keeps the store unchanged', async () => {
    const { service, studySessionRepository } = setup(() => '2026-01-01T07:00:00.000Z');
    const session = await seedSession(studySessionRepository, {
      status: 'running',
      startedAt: '2026-01-01T08:00:00.000Z',
    });
    await expect(
      service.pauseStudySession(session.id, { expectedVersion: session.version }),
    ).rejects.toBeInstanceOf(StudySessionTimeCorruptionError);
    const latest = await studySessionRepository.findById(session.id);
    expect(latest!.status).toBe('running');
    expect(latest!.pausedAt).toBeNull();
    expect(latest!.version).toBe(session.version);
  });

  it('samples the server clock exactly once on a successful pause', async () => {
    let calls = 0;
    const clock = () => {
      calls += 1;
      return '2026-01-01T08:00:00.000Z';
    };
    const { service, studySessionRepository } = setup(clock);
    const session = await seedSession(studySessionRepository, {
      status: 'running',
      startedAt: '2026-01-01T08:00:00.000Z',
    });
    await service.pauseStudySession(session.id, { expectedVersion: session.version });
    expect(calls).toBe(1);
  });

  it('20 concurrent pauses with the same expectedVersion: exactly one succeeds', async () => {
    const { service, studySessionRepository } = setup(() => FIXED_NOW);
    const session = await seedSession(studySessionRepository, {
      status: 'running',
      startedAt: '2026-01-01T08:00:00.000Z',
    });
    const results = await Promise.all(
      Array.from({ length: 20 }, () =>
        service
          .pauseStudySession(session.id, { expectedVersion: session.version })
          .then(() => 'ok')
          .catch((e) =>
            e instanceof StudySessionVersionConflictError ? 'conflict' : 'other',
          ),
      ),
    );
    expect(results.filter((r) => r === 'ok')).toHaveLength(1);
    expect(results.filter((r) => r === 'conflict')).toHaveLength(19);
    const latest = await studySessionRepository.findById(session.id);
    expect(latest!.status).toBe('paused');
    expect(latest!.pausedAt).toBe(FIXED_NOW);
    expect(latest!.version).toBe(session.version + 1);
  });
});

describe('StudySessionService.resumeStudySession', () => {
  const FIXED_NOW = '2026-01-01T08:00:00.000Z';

  it('resumes a paused session and accumulates whole seconds from pausedAt', async () => {
    let current = Date.parse('2026-01-01T08:00:00.000Z');
    const clock = () => new Date(current).toISOString();
    const { service, studySessionRepository } = setup(clock);
    const session = await seedSession(studySessionRepository, {
      timerMode: 'count_down',
      taskText: '任务',
      plannedDurationSeconds: 600,
      status: 'running',
      startedAt: clock(),
    });
    const paused = await service.pauseStudySession(session.id, {
      expectedVersion: session.version,
    });
    expect(paused.pausedAt).toBe('2026-01-01T08:00:00.000Z');
    current += 65_900; // 暂停 65.9 秒 → 整秒 65
    const result = await service.resumeStudySession(paused.id, {
      expectedVersion: paused.version,
    });
    expect(result.status).toBe('running');
    expect(result.pausedAt).toBeNull();
    expect(result.pausedDurationSeconds).toBe(65);
    expect(result.startedAt).toBe('2026-01-01T08:00:00.000Z');
    expect(result.version).toBe(paused.version + 1);
  });

  it('accumulates across multiple pause/resume rounds', async () => {
    let current = Date.parse('2026-01-01T08:00:00.000Z');
    const clock = () => new Date(current).toISOString();
    const { service, studySessionRepository } = setup(clock);
    const session = await seedSession(studySessionRepository, {
      timerMode: 'count_down',
      taskText: '任务',
      plannedDurationSeconds: 600,
      status: 'running',
      startedAt: clock(),
    });
    let s = session;
    // 第 1 轮：65.9 秒 → 65
    await service.pauseStudySession(s.id, { expectedVersion: s.version });
    current += 65_900;
    s = await service.resumeStudySession(s.id, { expectedVersion: s.version + 1 });
    expect(s.pausedDurationSeconds).toBe(65);
    // 第 2 轮：60 秒 → 累计 125
    await service.pauseStudySession(s.id, { expectedVersion: s.version });
    current += 60_000;
    s = await service.resumeStudySession(s.id, { expectedVersion: s.version + 1 });
    expect(s.pausedDurationSeconds).toBe(125);
    expect(s.startedAt).toBe('2026-01-01T08:00:00.000Z');
  });

  it('pauses and resumes a count_up session too', async () => {
    const { service, studySessionRepository } = setup(() => FIXED_NOW);
    const session = await seedSession(studySessionRepository, {
      timerMode: 'count_up',
      taskText: '专注',
      status: 'running',
      startedAt: FIXED_NOW,
    });
    const paused = await service.pauseStudySession(session.id, {
      expectedVersion: session.version,
    });
    expect(paused.status).toBe('paused');
    expect(paused.plannedDurationSeconds).toBeNull();
    const resumed = await service.resumeStudySession(paused.id, {
      expectedVersion: paused.version,
    });
    expect(resumed.status).toBe('running');
    expect(resumed.pausedAt).toBeNull();
    expect(resumed.pausedDurationSeconds).toBe(0);
  });

  it('rejects resuming a session that is not paused', async () => {
    const { service, studySessionRepository } = setup();
    const session = await seedSession(studySessionRepository, {
      status: 'running',
      startedAt: FIXED_NOW,
    });
    await expect(
      service.resumeStudySession(session.id, { expectedVersion: session.version }),
    ).rejects.toBeInstanceOf(StudySessionStatusConflictError);
  });

  it('rejects resuming when pausedAt is earlier than startedAt (time corruption) and keeps the store unchanged', async () => {
    const { service, studySessionRepository } = setup(() => FIXED_NOW);
    const session = await seedSession(studySessionRepository, {
      status: 'paused',
      startedAt: '2026-01-01T09:00:00.000Z',
      pausedAt: '2026-01-01T08:00:00.000Z',
    });
    await expect(
      service.resumeStudySession(session.id, { expectedVersion: session.version }),
    ).rejects.toBeInstanceOf(StudySessionTimeCorruptionError);
    const latest = await studySessionRepository.findById(session.id);
    expect(latest!.status).toBe('paused');
    expect(latest!.pausedAt).toBe('2026-01-01T08:00:00.000Z');
    expect(latest!.version).toBe(session.version);
  });

  it('rejects resuming when the server time is earlier than pausedAt (time corruption)', async () => {
    let current = Date.parse('2026-01-01T08:00:00.000Z');
    const clock = () => new Date(current).toISOString();
    const { service, studySessionRepository } = setup(clock);
    const session = await seedSession(studySessionRepository, {
      status: 'paused',
      startedAt: '2026-01-01T08:00:00.000Z',
      pausedAt: '2026-01-01T08:00:00.000Z',
    });
    current -= 60_000; // 服务器时间倒退到 pausedAt 之前
    await expect(
      service.resumeStudySession(session.id, { expectedVersion: session.version }),
    ).rejects.toBeInstanceOf(StudySessionTimeCorruptionError);
  });

  it('rejects resuming when the time fields are unparseable (time corruption)', async () => {
    const { service, studySessionRepository } = setup();
    const session = await seedSession(studySessionRepository, {
      status: 'paused',
      startedAt: 'not-a-time',
      pausedAt: 'also-not-a-time',
    });
    await expect(
      service.resumeStudySession(session.id, { expectedVersion: session.version }),
    ).rejects.toBeInstanceOf(StudySessionTimeCorruptionError);
  });

  it('throws a version conflict on a stale expectedVersion', async () => {
    const { service, studySessionRepository } = setup();
    const session = await seedSession(studySessionRepository, {
      status: 'paused',
      startedAt: FIXED_NOW,
      pausedAt: FIXED_NOW,
    });
    await expect(
      service.resumeStudySession(session.id, { expectedVersion: session.version + 99 }),
    ).rejects.toBeInstanceOf(StudySessionVersionConflictError);
  });

  it('rejects resuming when the server clock is unparseable (time corruption) and keeps the store unchanged', async () => {
    const { service, studySessionRepository } = setup(() => 'not-a-time');
    const session = await seedSession(studySessionRepository, {
      status: 'paused',
      startedAt: FIXED_NOW,
      pausedAt: FIXED_NOW,
    });
    await expect(
      service.resumeStudySession(session.id, { expectedVersion: session.version }),
    ).rejects.toBeInstanceOf(StudySessionTimeCorruptionError);
    const latest = await studySessionRepository.findById(session.id);
    expect(latest!.status).toBe('paused');
    expect(latest!.pausedAt).toBe(FIXED_NOW);
    expect(latest!.pausedDurationSeconds).toBe(0);
    expect(latest!.version).toBe(session.version);
  });

  it('samples the server clock exactly once on a successful resume', async () => {
    let calls = 0;
    const clock = () => {
      calls += 1;
      return FIXED_NOW;
    };
    const { service, studySessionRepository } = setup(clock);
    const session = await seedSession(studySessionRepository, {
      status: 'paused',
      startedAt: FIXED_NOW,
      pausedAt: FIXED_NOW,
    });
    await service.resumeStudySession(session.id, { expectedVersion: session.version });
    expect(calls).toBe(1);
  });

  it('20 concurrent resumes with the same expectedVersion: exactly one succeeds', async () => {
    const { service, studySessionRepository } = setup(() => FIXED_NOW);
    const session = await seedSession(studySessionRepository, {
      status: 'paused',
      startedAt: FIXED_NOW,
      pausedAt: FIXED_NOW,
    });
    const results = await Promise.all(
      Array.from({ length: 20 }, () =>
        service
          .resumeStudySession(session.id, { expectedVersion: session.version })
          .then(() => 'ok')
          .catch((e) =>
            e instanceof StudySessionVersionConflictError ? 'conflict' : 'other',
          ),
      ),
    );
    expect(results.filter((r) => r === 'ok')).toHaveLength(1);
    expect(results.filter((r) => r === 'conflict')).toHaveLength(19);
    const latest = await studySessionRepository.findById(session.id);
    expect(latest!.status).toBe('running');
    expect(latest!.pausedAt).toBeNull();
    expect(latest!.version).toBe(session.version + 1);
  });
});

describe('StudySessionService.endStudySession', () => {
  const FIXED_NOW = '2026-01-01T08:00:00.000Z';
  const T0 = '2026-01-01T08:00:00.000Z';

  it('ends a running session and settles wall-clock against accumulated pauses (125.9s wall / 65s paused → 60s actual)', async () => {
    let current = Date.parse(T0);
    const clock = () => new Date(current).toISOString();
    const { service, studySessionRepository } = setup(clock);
    const session = await seedSession(studySessionRepository, {
      timerMode: 'count_down',
      taskText: '任务',
      plannedDurationSeconds: 600,
      status: 'running',
      startedAt: clock(),
      pausedDurationSeconds: 65,
    });
    current += 125_900; // 墙钟 125.9 秒 → 整秒 125
    const result = await service.endStudySession(session.id, {
      expectedVersion: session.version,
    });
    expect(result.status).toBe('completed');
    expect(result.endedAt).toBe(clock());
    expect(result.pausedAt).toBeNull();
    expect(result.pausedDurationSeconds).toBe(65);
    expect(result.actualDurationSeconds).toBe(60);
    expect(result.startedAt).toBe(T0);
    expect(result.version).toBe(session.version + 1);
  });

  it('ends a running count_up session with no pauses', async () => {
    let current = Date.parse(T0);
    const clock = () => new Date(current).toISOString();
    const { service, studySessionRepository } = setup(clock);
    const session = await seedSession(studySessionRepository, {
      timerMode: 'count_up',
      taskText: '专注',
      status: 'running',
      startedAt: clock(),
    });
    current += 100_000;
    const result = await service.endStudySession(session.id, {
      expectedVersion: session.version,
    });
    expect(result.status).toBe('completed');
    expect(result.actualDurationSeconds).toBe(100);
    expect(result.pausedDurationSeconds).toBe(0);
    expect(result.plannedDurationSeconds).toBeNull();
  });

  it('ends a paused session and settles the current pause interval', async () => {
    let current = Date.parse(T0);
    const clock = () => new Date(current).toISOString();
    const { service, studySessionRepository } = setup(clock);
    const session = await seedSession(studySessionRepository, {
      status: 'paused',
      startedAt: T0,
      pausedAt: new Date(current + 60_000).toISOString(), // T0+60s
      pausedDurationSeconds: 0,
    });
    current += 125_900; // 墙钟 125.9 → 125；当前暂停 = 125.9 - 60 → 65；实际 60
    const result = await service.endStudySession(session.id, {
      expectedVersion: session.version,
    });
    expect(result.status).toBe('completed');
    expect(result.pausedAt).toBeNull();
    expect(result.pausedDurationSeconds).toBe(65);
    expect(result.actualDurationSeconds).toBe(60);
  });

  it('ends a paused session on top of prior accumulated pauses', async () => {
    let current = Date.parse(T0);
    const clock = () => new Date(current).toISOString();
    const { service, studySessionRepository } = setup(clock);
    const session = await seedSession(studySessionRepository, {
      status: 'paused',
      startedAt: T0,
      pausedAt: new Date(current + 100_000).toISOString(), // T0+100s
      pausedDurationSeconds: 30,
    });
    current += 200_000; // 墙钟 200；当前暂停 = 200-100 → 100；累计 130；实际 70
    const result = await service.endStudySession(session.id, {
      expectedVersion: session.version,
    });
    expect(result.pausedDurationSeconds).toBe(130);
    expect(result.actualDurationSeconds).toBe(70);
    expect(result.pausedAt).toBeNull();
  });

  it('rejects ending a created session', async () => {
    const { service, studySessionRepository } = setup();
    const session = await seedSession(studySessionRepository, { status: 'created' });
    await expect(
      service.endStudySession(session.id, { expectedVersion: session.version }),
    ).rejects.toBeInstanceOf(StudySessionStatusConflictError);
  });

  it('rejects ending an already completed session without rewriting endedAt or durations', async () => {
    const { service, studySessionRepository } = setup();
    const session = await seedSession(studySessionRepository, {
      status: 'completed',
      startedAt: T0,
      endedAt: '2026-01-01T08:30:00.000Z',
      actualDurationSeconds: 1800,
      pausedDurationSeconds: 60,
    });
    await expect(
      service.endStudySession(session.id, { expectedVersion: session.version }),
    ).rejects.toBeInstanceOf(StudySessionStatusConflictError);
    const latest = await studySessionRepository.findById(session.id);
    expect(latest!.status).toBe('completed');
    expect(latest!.endedAt).toBe('2026-01-01T08:30:00.000Z');
    expect(latest!.actualDurationSeconds).toBe(1800);
    expect(latest!.version).toBe(session.version);
  });

  it('throws a version conflict on a stale expectedVersion', async () => {
    const { service, studySessionRepository } = setup();
    const session = await seedSession(studySessionRepository, {
      status: 'running',
      startedAt: T0,
    });
    await expect(
      service.endStudySession(session.id, { expectedVersion: session.version + 99 }),
    ).rejects.toBeInstanceOf(StudySessionVersionConflictError);
  });

  it('rejects ending when startedAt is missing (time corruption) and keeps the store unchanged', async () => {
    const { service, studySessionRepository } = setup();
    const session = await seedSession(studySessionRepository, { status: 'running' });
    await expect(
      service.endStudySession(session.id, { expectedVersion: session.version }),
    ).rejects.toBeInstanceOf(StudySessionTimeCorruptionError);
    const latest = await studySessionRepository.findById(session.id);
    expect(latest!.status).toBe('running');
    expect(latest!.version).toBe(session.version);
  });

  it('rejects ending when the server clock is unparseable (time corruption) and keeps the store unchanged', async () => {
    const { service, studySessionRepository } = setup(() => 'not-a-time');
    const session = await seedSession(studySessionRepository, {
      status: 'running',
      startedAt: T0,
    });
    await expect(
      service.endStudySession(session.id, { expectedVersion: session.version }),
    ).rejects.toBeInstanceOf(StudySessionTimeCorruptionError);
    const latest = await studySessionRepository.findById(session.id);
    expect(latest!.version).toBe(session.version);
    expect(latest!.endedAt).toBeNull();
  });

  it('rejects ending when the server clock is earlier than startedAt (time corruption)', async () => {
    const { service, studySessionRepository } = setup(() => '2026-01-01T07:00:00.000Z');
    const session = await seedSession(studySessionRepository, {
      status: 'running',
      startedAt: '2026-01-01T08:00:00.000Z',
    });
    await expect(
      service.endStudySession(session.id, { expectedVersion: session.version }),
    ).rejects.toBeInstanceOf(StudySessionTimeCorruptionError);
  });

  it('rejects ending a running session that carries a pausedAt (time corruption)', async () => {
    const { service, studySessionRepository } = setup(() => FIXED_NOW);
    const session = await seedSession(studySessionRepository, {
      status: 'running',
      startedAt: T0,
      pausedAt: T0,
    });
    await expect(
      service.endStudySession(session.id, { expectedVersion: session.version }),
    ).rejects.toBeInstanceOf(StudySessionTimeCorruptionError);
  });

  it('rejects ending a paused session without a pausedAt (time corruption)', async () => {
    const { service, studySessionRepository } = setup(() => FIXED_NOW);
    const session = await seedSession(studySessionRepository, {
      status: 'paused',
      startedAt: T0,
    });
    await expect(
      service.endStudySession(session.id, { expectedVersion: session.version }),
    ).rejects.toBeInstanceOf(StudySessionTimeCorruptionError);
  });

  it('rejects ending when pausedAt is before startedAt (time corruption)', async () => {
    const { service, studySessionRepository } = setup(() => FIXED_NOW);
    const session = await seedSession(studySessionRepository, {
      status: 'paused',
      startedAt: '2026-01-01T09:00:00.000Z',
      pausedAt: '2026-01-01T08:00:00.000Z',
    });
    await expect(
      service.endStudySession(session.id, { expectedVersion: session.version }),
    ).rejects.toBeInstanceOf(StudySessionTimeCorruptionError);
  });

  it('rejects ending when pausedAt is after the server clock (time corruption)', async () => {
    let current = Date.parse(T0);
    const clock = () => new Date(current).toISOString();
    const { service, studySessionRepository } = setup(clock);
    const session = await seedSession(studySessionRepository, {
      status: 'paused',
      startedAt: T0,
      pausedAt: '2026-01-01T08:05:00.000Z',
    });
    current = Date.parse('2026-01-01T08:04:00.000Z'); // 服务器时间早于 pausedAt
    await expect(
      service.endStudySession(session.id, { expectedVersion: session.version }),
    ).rejects.toBeInstanceOf(StudySessionTimeCorruptionError);
  });

  it('rejects ending when accumulated paused seconds is not a non-negative integer (time corruption)', async () => {
    for (const pausedDurationSeconds of [NaN, -1, 1.5]) {
      const { service, studySessionRepository } = setup(() => FIXED_NOW);
      const session = await seedSession(studySessionRepository, {
        status: 'running',
        startedAt: T0,
        pausedDurationSeconds,
      });
      await expect(
        service.endStudySession(session.id, { expectedVersion: session.version }),
      ).rejects.toBeInstanceOf(StudySessionTimeCorruptionError);
    }
  });

  it('rejects ending when paused seconds exceed the wall clock (time corruption) and keeps the store unchanged', async () => {
    const { service, studySessionRepository } = setup(() => FIXED_NOW);
    const session = await seedSession(studySessionRepository, {
      status: 'running',
      startedAt: '2026-01-01T08:00:00.000Z',
      pausedDurationSeconds: 200, // 墙钟仅 0 秒，暂停总数大于墙钟
    });
    await expect(
      service.endStudySession(session.id, { expectedVersion: session.version }),
    ).rejects.toBeInstanceOf(StudySessionTimeCorruptionError);
    const latest = await studySessionRepository.findById(session.id);
    expect(latest!.status).toBe('running');
    expect(latest!.endedAt).toBeNull();
    expect(latest!.version).toBe(session.version);
  });

  it('samples the server clock exactly once on a successful end', async () => {
    let calls = 0;
    const clock = () => {
      calls += 1;
      return FIXED_NOW;
    };
    const { service, studySessionRepository } = setup(clock);
    const session = await seedSession(studySessionRepository, {
      status: 'running',
      startedAt: '2026-01-01T08:00:00.000Z',
    });
    await service.endStudySession(session.id, { expectedVersion: session.version });
    expect(calls).toBe(1);
  });

  it('20 concurrent ends with the same expectedVersion: exactly one succeeds', async () => {
    const { service, studySessionRepository } = setup(() => FIXED_NOW);
    const session = await seedSession(studySessionRepository, {
      status: 'running',
      startedAt: '2026-01-01T08:00:00.000Z',
    });
    const results = await Promise.all(
      Array.from({ length: 20 }, () =>
        service
          .endStudySession(session.id, { expectedVersion: session.version })
          .then(() => 'ok')
          .catch((e) =>
            e instanceof StudySessionVersionConflictError ? 'conflict' : 'other',
          ),
      ),
    );
    expect(results.filter((r) => r === 'ok')).toHaveLength(1);
    expect(results.filter((r) => r === 'conflict')).toHaveLength(19);
    const latest = await studySessionRepository.findById(session.id);
    expect(latest!.status).toBe('completed');
    expect(latest!.endedAt).toBe(FIXED_NOW);
    expect(latest!.version).toBe(session.version + 1);
  });
});
