import { describe, expect, it } from 'vitest';
import type { AiActorType, StudyParticipant, StudySession } from '@mingwu/contracts';
import {
  AI_ACTOR_CODE_MAX_LENGTH,
  STUDY_REPORT_CONTENT_MAX_LENGTH,
} from '@mingwu/contracts';
import { StudyReportService } from '../src/application/study-report/study-report-service.js';
import { StudyActorContextInvalidError } from '../src/domain/study-actor/errors.js';
import { StudyParticipantUpdateError } from '../src/domain/study-participant/errors.js';
import type { StudyParticipantRepository } from '../src/domain/study-participant/repository.js';
import {
  StudyReportContentInvalidError,
  StudyReportIdInvalidError,
  StudyReportIdempotencyConflictError,
  StudyReportSessionNotActiveError,
} from '../src/domain/study-report/errors.js';
import { StudySessionNotFoundError } from '../src/domain/study-session/errors.js';
import type { StudySessionRepository } from '../src/domain/study-session/repository.js';
import {
  makeActorContext,
  makeServices,
  makeStudySession,
  makeStudySummary,
  uuid,
} from './helpers.js';

function setup(now?: () => string) {
  const services = makeServices();
  const service = new StudyReportService(
    services.studyReportRepository,
    services.studyParticipantRepository,
    services.studySessionRepository,
    now,
  );
  return { service, ...services };
}

/** 直接向仓储播种一个已开始（running）的 Session；可覆盖为 created / 终态。 */
async function seedSession(
  repository: StudySessionRepository,
  overrides: Partial<StudySession> = {},
): Promise<StudySession> {
  const session = makeStudySession({
    status: 'running',
    startedAt: '2026-01-01T08:00:00.000Z',
    ...overrides,
  });
  await repository.createIfAbsent(session);
  return session;
}

