import { describe, expect, it } from 'vitest';
import { InMemoryStudyParticipantRepository } from '../src/infrastructure/repositories/in-memory-study-participant-repository.js';
import { makeStudyParticipant, uuid } from './helpers.js';

function setup() {
  return { repository: new InMemoryStudyParticipantRepository() };
}

describe('InMemoryStudyParticipantRepository', () => {
  it('upserts a participant on first appearance with joinedAt = lastActiveAt', async () => {
    const { repository } = setup();
    const participant = makeStudyParticipant();
    const result = await repository.upsert(participant);
    expect(result.joined).toBe(true);
    expect(result.participant).toEqual(participant);
  });

  it('upserting again only refreshes lastActiveAt and keeps joinedAt', async () => {
    const { repository } = setup();
    const participant = makeStudyParticipant({
      joinedAt: '2026-01-01T08:00:00.000Z',
      lastActiveAt: '2026-01-01T08:00:00.000Z',
    });
    await repository.upsert(participant);
    const retry = await repository.upsert({
      ...participant,
      lastActiveAt: '2026-01-02T09:00:00.000Z',
    });
    expect(retry.joined).toBe(false);
    expect(retry.participant.joinedAt).toBe('2026-01-01T08:00:00.000Z');
    expect(retry.participant.lastActiveAt).toBe('2026-01-02T09:00:00.000Z');
    const [stored] = await repository.listBySession(participant.studySessionId);
    expect(stored!.joinedAt).toBe('2026-01-01T08:00:00.000Z');
    expect(stored!.lastActiveAt).toBe('2026-01-02T09:00:00.000Z');
  });

  it('keeps different actors in the same session as separate records', async () => {
    const { repository } = setup();
    const sessionId = uuid();
    const actorA = uuid();
    const actorB = uuid();
    await repository.upsert(makeStudyParticipant({ studySessionId: sessionId, actorId: actorA }));
    await repository.upsert(makeStudyParticipant({ studySessionId: sessionId, actorId: actorB }));
    const list = await repository.listBySession(sessionId);
    expect(list).toHaveLength(2);
    expect(list.map((p) => p.actorId).sort()).toEqual([actorA, actorB].sort());
  });

  it('does not move lastActiveAt backwards for an older incoming time', async () => {
    const { repository } = setup();
    const participant = makeStudyParticipant({
      joinedAt: '2026-01-02T08:00:00.000Z',
      lastActiveAt: '2026-01-02T09:00:00.000Z',
    });
    await repository.upsert(participant);
    // 旧报告幂等重试：传入更早的时间，lastActiveAt 不得倒退。
    const result = await repository.upsert({
      ...participant,
      lastActiveAt: '2026-01-01T08:00:00.000Z',
    });
    expect(result.joined).toBe(false);
    expect(result.participant.lastActiveAt).toBe('2026-01-02T09:00:00.000Z');
    expect(result.participant.joinedAt).toBe('2026-01-02T08:00:00.000Z');
  });

  it('does not create records for sessions or actors that never participated', async () => {
    const { repository } = setup();
    expect(await repository.listBySession(uuid())).toEqual([]);
  });

  it('returns defensive copies so mutating a result cannot leak into the store', async () => {
    const { repository } = setup();
    const participant = makeStudyParticipant();
    await repository.upsert(participant);
    const read = (await repository.listBySession(participant.studySessionId))[0]!;
    read.lastActiveAt = 'mutated';
    const [again] = await repository.listBySession(participant.studySessionId);
    expect(again!.lastActiveAt).toBe(participant.lastActiveAt);
  });

  it('concurrent upserts for the same session and actor: exactly one joined, no duplicates', async () => {
    const { repository } = setup();
    const sessionId = uuid();
    const actorId = uuid();
    const results = await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        repository.upsert(
          makeStudyParticipant({
            studySessionId: sessionId,
            actorId,
            lastActiveAt: `2026-01-01T08:00:0${String(i % 10)}.000Z`,
          }),
        ),
      ),
    );
    expect(results.filter((r) => r.joined)).toHaveLength(1);
    expect((await repository.listBySession(sessionId))).toHaveLength(1);
  });
});
