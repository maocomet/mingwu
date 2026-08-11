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

describe('InMemoryStageUpdateRequestRepository.decideIfPending (decision CAS)', () => {
  const DECIDED_AT = '2026-01-01T10:00:00.000Z';

  it('atomically writes a needs_changes decision only for an existing pending request at the expected revision', async () => {
    const repo = new InMemoryStageUpdateRequestRepository();
    const pending = makeStageUpdateRequest({ status: 'pending', revision: 1 });
    await repo.insertIfAbsent(pending);

    const saved = await repo.decideIfPending(pending.id, 1, {
      note: '请补充细节',
      decidedAt: DECIDED_AT,
      updatedAt: DECIDED_AT,
    });
    expect(saved).not.toBeNull();
    expect(saved!.status).toBe('needs_changes');
    expect(saved!.revision).toBe(2);
    expect(saved!.decision).toEqual({
      type: 'needs_changes',
      note: '请补充细节',
      decidedAt: DECIDED_AT,
    });
    expect(saved!.updatedAt).toBe(DECIDED_AT);

    const read = await repo.findById(pending.id);
    expect(read).toEqual(saved);
    expect(read?.status).toBe('needs_changes');
    expect(read?.revision).toBe(2);
    expect(read?.decision).toEqual(saved!.decision);
    // 原申请核心字段（projectId / stageId / actor / 语义）与 createdAt 不变。
    expect(read?.createdAt).toBe(pending.createdAt);
    expect(read?.stageId).toBe(pending.stageId);
    expect(read?.requesterActorId).toBe(pending.requesterActorId);
  });

  it('derives the decided request from current: every original field comes from current, revision is always exactly +1', async () => {
    const repo = new InMemoryStageUpdateRequestRepository();
    // 构造含非默认核心字段的申请，便于逐项比对是否来自 current。
    const pending = makeStageUpdateRequest({
      id: uuid(),
      projectId: uuid(),
      stageId: uuid(),
      requesterActorId: uuid(),
      expectedStageVersion: 3,
      proposedStatus: 'completed',
      reason: '不可改写的原理由',
      status: 'pending',
      revision: 1,
      createdAt: '2026-01-01T08:00:00.000Z',
      updatedAt: '2026-01-01T08:00:00.000Z',
    });
    await repo.insertIfAbsent(pending);

    const saved = await repo.decideIfPending(pending.id, 1, {
      note: '决定说明',
      decidedAt: DECIDED_AT,
      updatedAt: DECIDED_AT,
    });
    expect(saved).not.toBeNull();
    // 核心字段 + 创建时间逐项来自 current，且任何调用方参数都无法改写。
    expect(saved!.id).toBe(pending.id);
    expect(saved!.projectId).toBe(pending.projectId);
    expect(saved!.stageId).toBe(pending.stageId);
    expect(saved!.requesterActorId).toBe(pending.requesterActorId);
    expect(saved!.expectedStageVersion).toBe(pending.expectedStageVersion);
    expect(saved!.proposedStatus).toBe(pending.proposedStatus);
    expect(saved!.reason).toBe(pending.reason);
    expect(saved!.createdAt).toBe(pending.createdAt);
    // status 目标与 revision 由仓储固定派生：只允许 needs_changes、revision 只能 +1。
    expect(saved!.status).toBe('needs_changes');
    expect(saved!.revision).toBe(pending.revision + 1);
    // 只写 decision 与 updatedAt。
    expect(saved!.updatedAt).toBe(DECIDED_AT);
    expect(saved!.decision).toEqual({
      type: 'needs_changes',
      note: '决定说明',
      decidedAt: DECIDED_AT,
    });
  });

  it('returns null without writing for missing / stale revision / non-pending, and never overwrites the first decision', async () => {
    const repo = new InMemoryStageUpdateRequestRepository();
    const pending = makeStageUpdateRequest({ status: 'pending', revision: 1 });
    await repo.insertIfAbsent(pending);
    const decision = { note: '第一次决定', decidedAt: DECIDED_AT, updatedAt: DECIDED_AT };

    // 不存在。
    expect(await repo.decideIfPending(uuid(), 1, decision)).toBeNull();
    // 版本陈旧（expectedRevision 不等于当前 revision）。
    expect(await repo.decideIfPending(pending.id, 2, decision)).toBeNull();
    // 已决定后再次决定：不再 pending。
    await repo.decideIfPending(pending.id, 1, decision);
    expect(
      await repo.decideIfPending(pending.id, 2, { note: '第二次决定', decidedAt: '2026-01-01T11:00:00.000Z', updatedAt: '2026-01-01T11:00:00.000Z' }),
    ).toBeNull();

    // 原决定从未被覆盖（revision / updatedAt / decision 保持第一次决定）。
    const read = await repo.findById(pending.id);
    expect(read?.status).toBe('needs_changes');
    expect(read?.revision).toBe(2);
    expect(read?.decision).toEqual({ type: 'needs_changes', note: '第一次决定', decidedAt: DECIDED_AT });
    expect(read?.updatedAt).toBe(DECIDED_AT);
  });

  it('20 concurrent same-revision decisions: exactly one wins and final revision is 2', async () => {
    const repo = new InMemoryStageUpdateRequestRepository();
    const pending = makeStageUpdateRequest({ status: 'pending', revision: 1 });
    await repo.insertIfAbsent(pending);

    const results = await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        repo.decideIfPending(pending.id, 1, {
          note: `决定 ${i}`,
          decidedAt: `2026-01-0${i}`,
          updatedAt: `2026-01-0${i}`,
        }),
      ),
    );
    const wins = results.filter((r) => r !== null);
    expect(wins.length).toBe(1);
    const read = await repo.findById(pending.id);
    expect(read?.status).toBe('needs_changes');
    expect(read?.revision).toBe(2);
    expect(read?.decision?.note).toBe(wins[0]!.decision!.note);
    // 无论谁胜出，revision 固定 +1，核心字段仍来自当前申请。
    expect(read?.projectId).toBe(pending.projectId);
    expect(read?.createdAt).toBe(pending.createdAt);
  });

  it('returns deep copies: mutating the decided result does not pollute storage', async () => {
    const repo = new InMemoryStageUpdateRequestRepository();
    const pending = makeStageUpdateRequest({ status: 'pending', revision: 1 });
    await repo.insertIfAbsent(pending);

    const saved = await repo.decideIfPending(pending.id, 1, {
      note: '请补充细节',
      decidedAt: DECIDED_AT,
      updatedAt: DECIDED_AT,
    });
    if (!saved) throw new Error('expected a decided request');
    // 篡改返回对象。
    saved.reason = 'tampered';
    saved.projectId = uuid();
    saved.createdAt = '2000-01-01T00:00:00.000Z';
    saved.decision = null;
    saved.revision = 999;

    const read = await repo.findById(pending.id);
    expect(read?.reason).toBe(pending.reason);
    expect(read?.projectId).toBe(pending.projectId);
    expect(read?.createdAt).toBe(pending.createdAt);
    expect(read?.revision).toBe(2);
    expect(read?.decision?.note).toBe('请补充细节');
  });
});