describe('StudyReportService.appendReport', () => {
  it('appends a report with server-owned fields and creates the participant', async () => {
    const now = '2026-01-02T09:30:00.000Z';
    const { service, studySessionRepository } = setup(() => now);
    const session = await seedSession(studySessionRepository);
    const ctx = makeActorContext({ actorCode: 'xiaomiao' });
    const report = await service.appendReport(ctx, {
      id: uuid(),
      studySessionId: session.id,
      content: '  完成了 30 分钟专注  ',
    });
    expect(report.studySessionId).toBe(session.id);
    expect(report.actorId).toBe(ctx.actorId);
    expect(report.sequenceNumber).toBe(1);
    expect(report.content).toBe('完成了 30 分钟专注');
    expect(report.submittedAt).toBe(now);
    const participants = await service.listParticipants(session.id);
    expect(participants).toHaveLength(1);
    expect(participants[0]!.actorId).toBe(ctx.actorId);
    expect(participants[0]!.joinedAt).toBe(now);
    expect(participants[0]!.lastActiveAt).toBe(now);
  });

  it('assigns sequence 1 then 2 for the same actor and keeps the older report', async () => {
    const { service, studySessionRepository } = setup();
    const session = await seedSession(studySessionRepository);
    const ctx = makeActorContext({ actorCode: 'xiaomiao' });
    const first = await service.appendReport(ctx, {
      id: uuid(),
      studySessionId: session.id,
      content: '报告 #1',
    });
    const second = await service.appendReport(ctx, {
      id: uuid(),
      studySessionId: session.id,
      content: '报告 #2',
    });
    expect(first.sequenceNumber).toBe(1);
    expect(second.sequenceNumber).toBe(2);
    const reports = await service.listReports(session.id);
    expect(reports).toHaveLength(2);
    expect(reports.map((r) => r.content)).toEqual(['报告 #1', '报告 #2']);
  });

  it('keeps xiaomiao and xiaoke sequences independent starting at 1', async () => {
    const { service, studySessionRepository } = setup();
    const session = await seedSession(studySessionRepository);
    // 独立序列以 UUID actorId 为键；actorCode 只是展示代号。
    const miao = makeActorContext({ actorCode: 'xiaomiao' });
    const ke = makeActorContext({ actorCode: 'xiaoke' });
    const miao1 = await service.appendReport(miao, {
      id: uuid(),
      studySessionId: session.id,
      content: 'miao #1',
    });
    const ke1 = await service.appendReport(ke, {
      id: uuid(),
      studySessionId: session.id,
      content: 'ke #1',
    });
    const miao2 = await service.appendReport(miao, {
      id: uuid(),
      studySessionId: session.id,
      content: 'miao #2',
    });
    expect(miao1.sequenceNumber).toBe(1);
    expect(ke1.sequenceNumber).toBe(1);
    expect(miao2.sequenceNumber).toBe(2);
    expect(ke1.id).not.toBe(miao1.id);
  });

  it('rejects a created (draft) session and allows running / paused / terminal sessions', async () => {
    const { service, studySessionRepository } = setup();
    const ctx = makeActorContext({ actorCode: 'xiaomiao' });
    const created = await seedSession(studySessionRepository, { status: 'created', startedAt: null });
    await expect(
      service.appendReport(ctx, { id: uuid(), studySessionId: created.id, content: 'x' }),
    ).rejects.toBeInstanceOf(StudyReportSessionNotActiveError);
    for (const status of ['running', 'paused', 'completed', 'cancelled', 'interrupted']) {
      const session = await seedSession(studySessionRepository, { status: status as StudySession['status'] });
      await expect(
        service.appendReport(ctx, { id: uuid(), studySessionId: session.id, content: 'x' }),
      ).resolves.toMatchObject({ studySessionId: session.id });
    }
  });

  it('returns 404-equivalent StudySessionNotFoundError for an unknown session', async () => {
    const { service } = setup();
    await expect(
      service.appendReport(makeActorContext(), { id: uuid(), studySessionId: uuid(), content: 'x' }),
    ).rejects.toBeInstanceOf(StudySessionNotFoundError);
  });

  it('rejects a non-UUID id at the service layer', async () => {
    const { service, studySessionRepository } = setup();
    const session = await seedSession(studySessionRepository);
    await expect(
      service.appendReport(makeActorContext(), {
        id: 'not-a-uuid',
        studySessionId: session.id,
        content: 'x',
      }),
    ).rejects.toBeInstanceOf(StudyReportIdInvalidError);
  });

  it('rejects whitespace-only and oversized content, and accepts the emoji boundary', async () => {
    const { service, studySessionRepository } = setup();
    const session = await seedSession(studySessionRepository);
    const ctx = makeActorContext({ actorCode: 'xiaomiao' });
    await expect(
      service.appendReport(ctx, { id: uuid(), studySessionId: session.id, content: '   ' }),
    ).rejects.toBeInstanceOf(StudyReportContentInvalidError);
    await expect(
      service.appendReport(ctx, {
        id: uuid(),
        studySessionId: session.id,
        content: 'x'.repeat(STUDY_REPORT_CONTENT_MAX_LENGTH + 1),
      }),
    ).rejects.toBeInstanceOf(StudyReportContentInvalidError);
    // 5000 个 emoji 的 UTF-16 length 是 10000，但 code point 数正好 5000：应通过。
    await expect(
      service.appendReport(ctx, {
        id: uuid(),
        studySessionId: session.id,
        content: '😀'.repeat(STUDY_REPORT_CONTENT_MAX_LENGTH),
      }),
    ).resolves.toMatchObject({ sequenceNumber: 1 });
    await expect(
      service.appendReport(ctx, {
        id: uuid(),
        studySessionId: session.id,
        content: '😀'.repeat(STUDY_REPORT_CONTENT_MAX_LENGTH + 1),
      }),
    ).rejects.toBeInstanceOf(StudyReportContentInvalidError);
  });

  it('is idempotent: retrying the same id and content returns the existing report', async () => {
    const { service, studySessionRepository } = setup();
    const session = await seedSession(studySessionRepository);
    const ctx = makeActorContext({ actorCode: 'xiaomiao' });
    const id = uuid();
    const first = await service.appendReport(ctx, { id, studySessionId: session.id, content: '报告' });
    const retry = await service.appendReport(ctx, { id, studySessionId: session.id, content: '报告' });
    expect(retry).toEqual(first);
    expect(await service.listReports(session.id)).toHaveLength(1);
  });

  it('throws a controlled conflict for the same id with different content and never overwrites', async () => {
    const { service, studySessionRepository } = setup();
    const session = await seedSession(studySessionRepository);
    const ctx = makeActorContext({ actorCode: 'xiaomiao' });
    const id = uuid();
    await service.appendReport(ctx, { id, studySessionId: session.id, content: '第一版' });
    await expect(
      service.appendReport(ctx, { id, studySessionId: session.id, content: '第二版' }),
    ).rejects.toBeInstanceOf(StudyReportIdempotencyConflictError);
    const reports = await service.listReports(session.id);
    expect(reports).toHaveLength(1);
    expect(reports[0]!.content).toBe('第一版');
  });

  it('20 concurrent appends for the same actor all succeed with unique, contiguous sequences', async () => {
    const { service, studySessionRepository } = setup();
    const session = await seedSession(studySessionRepository);
    const ctx = makeActorContext({ actorCode: 'xiaomiao' });
    const reports = await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        service.appendReport(ctx, {
          id: uuid(),
          studySessionId: session.id,
          content: `报告 ${i}`,
        }),
      ),
    );
    const sequences = reports.map((r) => r.sequenceNumber).sort((a, b) => a - b);
    expect(sequences).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
    expect(new Set(sequences).size).toBe(20);
  });

  it('reports a participant upsert failure as a controlled error instead of faking success', async () => {
    const services = makeServices();
    const session = await seedSession(services.studySessionRepository);
    const throwingRepo = {
      upsert: async () => {
        throw new Error('boom');
      },
      listBySession: async () => [],
    } as unknown as StudyParticipantRepository;
    const service = new StudyReportService(
      services.studyReportRepository,
      throwingRepo,
      services.studySessionRepository,
      () => '2026-01-01T08:00:00.000Z',
    );
    await expect(
      service.appendReport(makeActorContext({ actorCode: 'xiaomiao' }), {
        id: uuid(),
        studySessionId: session.id,
        content: '报告',
      }),
    ).rejects.toBeInstanceOf(StudyParticipantUpdateError);
    // 内存阶段：报告已写入但接口如实返回失败；PostgreSQL 阶段必须同一事务整体回滚。
    expect(await services.studyReportRepository.listBySession(session.id)).toHaveLength(1);
  });

  it('appending a report does not change an existing StudySummary', async () => {
    const { service, studySummaryRepository, studySessionRepository } = setup();
    const session = await seedSession(studySessionRepository);
    await studySummaryRepository.createIfAbsent(
      makeStudySummary({ studySessionId: session.id, content: '用户总结' }),
    );
    await service.appendReport(makeActorContext({ actorCode: 'xiaomiao' }), {
      id: uuid(),
      studySessionId: session.id,
      content: 'AI 报告',
    });
    const summary = await studySummaryRepository.findByStudySessionId(session.id);
    expect(summary!.content).toBe('用户总结');
  });

  it('rejects an invalid trusted context without writing a report or participant', async () => {
    const {
      service,
      studyReportRepository,
      studyParticipantRepository,
      studySessionRepository,
    } = setup();
    const session = await seedSession(studySessionRepository);
    const invalidContexts = [
      makeActorContext({ actorId: 'not-a-uuid' }),
      makeActorContext({ actorCode: '' }),
      makeActorContext({ actorCode: 'x'.repeat(AI_ACTOR_CODE_MAX_LENGTH + 1) }),
      makeActorContext({ actorType: 'ai' as unknown as AiActorType }),
      makeActorContext({ actorType: 'human' as unknown as AiActorType }),
    ];
    for (const ctx of invalidContexts) {
      await expect(
        service.appendReport(ctx, { id: uuid(), studySessionId: session.id, content: 'x' }),
      ).rejects.toBeInstanceOf(StudyActorContextInvalidError);
    }
    expect(await studyReportRepository.listBySession(session.id)).toEqual([]);
    expect(await studyParticipantRepository.listBySession(session.id)).toEqual([]);
  });

  it('idempotent retry does not refresh participant lastActiveAt with the retry time', async () => {
    let t = '2026-01-01T08:00:00.000Z';
    const { service, studySessionRepository } = setup(() => t);
    const session = await seedSession(studySessionRepository);
    const ctx = makeActorContext({ actorCode: 'xiaomiao' });
    const id = uuid();
    await service.appendReport(ctx, { id, studySessionId: session.id, content: '报告' });
    t = '2026-01-01T09:00:00.000Z';
    const retry = await service.appendReport(ctx, { id, studySessionId: session.id, content: '报告' });
    // 幂等命中原报告：返回的 submittedAt 是原提交时间，而不是重试请求时间。
    expect(retry.submittedAt).toBe('2026-01-01T08:00:00.000Z');
    const participants = await service.listParticipants(session.id);
    expect(participants).toHaveLength(1);
    expect(participants[0]!.joinedAt).toBe('2026-01-01T08:00:00.000Z');
    expect(participants[0]!.lastActiveAt).toBe('2026-01-01T08:00:00.000Z');
    expect(await service.listReports(session.id)).toHaveLength(1);
  });

  it('retrying an old report does not move participant lastActiveAt backwards', async () => {
    let t = '2026-01-01T08:00:00.000Z';
    const { service, studySessionRepository } = setup(() => t);
    const session = await seedSession(studySessionRepository);
    const ctx = makeActorContext({ actorCode: 'xiaomiao' });
    const firstId = uuid();
    await service.appendReport(ctx, { id: firstId, studySessionId: session.id, content: '#1' });
    t = '2026-01-01T09:00:00.000Z';
    await service.appendReport(ctx, { id: uuid(), studySessionId: session.id, content: '#2' });
    expect((await service.listParticipants(session.id))[0]!.lastActiveAt).toBe(
      '2026-01-01T09:00:00.000Z',
    );
    t = '2026-01-01T10:00:00.000Z';
    await service.appendReport(ctx, { id: firstId, studySessionId: session.id, content: '#1' });
    const participants = await service.listParticipants(session.id);
    expect(participants).toHaveLength(1);
    // 旧报告重试：lastActiveAt 既不倒退到 #1 的 08:00，也不跳到重试时间 10:00。
    expect(participants[0]!.lastActiveAt).toBe('2026-01-01T09:00:00.000Z');
    expect(await service.listReports(session.id)).toHaveLength(2);
  });

  it('rebuilds the participant on retry after an initial participant failure', async () => {
    let t = '2026-01-01T08:00:00.000Z';
    const services = makeServices();
    const session = await seedSession(services.studySessionRepository);
    const realParticipantRepo = services.studyParticipantRepository;
    let failNext = true;
    const flakyRepo: StudyParticipantRepository = {
      async upsert(participant) {
        if (failNext) {
          failNext = false;
          throw new Error('boom');
        }
        return realParticipantRepo.upsert(participant);
      },
      listBySession: (studySessionId) => realParticipantRepo.listBySession(studySessionId),
    };
    const service = new StudyReportService(
      services.studyReportRepository,
      flakyRepo,
      services.studySessionRepository,
      () => t,
    );
    const ctx = makeActorContext({ actorCode: 'xiaomiao' });
    const id = uuid();
    await expect(
      service.appendReport(ctx, { id, studySessionId: session.id, content: '报告' }),
    ).rejects.toBeInstanceOf(StudyParticipantUpdateError);
    // 首次失败：报告已写入但 Participant 未建立。
    expect(await realParticipantRepo.listBySession(session.id)).toEqual([]);
    // 同 id 同内容重试：幂等命中原报告，以原 submittedAt 补建 Participant；
    // 报告仍只有一份、序号仍为 1、不推进。
    t = '2026-01-01T09:00:00.000Z';
    const retry = await service.appendReport(ctx, { id, studySessionId: session.id, content: '报告' });
    expect(retry.submittedAt).toBe('2026-01-01T08:00:00.000Z');
    expect(await service.listReports(session.id)).toHaveLength(1);
    expect((await service.listReports(session.id))[0]!.sequenceNumber).toBe(1);
    const participants = await service.listParticipants(session.id);
    expect(participants).toHaveLength(1);
    expect(participants[0]!.joinedAt).toBe('2026-01-01T08:00:00.000Z');
    expect(participants[0]!.lastActiveAt).toBe('2026-01-01T08:00:00.000Z');
  });
});

