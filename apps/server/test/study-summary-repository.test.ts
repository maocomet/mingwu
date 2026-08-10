import { describe, expect, it } from 'vitest';
import { InMemoryStudySummaryRepository } from '../src/infrastructure/repositories/in-memory-study-summary-repository.js';
import { makeStudySummary, uuid } from './helpers.js';

function setup() {
  return { repository: new InMemoryStudySummaryRepository() };
}

describe('InMemoryStudySummaryRepository', () => {
  it('creates a summary and retrieves it by studySessionId', async () => {
    const { repository } = setup();
    const summary = makeStudySummary();
    const result = await repository.createIfAbsent(summary);
    expect(result.created).toBe(true);
    expect(await repository.findByStudySessionId(summary.studySessionId)).toEqual(summary);
  });

  it('returns null for an unknown studySessionId', async () => {
    const { repository } = setup();
    expect(await repository.findByStudySessionId(uuid())).toBeNull();
  });

  it('createIfAbsent is keyed on studySessionId: one summary per session', async () => {
    const { repository } = setup();
    const sessionId = uuid();
    const first = makeStudySummary({ studySessionId: sessionId, content: '第一版' });
    const second = makeStudySummary({ studySessionId: sessionId, content: '第二版' });
    await repository.createIfAbsent(first);
    const retry = await repository.createIfAbsent(second);
    expect(retry.created).toBe(false);
    expect(retry.summary.content).toBe('第一版');
    expect((await repository.findByStudySessionId(sessionId))?.content).toBe('第一版');
  });

  it('returns defensive copies so mutating a result cannot leak into the store', async () => {
    const { repository } = setup();
    const summary = makeStudySummary({ content: 'keep' });
    await repository.createIfAbsent(summary);
    const read = await repository.findByStudySessionId(summary.studySessionId);
    read!.content = 'mutated';
    expect((await repository.findByStudySessionId(summary.studySessionId))?.content).toBe('keep');
  });

  it('concurrent createIfAbsent for the same session: exactly one created, the rest return existing', async () => {
    const { repository } = setup();
    const summary = makeStudySummary();
    const results = await Promise.all(
      Array.from({ length: 20 }, () => repository.createIfAbsent(summary)),
    );
    expect(results.filter((r) => r.created)).toHaveLength(1);
    expect(results.filter((r) => !r.created)).toHaveLength(19);
    expect(await repository.findByStudySessionId(summary.studySessionId)).toEqual(summary);
  });

  it('updateIfRevision applies changes and bumps revision', async () => {
    const { repository } = setup();
    const summary = makeStudySummary({ revision: 1 });
    await repository.createIfAbsent(summary);
    const updated = {
      ...summary,
      content: '修订后的总结',
      revision: 2,
      updatedAt: new Date().toISOString(),
    };
    const result = await repository.updateIfRevision(updated, 1);
    expect(result).not.toBeNull();
    expect(result!.content).toBe('修订后的总结');
    expect(result!.revision).toBe(2);
    expect((await repository.findByStudySessionId(summary.studySessionId))!.content).toBe(
      '修订后的总结',
    );
  });

  it('updateIfRevision returns null and does not write when the session has no summary', async () => {
    const { repository } = setup();
    const ghost = makeStudySummary();
    const result = await repository.updateIfRevision(ghost, ghost.revision);
    expect(result).toBeNull();
    expect(await repository.findByStudySessionId(ghost.studySessionId)).toBeNull();
  });

  it('updateIfRevision returns null and does not write on revision mismatch', async () => {
    const { repository } = setup();
    const summary = makeStudySummary({ revision: 1, content: '原内容' });
    await repository.createIfAbsent(summary);
    const result = await repository.updateIfRevision(
      { ...summary, content: '陈旧写入', revision: 2 },
      summary.revision + 99,
    );
    expect(result).toBeNull();
    const latest = await repository.findByStudySessionId(summary.studySessionId);
    expect(latest!.content).toBe('原内容');
    expect(latest!.revision).toBe(1);
  });

  it('concurrent updateIfRevision with the same expectedRevision: only one succeeds', async () => {
    const { repository } = setup();
    const summary = makeStudySummary({ revision: 1 });
    await repository.createIfAbsent(summary);
    const results = await Promise.all(
      Array.from({ length: 20 }, () =>
        repository.updateIfRevision({ ...summary, content: '并发写入', revision: 2 }, 1),
      ),
    );
    expect(results.filter((r) => r !== null)).toHaveLength(1);
    const latest = await repository.findByStudySessionId(summary.studySessionId);
    expect(latest!.content).toBe('并发写入');
    expect(latest!.revision).toBe(2);
  });
});
