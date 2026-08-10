import { describe, expect, it } from 'vitest';
import type { StudyReport } from '@mingwu/contracts';
import { StudyReportIdempotencyConflictError } from '../src/domain/study-report/errors.js';
import { InMemoryStudyReportRepository } from '../src/infrastructure/repositories/in-memory-study-report-repository.js';
import { makeStudyReport, uuid } from './helpers.js';

function setup() {
  return { repository: new InMemoryStudyReportRepository() };
}

/** 构造不含 sequenceNumber 的追加入参（sequenceNumber 由仓储分配）。 */
function appendInput(
  overrides: Partial<Omit<StudyReport, 'sequenceNumber'>> = {},
): Omit<StudyReport, 'sequenceNumber'> {
  return {
    id: overrides.id ?? uuid(),
    studySessionId: overrides.studySessionId ?? uuid(),
    actorId: overrides.actorId ?? uuid(),
    content: overrides.content ?? 'AI 学习报告',
    submittedAt: overrides.submittedAt ?? '2026-01-01T08:00:00.000Z',
  };
}

describe('InMemoryStudyReportRepository', () => {
  it('assigns sequence 1 then 2 for the same actor in the same session', async () => {
    const { repository } = setup();
    const sessionId = uuid();
    const actorId = uuid();
    const first = await repository.appendReport(appendInput({ studySessionId: sessionId, actorId }));
    const second = await repository.appendReport(
      appendInput({ studySessionId: sessionId, actorId, id: uuid() }),
    );
    expect(first.created).toBe(true);
    expect(first.report.sequenceNumber).toBe(1);
    expect(second.created).toBe(true);
    expect(second.report.sequenceNumber).toBe(2);
    expect((await repository.listBySession(sessionId))).toHaveLength(2);
  });

  it('gives different actors independent sequences starting at 1', async () => {
    const { repository } = setup();
    const sessionId = uuid();
    const actorA = uuid();
    const actorB = uuid();
    const first = await repository.appendReport(
      appendInput({ studySessionId: sessionId, actorId: actorA }),
    );
    const second = await repository.appendReport(
      appendInput({ studySessionId: sessionId, actorId: actorB }),
    );
    expect(first.report.sequenceNumber).toBe(1);
    expect(second.report.sequenceNumber).toBe(1);
  });

  it('is idempotent: same id with same semantics returns the existing report without advancing', async () => {
    const { repository } = setup();
    const sessionId = uuid();
    const input = appendInput({ studySessionId: sessionId });
    const first = await repository.appendReport(input);
    const retry = await repository.appendReport(input);
    expect(retry.created).toBe(false);
    expect(retry.report).toEqual(first.report);
    expect((await repository.listBySession(sessionId))).toHaveLength(1);
  });

  it('throws a controlled conflict for the same id with different content', async () => {
    const { repository } = setup();
    const sessionId = uuid();
    const id = uuid();
    await repository.appendReport(appendInput({ id, studySessionId: sessionId, content: '第一版' }));
    await expect(
      repository.appendReport(appendInput({ id, studySessionId: sessionId, content: '第二版' })),
    ).rejects.toBeInstanceOf(StudyReportIdempotencyConflictError);
    const [stored] = await repository.listBySession(sessionId);
    expect(stored!.content).toBe('第一版');
  });

  it('throws a controlled conflict for the same id with a different actor or session', async () => {
    const { repository } = setup();
    const id = uuid();
    const actorA = uuid();
    const actorB = uuid();
    await repository.appendReport(appendInput({ id, actorId: actorA }));
    await expect(
      repository.appendReport(appendInput({ id, actorId: actorB })),
    ).rejects.toBeInstanceOf(StudyReportIdempotencyConflictError);
    await expect(
      repository.appendReport(appendInput({ id, studySessionId: uuid() })),
    ).rejects.toBeInstanceOf(StudyReportIdempotencyConflictError);
  });

  it('20 concurrent appends for the same actor produce unique, contiguous sequences', async () => {
    const { repository } = setup();
    const sessionId = uuid();
    const actorId = uuid();
    const results = await Promise.all(
      Array.from({ length: 20 }, () =>
        repository.appendReport(appendInput({ studySessionId: sessionId, actorId, id: uuid() })),
      ),
    );
    const sequences = results.map((r) => r.report.sequenceNumber).sort((a, b) => a - b);
    expect(sequences).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
    expect(new Set(sequences).size).toBe(20);
  });

  it('returns defensive copies so mutating a result cannot leak into the store', async () => {
    const { repository } = setup();
    const input = appendInput({ content: 'keep' });
    const { report } = await repository.appendReport(input);
    report.content = 'mutated';
    const read = await repository.listBySession(input.studySessionId);
    expect(read[0]!.content).toBe('keep');
  });

  it('returns an empty list for an unknown session', async () => {
    const { repository } = setup();
    expect(await repository.listBySession(uuid())).toEqual([]);
  });

  it('is append-only: exposes no update or delete methods', () => {
    const { repository } = setup();
    expect('update' in repository).toBe(false);
    expect('delete' in repository).toBe(false);
    expect('remove' in repository).toBe(false);
  });
});