describe('StudyReportService.listParticipants', () => {
  it('only lists actors that actually appended, refreshes lastActiveAt, keeps joinedAt', async () => {
    let t = '2026-01-01T08:00:00.000Z';
    const { service, studySessionRepository } = setup(() => t);
    const session = await seedSession(studySessionRepository);
    const miao = makeActorContext({ actorCode: 'xiaomiao' });
    const ke = makeActorContext({ actorCode: 'xiaoke' });
    await service.appendReport(miao, { id: uuid(), studySessionId: session.id, content: 'miao' });
    await service.appendReport(ke, { id: uuid(), studySessionId: session.id, content: 'ke' });
    t = '2026-01-01T09:00:00.000Z';
    await service.appendReport(miao, { id: uuid(), studySessionId: session.id, content: 'miao 2' });
    const participants = await service.listParticipants(session.id);
    expect(participants).toHaveLength(2);
    const miaoRow = participants.find((p) => p.actorId === miao.actorId)!;
    const keRow = participants.find((p) => p.actorId === ke.actorId)!;
    expect(miaoRow.joinedAt).toBe(keRow.joinedAt);
    expect(miaoRow.lastActiveAt).toBe('2026-01-01T09:00:00.000Z');
    expect(miaoRow.lastActiveAt).not.toBe(miaoRow.joinedAt);
  });

  it('returns an empty list when no AI has appended a report', async () => {
    const { service, studySessionRepository } = setup();
    const session = await seedSession(studySessionRepository);
    expect(await service.listParticipants(session.id)).toEqual([]);
  });

  it('sorts participants by joinedAt ASC then actorId ASC', async () => {
    let t = '2026-01-01T08:00:00.000Z';
    const { service, studySessionRepository } = setup(() => t);
    const session = await seedSession(studySessionRepository);
    const ke = makeActorContext({ actorCode: 'xiaoke' });
    const miao = makeActorContext({ actorCode: 'xiaomiao' });
    // ke 先于 miao 追加（joinedAt 更晚），列表仍应按 joinedAt 升序把 miao 放前面。
    t = '2026-01-01T09:00:00.000Z';
    await service.appendReport(ke, {
      id: uuid(),
      studySessionId: session.id,
      content: 'ke',
    });
    t = '2026-01-01T08:30:00.000Z';
    await service.appendReport(miao, {
      id: uuid(),
      studySessionId: session.id,
      content: 'miao',
    });
    const participants = await service.listParticipants(session.id);
    expect(participants.map((p) => p.actorId)).toEqual([miao.actorId, ke.actorId]);
  });
});

