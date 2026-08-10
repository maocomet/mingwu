import { describe, expect, it } from 'vitest';
import { StudySessionTimeCorruptionError } from '../src/domain/study-session/errors.js';
import {
  makeActorContext,
  makeServices,
  makeStudyParticipant,
  makeStudySummary,
  makeStudySession,
  uuid,
} from './helpers.js';

describe('StudySessionCurrentService', () => {
  it('returns null when there is no session at all', async () => {
    const services = makeServices();
    expect(await services.studySessionCurrentService.getCurrentDetail()).toBeNull();
  });

  it('returns null when only created drafts or terminal sessions exist', async () => {
    const services = makeServices();
    // created 只是未开始草稿，不属于“当前进行中”。
    await services.studySessionService.createStudySession({ id: uuid(), timerMode: 'count_up' });
    // 终态（completed）也不属于当前。
    let session = (
      await services.studySessionService.createStudySession({ id: uuid(), timerMode: 'count_up' })
    ).studySession;
    session = await services.studySessionService.setTask(session.id, {
      expectedVersion: session.version,
      taskText: '背单词',
    });
    session = await services.studySessionService.startStudySession(session.id, {
      expectedVersion: session.version,
    });
    await services.studySessionService.endStudySession(session.id, {
      expectedVersion: session.version,
    });

    expect(await services.studySessionCurrentService.getCurrentDetail()).toBeNull();
  });

  it('selects a running session and returns the full four-part aggregation', async () => {
    const services = makeServices();
    const actor = makeActorContext();
    let session = (
      await services.studySessionService.createStudySession({ id: uuid(), timerMode: 'count_up' })
    ).studySession;
    session = await services.studySessionService.setTask(session.id, {
      expectedVersion: session.version,
      taskText: '背单词',
    });
    session = await services.studySessionService.startStudySession(session.id, {
      expectedVersion: session.version,
    });
    const report = await services.studyReportService.appendReport(actor, {
      id: uuid(),
      studySessionId: session.id,
      content: '完成了今天的单词背诵',
    });
    const { summary } = await services.studySummaryRepository.createIfAbsent(
      makeStudySummary({ studySessionId: session.id, content: '正式总结' }),
    );

    const detail = await services.studySessionCurrentService.getCurrentDetail();
    expect(detail).not.toBeNull();
    expect(detail!.session.id).toBe(session.id);
    expect(detail!.session.status).toBe('running');
    expect(detail!.summary).toEqual(summary);
    expect(detail!.participants).toHaveLength(1);
    expect(detail!.participants[0]!.actorId).toBe(actor.actorId);
    expect(detail!.reports).toEqual([report]);
  });

  it('selects a paused session as the current one', async () => {
    const services = makeServices();
    let session = (
      await services.studySessionService.createStudySession({ id: uuid(), timerMode: 'count_up' })
    ).studySession;
    session = await services.studySessionService.setTask(session.id, {
      expectedVersion: session.version,
      taskText: '背单词',
    });
    session = await services.studySessionService.startStudySession(session.id, {
      expectedVersion: session.version,
    });
    session = await services.studySessionService.pauseStudySession(session.id, {
      expectedVersion: session.version,
    });

    const detail = await services.studySessionCurrentService.getCurrentDetail();
    expect(detail).not.toBeNull();
    expect(detail!.session.id).toBe(session.id);
    expect(detail!.session.status).toBe('paused');
  });

  it('sorts multiple in-progress sessions by startedAt DESC → updatedAt DESC → id DESC', async () => {
    const services = makeServices();
    const seed = (overrides: Parameters<typeof makeStudySession>[0]) =>
      services.studySessionRepository.createIfAbsent(makeStudySession(overrides));
    // b 与 a 同时开始（08:00），b 更新更晚（09:00）→ b 优先；c 开始更早（07:00）→ 最次。
    // 全部使用固定合法 UUID 与固定时间，结果不依赖随机值或 Map 插入顺序。
    await seed({
      id: '00000000-0000-4000-8000-000000000001',
      status: 'running',
      startedAt: '2026-01-01T08:00:00.000Z',
      updatedAt: '2026-01-01T08:30:00.000Z',
    });
    await seed({
      id: '00000000-0000-4000-8000-000000000002',
      status: 'running',
      startedAt: '2026-01-01T08:00:00.000Z',
      updatedAt: '2026-01-01T09:00:00.000Z',
    });
    await seed({
      id: '00000000-0000-4000-8000-000000000003',
      status: 'paused',
      startedAt: '2026-01-01T07:00:00.000Z',
      updatedAt: '2026-01-01T07:00:00.000Z',
    });

    const detail = await services.studySessionCurrentService.getCurrentDetail();
    expect(detail!.session.id).toBe('00000000-0000-4000-8000-000000000002');
  });

  it('breaks startedAt/updatedAt ties by id DESC with a deterministic fixed-UUID pair', async () => {
    const services = makeServices();
    const seed = (overrides: Parameters<typeof makeStudySession>[0]) =>
      services.studySessionRepository.createIfAbsent(makeStudySession(overrides));
    // 两条 startedAt 与 updatedAt 完全相同，只能靠 id DESC 兜底：003 > 001。
    await seed({
      id: '00000000-0000-4000-8000-000000000001',
      status: 'running',
      startedAt: '2026-01-01T08:00:00.000Z',
      updatedAt: '2026-01-01T08:00:00.000Z',
    });
    await seed({
      id: '00000000-0000-4000-8000-000000000003',
      status: 'paused',
      startedAt: '2026-01-01T08:00:00.000Z',
      updatedAt: '2026-01-01T08:00:00.000Z',
    });

    const detail = await services.studySessionCurrentService.getCurrentDetail();
    expect(detail!.session.id).toBe('00000000-0000-4000-8000-000000000003');
  });

  it('rejects dirty in-progress sessions without a parseable startedAt', async () => {
    const services = makeServices();
    // running 但 startedAt 非法：不得被静默选中或跳过，必须抛受控内部错误。
    await services.studySessionRepository.createIfAbsent(
      makeStudySession({
        id: uuid(),
        status: 'running',
        startedAt: 'not-a-time',
        updatedAt: '2026-01-01T08:00:00.000Z',
      }),
    );
    await expect(services.studySessionCurrentService.getCurrentDetail()).rejects.toBeInstanceOf(
      StudySessionTimeCorruptionError,
    );
  });

  it('rejects an in-progress session whose startedAt is missing (null)', async () => {
    const services = makeServices();
    await services.studySessionRepository.createIfAbsent(
      makeStudySession({
        id: uuid(),
        status: 'paused',
        startedAt: null,
        updatedAt: '2026-01-01T08:00:00.000Z',
      }),
    );
    await expect(services.studySessionCurrentService.getCurrentDetail()).rejects.toBeInstanceOf(
      StudySessionTimeCorruptionError,
    );
  });

  it('rejects an in-progress session whose updatedAt is not a parseable time', async () => {
    const services = makeServices();
    // startedAt 合法、updatedAt 非法：updatedAt 也参与正式选择，必须验证可解析，
    // 非法值不得按字典序兜底或静默跳过，直接抛受控内部错误。
    await services.studySessionRepository.createIfAbsent(
      makeStudySession({
        id: uuid(),
        status: 'running',
        startedAt: '2026-01-01T08:00:00.000Z',
        updatedAt: 'not-a-time',
      }),
    );
    await expect(services.studySessionCurrentService.getCurrentDetail()).rejects.toBeInstanceOf(
      StudySessionTimeCorruptionError,
    );
  });

  it('compares startedAt by real instant, so an offset time sorts against Z despite reversed lexicographic order', async () => {
    const services = makeServices();
    const seed = (overrides: Parameters<typeof makeStudySession>[0]) =>
      services.studySessionRepository.createIfAbsent(makeStudySession(overrides));
    // '2026-01-01T10:00:00+02:00' 的字符串大于 '2026-01-01T09:00:00Z'（字典序相反），
    // 但真实时刻是 08:00Z，早于 09:00Z：按真实时刻应选中后开始的 09:00Z 那条。
    await seed({
      id: '00000000-0000-4000-8000-000000000001',
      status: 'running',
      startedAt: '2026-01-01T10:00:00+02:00',
      updatedAt: '2026-01-01T10:00:00+02:00',
    });
    await seed({
      id: '00000000-0000-4000-8000-000000000002',
      status: 'running',
      startedAt: '2026-01-01T09:00:00Z',
      updatedAt: '2026-01-01T09:00:00Z',
    });

    const detail = await services.studySessionCurrentService.getCurrentDetail();
    expect(detail!.session.id).toBe('00000000-0000-4000-8000-000000000002');
  });

  it('treats equal-real-instant startedAt representations as a tie and falls through to updatedAt', async () => {
    const services = makeServices();
    const seed = (overrides: Parameters<typeof makeStudySession>[0]) =>
      services.studySessionRepository.createIfAbsent(makeStudySession(overrides));
    // 两条 startedAt 都是真实 09:00Z，只是表示不同（09:00Z 与 10:00+01:00）：
    // 必须视为同一真实时刻，进入 updatedAt 比较，而不是被字符串字典序提前分流。
    await seed({
      id: '00000000-0000-4000-8000-000000000001',
      status: 'running',
      startedAt: '2026-01-01T09:00:00Z',
      updatedAt: '2026-01-01T09:00:00Z',
    });
    await seed({
      id: '00000000-0000-4000-8000-000000000002',
      status: 'running',
      startedAt: '2026-01-01T10:00:00+01:00',
      updatedAt: '2026-01-01T08:00:00Z',
    });

    const detail = await services.studySessionCurrentService.getCurrentDetail();
    // updatedAt DESC：09:00Z 那条（001）更新，正确胜出。
    expect(detail!.session.id).toBe('00000000-0000-4000-8000-000000000001');
  });

  it('compares updatedAt by real instant when startedAt ties, picking the offset time that is genuinely newer', async () => {
    const services = makeServices();
    const seed = (overrides: Parameters<typeof makeStudySession>[0]) =>
      services.studySessionRepository.createIfAbsent(makeStudySession(overrides));
    // startedAt 完全相同，进入 updatedAt 比较。'10:00:00+10:00' 字符串更大，但真实时刻
    // 是 00:00Z，早于 01:00Z：按真实时刻应选中 01:00Z 那条（001）。
    await seed({
      id: '00000000-0000-4000-8000-000000000001',
      status: 'running',
      startedAt: '2026-01-01T08:00:00Z',
      updatedAt: '2026-01-01T01:00:00Z',
    });
    await seed({
      id: '00000000-0000-4000-8000-000000000002',
      status: 'running',
      startedAt: '2026-01-01T08:00:00Z',
      updatedAt: '2026-01-01T10:00:00+10:00',
    });

    const detail = await services.studySessionCurrentService.getCurrentDetail();
    expect(detail!.session.id).toBe('00000000-0000-4000-8000-000000000001');
  });

  it('is read-only: repeated and concurrent queries never change any repository data', async () => {
    const services = makeServices();
    let studySession = (
      await services.studySessionService.createStudySession({ id: uuid(), timerMode: 'count_up' })
    ).studySession;
    studySession = await services.studySessionService.setTask(studySession.id, {
      expectedVersion: studySession.version,
      taskText: '背单词',
    });
    studySession = await services.studySessionService.startStudySession(studySession.id, {
      expectedVersion: studySession.version,
    });
    const actor = makeActorContext();
    await services.studyReportService.appendReport(actor, {
      id: uuid(),
      studySessionId: studySession.id,
      content: '只读报告',
    });
    await services.studyParticipantRepository.upsert(
      makeStudyParticipant({
        studySessionId: studySession.id,
        actorId: actor.actorId,
        joinedAt: '2026-01-01T08:00:00.000Z',
        lastActiveAt: '2026-01-01T08:00:00.000Z',
      }),
    );
    await services.studySummaryRepository.createIfAbsent(
      makeStudySummary({ studySessionId: studySession.id, content: '只读总结' }),
    );
    const before = {
      session: await services.studySessionRepository.findById(studySession.id),
      summary: await services.studySummaryRepository.findByStudySessionId(studySession.id),
      participants: await services.studyParticipantRepository.listBySession(studySession.id),
      reports: await services.studyReportRepository.listBySession(studySession.id),
    };
    await Promise.all([
      services.studySessionCurrentService.getCurrentDetail(),
      services.studySessionCurrentService.getCurrentDetail(),
      services.studySessionCurrentService.getCurrentDetail(),
    ]);
    await services.studySessionCurrentService.getCurrentDetail();

    expect(await services.studySessionRepository.findById(studySession.id)).toEqual(before.session);
    expect(await services.studySummaryRepository.findByStudySessionId(studySession.id)).toEqual(
      before.summary,
    );
    expect(await services.studyParticipantRepository.listBySession(studySession.id)).toEqual(
      before.participants,
    );
    expect(await services.studyReportRepository.listBySession(studySession.id)).toEqual(
      before.reports,
    );
  });
});
