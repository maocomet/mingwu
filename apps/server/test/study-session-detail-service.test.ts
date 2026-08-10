import { describe, expect, it } from 'vitest';
import { StudySessionNotFoundError } from '../src/domain/study-session/errors.js';
import {
  makeActorContext,
  makeServices,
  makeStudyParticipant,
  makeStudyReport,
  makeStudySummary,
  uuid,
} from './helpers.js';

describe('StudySessionDetailService', () => {
  it('aggregates session, summary, participants and reports in one read (end-to-end)', async () => {
    const services = makeServices();
    const actor = makeActorContext();
    let session = (
      await services.studySessionService.createStudySession({ id: uuid(), timerMode: 'count_down' })
    ).studySession;
    session = await services.studySessionService.setTask(session.id, {
      expectedVersion: session.version,
      taskText: '背单词',
    });
    session = await services.studySessionService.setCountdown(session.id, {
      expectedVersion: session.version,
      plannedDurationSeconds: 600,
    });
    session = await services.studySessionService.startStudySession(session.id, {
      expectedVersion: session.version,
    });
    const report = await services.studyReportService.appendReport(actor, {
      id: uuid(),
      studySessionId: session.id,
      content: '完成了今天的单词背诵',
    });
    session = await services.studySessionService.endStudySession(session.id, {
      expectedVersion: session.version,
    });
    const { summary } = await services.studySummaryService.putBySessionId(session.id, {
      content: '今天背完了 20 个单词',
      source: 'user',
      expectedRevision: 0,
    });

    const detail = await services.studySessionDetailService.getDetail(session.id);
    expect(detail.session).toEqual(session);
    expect(detail.summary).toEqual(summary);
    expect(detail.participants).toHaveLength(1);
    expect(detail.participants[0]!.actorId).toBe(actor.actorId);
    expect(detail.participants[0]!.joinedAt).toBe(report.submittedAt);
    expect(detail.reports).toEqual([report]);
  });

  it('returns summary null and empty arrays when the session has none of them', async () => {
    const services = makeServices();
    const { studySession } = await services.studySessionService.createStudySession({
      id: uuid(),
      timerMode: 'count_up',
    });

    const detail = await services.studySessionDetailService.getDetail(studySession.id);
    expect(detail.session).toEqual(studySession);
    expect(detail.summary).toBeNull();
    expect(detail.participants).toEqual([]);
    expect(detail.reports).toEqual([]);
  });

  it('rejects an unknown session with StudySessionNotFoundError', async () => {
    const services = makeServices();
    await expect(
      services.studySessionDetailService.getDetail(uuid()),
    ).rejects.toBeInstanceOf(StudySessionNotFoundError);
  });

  it('returns participants sorted by joinedAt ASC then actorId ASC', async () => {
    const services = makeServices();
    const { studySession } = await services.studySessionService.createStudySession({
      id: uuid(),
      timerMode: 'count_up',
    });
    // 固定合法 UUID 明确控制字典序（000...001 < 000...002 < 000...003）：
    // actorA 与 actorC 同时加入（按 actorId 升序排），actorB 更晚加入。
    // 不能用随机 uuid()——否则 actorA 是否排在 actorC 前取决于随机值，测试会偶发失败。
    const actorA = '00000000-0000-4000-8000-000000000001';
    const actorB = '00000000-0000-4000-8000-000000000002';
    const actorC = '00000000-0000-4000-8000-000000000003';
    await services.studyParticipantRepository.upsert(
      makeStudyParticipant({
        studySessionId: studySession.id,
        actorId: actorA,
        joinedAt: '2026-01-01T08:00:00.000Z',
        lastActiveAt: '2026-01-01T08:00:00.000Z',
      }),
    );
    await services.studyParticipantRepository.upsert(
      makeStudyParticipant({
        studySessionId: studySession.id,
        actorId: actorC,
        joinedAt: '2026-01-01T08:00:00.000Z',
        lastActiveAt: '2026-01-01T08:00:00.000Z',
      }),
    );
    await services.studyParticipantRepository.upsert(
      makeStudyParticipant({
        studySessionId: studySession.id,
        actorId: actorB,
        joinedAt: '2026-01-01T09:00:00.000Z',
        lastActiveAt: '2026-01-01T09:00:00.000Z',
      }),
    );

    const detail = await services.studySessionDetailService.getDetail(studySession.id);
    expect(detail.participants.map((p) => p.actorId)).toEqual([actorA, actorC, actorB]);
  });

  it('returns reports sorted by submittedAt ASC then actorId ASC then sequenceNumber ASC', async () => {
    const services = makeServices();
    const { studySession } = await services.studySessionService.createStudySession({
      id: uuid(),
      timerMode: 'count_up',
    });
    const actorA = uuid();
    const actorB = uuid();
    // 先 A@08:00（seq 1）、B@09:00（seq 1）、再 A@08:00（seq 2）：
    // 期望按 submittedAt / actorId / sequenceNumber 排序为 [A seq1, A seq2, B seq1]。
    const r1 = (
      await services.studyReportRepository.appendReport({
        id: uuid(),
        studySessionId: studySession.id,
        actorId: actorA,
        content: 'A 的第一份',
        submittedAt: '2026-01-01T08:00:00.000Z',
      })
    ).report;
    const r2 = (
      await services.studyReportRepository.appendReport({
        id: uuid(),
        studySessionId: studySession.id,
        actorId: actorB,
        content: 'B 的第一份',
        submittedAt: '2026-01-01T09:00:00.000Z',
      })
    ).report;
    const r3 = (
      await services.studyReportRepository.appendReport({
        id: uuid(),
        studySessionId: studySession.id,
        actorId: actorA,
        content: 'A 的第二份',
        submittedAt: '2026-01-01T08:00:00.000Z',
      })
    ).report;
    expect([r1.sequenceNumber, r2.sequenceNumber, r3.sequenceNumber]).toEqual([1, 1, 2]);

    const detail = await services.studySessionDetailService.getDetail(studySession.id);
    expect(detail.reports.map((r) => r.id)).toEqual([r1.id, r3.id, r2.id]);
    expect(detail.reports.map((r) => r.sequenceNumber)).toEqual([1, 2, 1]);
  });

  it('is read-only: repeated and concurrent reads never change any repository data', async () => {
    const services = makeServices();
    const { studySession } = await services.studySessionService.createStudySession({
      id: uuid(),
      timerMode: 'count_up',
    });
    const actorA = uuid();
    const actorB = uuid();
    // appendReport 输入不含 sequenceNumber（仓储分配），这里显式去掉。
    const seedReport = (overrides: Parameters<typeof makeStudyReport>[0]) => {
      const report = makeStudyReport(overrides);
      return services.studyReportRepository.appendReport({
        id: report.id,
        studySessionId: report.studySessionId,
        actorId: report.actorId,
        content: report.content,
        submittedAt: report.submittedAt,
      });
    };
    await seedReport({
      studySessionId: studySession.id,
      actorId: actorA,
      submittedAt: '2026-01-01T08:00:00.000Z',
    });
    await seedReport({
      studySessionId: studySession.id,
      actorId: actorB,
      submittedAt: '2026-01-01T09:00:00.000Z',
    });
    await services.studyParticipantRepository.upsert(
      makeStudyParticipant({
        studySessionId: studySession.id,
        actorId: actorA,
        joinedAt: '2026-01-01T08:00:00.000Z',
        lastActiveAt: '2026-01-01T08:00:00.000Z',
      }),
    );
    const summary = (
      await services.studySummaryRepository.createIfAbsent(
        makeStudySummary({ studySessionId: studySession.id }),
      )
    ).summary;

    const before = {
      session: await services.studySessionRepository.findById(studySession.id),
      summary: await services.studySummaryRepository.findByStudySessionId(studySession.id),
      participants: await services.studyParticipantRepository.listBySession(studySession.id),
      reports: await services.studyReportRepository.listBySession(studySession.id),
    };
    await Promise.all([
      services.studySessionDetailService.getDetail(studySession.id),
      services.studySessionDetailService.getDetail(studySession.id),
      services.studySessionDetailService.getDetail(studySession.id),
    ]);
    await services.studySessionDetailService.getDetail(studySession.id);

    expect(await services.studySessionRepository.findById(studySession.id)).toEqual(before.session);
    expect(await services.studySummaryRepository.findByStudySessionId(studySession.id)).toEqual(
      before.summary,
    );
    expect(await services.studyParticipantRepository.listBySession(studySession.id)).toEqual(
      before.participants,
    );
    expect(await services.studyReportRepository.listBySession(studySession.id)).toEqual(before.reports);
    // summary 确确实实被读取到了（否则断言会空过）。
    expect(summary).toBeTruthy();
  });
});