describe('StudyReportService.listReports', () => {
  it('sorts reports by submittedAt ASC, actorId ASC, sequenceNumber ASC', async () => {
    let t = '2026-01-01T08:00:00.000Z';
    const { service, studySessionRepository } = setup(() => t);
    const session = await seedSession(studySessionRepository);
    const miao = makeActorContext({ actorCode: 'xiaomiao' });
    const ke = makeActorContext({ actorCode: 'xiaoke' });
    // ke #1 at 09:00, miao #1 at 08:30, ke #2 at 09:00（与 ke #1 同 submittedAt，
    // 靠 actorId 升序决定 ke 在前；同 actor 同 submittedAt 靠 sequenceNumber 升序）。
    t = '2026-01-01T09:00:00.000Z';
    await service.appendReport(ke, { id: uuid(), studySessionId: session.id, content: 'ke #1' });
    t = '2026-01-01T08:30:00.000Z';
    await service.appendReport(miao, { id: uuid(), studySessionId: session.id, content: 'miao #1' });
    t = '2026-01-01T09:00:00.000Z';
    await service.appendReport(ke, { id: uuid(), studySessionId: session.id, content: 'ke #2' });
    const reports = await service.listReports(session.id);
    expect(reports.map((r) => r.content)).toEqual(['miao #1', 'ke #1', 'ke #2']);
  });

  it('returns an empty list for a session with no reports', async () => {
    const { service, studySessionRepository } = setup();
    const session = await seedSession(studySessionRepository);
    expect(await service.listReports(session.id)).toEqual([]);
  });
});
