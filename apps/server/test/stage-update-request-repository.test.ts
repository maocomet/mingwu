import { describe, expect, it } from 'vitest';
import type { StageUpdateRequest } from '@mingwu/contracts';
import { StageUpdateRequestIdempotencyConflictError } from '../src/domain/stage-update-request/errors.js';
import { sameStageUpdateRequestSemantics } from '../src/domain/stage-update-request/semantics.js';
import { InMemoryStageUpdateRequestRepository } from '../src/infrastructure/repositories/in-memory-stage-update-request-repository.js';
import { makeStageUpdateRequest, uuid } from './helpers.js';

/**
 * 内存申请仓储：只可追加，不支持修改 / 覆盖 / 删除。id 作为幂等键原子唯一；
 * 同 id 同语义幂等返回已有申请，任一语义不同受控冲突。
 */
describe('InMemoryStageUpdateRequestRepository', () => {
  it('inserts a request and reads it back by id, returning deep copies', async () => {
    const repo = new InMemoryStageUpdateRequestRepository();
    const request = makeStageUpdateRequest();
    const { request: saved, created } = await repo.insertIfAbsent(request);
    expect(created).toBe(true);
    expect(saved).toEqual(request);

    const read = await repo.findById(request.id);
    expect(read).toEqual(request);

    // 修改读取结果不得污染仓储。
    if (read) {
      read.reason = 'tampered';
      read.createdAt = '2000-01-01T00:00:00.000Z';
    }
    const again = await repo.findById(request.id);
    expect(again?.reason).toBe(request.reason);
    expect(again?.createdAt).toBe(request.createdAt);
  });

  it('lists requests by target stage with deep copies', async () => {
    const repo = new InMemoryStageUpdateRequestRepository();
    const stageA = uuid();
    const stageB = uuid();
    const a1 = makeStageUpdateRequest({ id: uuid(), stageId: stageA });
    const a2 = makeStageUpdateRequest({ id: uuid(), stageId: stageA });
    const b1 = makeStageUpdateRequest({ id: uuid(), stageId: stageB });
    await repo.insertIfAbsent(a1);
    await repo.insertIfAbsent(a2);
    await repo.insertIfAbsent(b1);

    const list = await repo.listByStage(stageA);
    expect(list.map((r) => r.id).sort()).toEqual([a1.id, a2.id].sort());
    expect(await repo.listByStage(stageB)).toHaveLength(1);
    expect(await repo.listByStage(uuid())).toEqual([]);

    // 修改列表元素不得污染仓储。
    list[0]!.reason = 'tampered';
    const again = await repo.listByStage(stageA);
    expect(again.every((r) => r.reason !== 'tampered')).toBe(true);
  });

  it('idempotent same-id retry with same semantics returns the existing request and keeps original createdAt', async () => {
    const repo = new InMemoryStageUpdateRequestRepository();
    const request = makeStageUpdateRequest({ createdAt: '2026-01-01T08:00:00.000Z' });
    const first = await repo.insertIfAbsent(request);
    expect(first.created).toBe(true);

    // 同语义重试：createdAt 不同不属于语义范围，幂等命中保留原 createdAt。
    const retry = makeStageUpdateRequest({
      ...request,
      createdAt: '2026-01-01T09:00:00.000Z',
    });
    const second = await repo.insertIfAbsent(retry);
    expect(second.created).toBe(false);
    expect(second.request).toEqual(request);

    const read = await repo.findById(request.id);
    expect(read?.createdAt).toBe('2026-01-01T08:00:00.000Z');
  });

  it('same id with any differing semantics throws a controlled conflict and never overwrites', async () => {
    const repo = new InMemoryStageUpdateRequestRepository();
    const original = makeStageUpdateRequest({
      id: uuid(),
      stageId: uuid(),
      requesterActorId: uuid(),
      expectedStageVersion: 1,
      proposedStatus: 'in_progress',
      reason: '进入下一阶段',
    });
    await repo.insertIfAbsent(original);

    // projectId 与 createdAt 是服务端派生字段，不属于幂等语义，不在此冲突用例内。
    const cases: Array<Partial<typeof original>> = [
      { stageId: uuid() },
      { requesterActorId: uuid() },
      { expectedStageVersion: 2 },
      { proposedStatus: 'completed' },
      { reason: '不同理由' },
    ];
    for (const field of cases) {
      const attempt = makeStageUpdateRequest({ ...original, ...field });
      await expect(repo.insertIfAbsent(attempt)).rejects.toBeInstanceOf(
        StageUpdateRequestIdempotencyConflictError,
      );
    }

    // 原始申请从未被覆盖。
    const read = await repo.findById(original.id);
    expect(read).toEqual(original);
    expect(await repo.listByStage(original.stageId)).toHaveLength(1);
  });

  it('20 concurrent same-id submissions create at most one request', async () => {
    const repo = new InMemoryStageUpdateRequestRepository();
    const shared = makeStageUpdateRequest({ id: uuid() });
    const results = await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        repo.insertIfAbsent(makeStageUpdateRequest({ ...shared, createdAt: `2026-01-0${i}` })),
      ),
    );
    const created = results.filter((r) => r.created);
    // 内存同步临界区保证最多一条真正插入；其余为幂等命中。
    expect(created.length).toBe(1);
    expect(await repo.listByStage(shared.stageId)).toHaveLength(1);
    expect((await repo.findById(shared.id))?.id).toBe(shared.id);
  });

  it('semantic comparison ignores projectId and createdAt (server-derived fields)', async () => {
    const repo = new InMemoryStageUpdateRequestRepository();
    const base = makeStageUpdateRequest({ id: uuid(), reason: '进入下一阶段' });
    const first = await repo.insertIfAbsent({ ...base, projectId: uuid() });
    expect(first.created).toBe(true);

    // 同 id + 同语义，仅 projectId 变化（服务端不会这么做，但仓储语义比较不应依赖它）。
    const retry = await repo.insertIfAbsent({
      ...base,
      projectId: uuid(),
      createdAt: '2026-02-02T00:00:00.000Z',
    });
    expect(retry.created).toBe(false);
    // 幂等命中返回仓储中已有的申请（保留原 projectId），不被本次提交的派生字段覆盖。
    expect(retry.request.projectId).toBe(first.request.projectId);
  });

  it('shared sameStageUpdateRequestSemantics compares only the five idempotency fields', async () => {
    const base = makeStageUpdateRequest({ id: uuid(), reason: '进入下一阶段' });
    // projectId / status / createdAt 是服务端派生字段，不属于语义比较范围。
    const same = makeStageUpdateRequest({
      ...base,
      projectId: uuid(),
      createdAt: '2026-01-01T00:00:00.000Z',
    });
    expect(sameStageUpdateRequestSemantics(base, same)).toBe(true);

    const differing: Array<Partial<StageUpdateRequest>> = [
      { stageId: uuid() },
      { requesterActorId: uuid() },
      { expectedStageVersion: 2 },
      { proposedStatus: 'completed' },
      { reason: '不同理由' },
    ];
    for (const field of differing) {
      const attempt = makeStageUpdateRequest({ ...base, ...field });
      expect(sameStageUpdateRequestSemantics(base, attempt)).toBe(false);
    }
  });
});
