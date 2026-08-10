import { describe, expect, it } from 'vitest';
import { InMemoryStudySessionRepository } from '../src/infrastructure/repositories/in-memory-study-session-repository.js';
import { makeStudySession, uuid } from './helpers.js';

function setup() {
  return { repository: new InMemoryStudySessionRepository() };
}

describe('InMemoryStudySessionRepository', () => {
  it('creates a session and retrieves it by id', async () => {
    const { repository } = setup();
    const session = makeStudySession();
    const result = await repository.createIfAbsent(session);
    expect(result.created).toBe(true);
    expect(await repository.findById(session.id)).toEqual(session);
  });

  it('returns the existing session without overwriting when the id is reused', async () => {
    const { repository } = setup();
    const session = makeStudySession({ taskText: 'original' });
    await repository.createIfAbsent(session);
    const retry = makeStudySession({ id: session.id, taskText: 'other' });
    const result = await repository.createIfAbsent(retry);
    expect(result.created).toBe(false);
    expect(result.studySession.taskText).toBe('original');
    expect((await repository.findById(session.id))?.taskText).toBe('original');
  });

  it('returns defensive copies so mutating a result cannot leak into the store', async () => {
    const { repository } = setup();
    const session = makeStudySession({ taskText: 'keep' });
    await repository.createIfAbsent(session);
    const read = await repository.findById(session.id);
    read!.taskText = 'mutated';
    expect((await repository.findById(session.id))?.taskText).toBe('keep');
  });

  it('returns null for an unknown id', async () => {
    const { repository } = setup();
    expect(await repository.findById(uuid())).toBeNull();
  });

  it('concurrent createIfAbsent with the same id: one created, the rest return existing', async () => {
    const { repository } = setup();
    const session = makeStudySession();
    const results = await Promise.all(
      Array.from({ length: 20 }, () => repository.createIfAbsent(session)),
    );
    expect(results.filter((r) => r.created)).toHaveLength(1);
    expect(results.filter((r) => !r.created)).toHaveLength(19);
    expect(await repository.findById(session.id)).toEqual(session);
  });

  it('updateIfVersion applies changes and bumps version', async () => {
    const { repository } = setup();
    const session = makeStudySession();
    await repository.createIfAbsent(session);
    const updated = {
      ...session,
      taskText: '新任务',
      version: session.version + 1,
      updatedAt: new Date().toISOString(),
    };
    const result = await repository.updateIfVersion(updated, session.version);
    expect(result).not.toBeNull();
    expect(result!.taskText).toBe('新任务');
    expect(result!.version).toBe(session.version + 1);
    expect((await repository.findById(session.id))!.taskText).toBe('新任务');
  });

  it('updateIfVersion returns null and does not write when the session does not exist', async () => {
    const { repository } = setup();
    const ghost = makeStudySession();
    const result = await repository.updateIfVersion(ghost, ghost.version);
    expect(result).toBeNull();
    expect(await repository.findById(ghost.id)).toBeNull();
  });

  it('updateIfVersion returns null and does not write on version mismatch', async () => {
    const { repository } = setup();
    const session = makeStudySession();
    await repository.createIfAbsent(session);
    const result = await repository.updateIfVersion(
      { ...session, taskText: '陈旧写入', version: session.version + 1 },
      session.version + 99,
    );
    expect(result).toBeNull();
    const latest = await repository.findById(session.id);
    expect(latest!.taskText).toBe(session.taskText);
    expect(latest!.version).toBe(session.version);
  });

  it('concurrent updateIfVersion with the same expectedVersion: only one succeeds', async () => {
    const { repository } = setup();
    const session = makeStudySession();
    await repository.createIfAbsent(session);
    const results = await Promise.all(
      Array.from({ length: 20 }, () =>
        repository.updateIfVersion(
          { ...session, taskText: '并发写入', version: session.version + 1 },
          session.version,
        ),
      ),
    );
    expect(results.filter((r) => r !== null)).toHaveLength(1);
    expect((await repository.findById(session.id))!.taskText).toBe('并发写入');
    expect((await repository.findById(session.id))!.version).toBe(session.version + 1);
  });
});
