import { describe, expect, it } from 'vitest';
import type { ProjectStage, ProjectStageStatus, StageUpdateRequest } from '@mingwu/contracts';
import {
  StageUpdateRequestDecisionConflictError,
  StageUpdateRequestNotFoundError,
  StageUpdateRequestProposedStatusInvalidError,
  StageUpdateRequestStageOwnershipConflictError,
} from '../src/domain/stage-update-request/errors.js';
import { StageNotFoundError, StageVersionConflictError } from '../src/domain/stage/errors.js';
import { InMemoryStageRepository } from '../src/infrastructure/repositories/in-memory-stage-repository.js';
import { InMemoryStageUpdateRequestRepository } from '../src/infrastructure/repositories/in-memory-stage-update-request-repository.js';
import { InMemoryStageUpdateRequestApprovalRepository } from '../src/infrastructure/repositories/in-memory-stage-update-request-approval-repository.js';
import { createInMemoryStore, type InMemoryStore } from '../src/infrastructure/stores/in-memory-store.js';
import { makeStage, makeStageUpdateRequest } from './helpers.js';

const NOW = '2026-08-11T10:00:00.000Z';

/** 共享同一 store 的三个仓储：批准路径与 Stage / 申请普通写入共用同一底层状态。 */
function makeStore() {
  const store = createInMemoryStore();
  const stageRepository = new InMemoryStageRepository(store);
  const requestRepository = new InMemoryStageUpdateRequestRepository(store);
  const approvalRepository = new InMemoryStageUpdateRequestApprovalRepository(store);
  return { store, stageRepository, requestRepository, approvalRepository };
}

/**
 * 在共享 store 中落一条 Stage 与一条 pending 申请（projectId / stageId / 版本对齐，
 * proposedStatus 默认为 in_progress）。
 */
async function seed(
  repos: ReturnType<typeof makeStore>,
  overrides: { stageStatus?: ProjectStageStatus; proposedStatus?: ProjectStageStatus; stageVersion?: number } = {},
): Promise<{ stage: ProjectStage; request: StageUpdateRequest }> {
  const stage = makeStage({
    status: overrides.stageStatus ?? 'not_started',
    version: overrides.stageVersion ?? 1,
  });
  await repos.stageRepository.createIfAbsent(stage);
  const request = makeStageUpdateRequest({
    projectId: stage.projectId,
    stageId: stage.id,
    expectedStageVersion: stage.version,
    proposedStatus: overrides.proposedStatus ?? 'in_progress',
    status: 'pending',
    revision: 1,
  });
  await repos.requestRepository.insertIfAbsent(request);
  return { stage, request };
}

function approveParams(requestId: string, expectedRevision = 1, note = '批准进入下一阶段') {
  return {
    requestId,
    expectedRevision,
    decision: { type: 'approved' as const, note, decidedAt: NOW, updatedAt: NOW },
    now: NOW,
  };
}

/**
 * 故障注入：把某张 Map 实例的 `.set` 替换为“先真实写入、再抛错”，复现“写入已生效、
 * 随后失败”的不确定提交。与“写入前直接抛错”不同，这里写入会真实落账（approved /
 * v2 或新状态 / 新版本）后才抛错，逼出回滚必须恢复已经生效的一侧。返回恢复函数，
 * 用可信底层 `Map.prototype.set` 恢复实例方法，避免污染后续测试。
 */
function installWriteThenThrow<K, V>(map: Map<K, V>): () => void {
  const realSet = Map.prototype.set.bind(map);
  (map as unknown as { set: (k: K, v: V) => Map<K, V> }).set = (k: K, v: V) => {
    realSet(k, v);
    throw new Error('after-write failure');
  };
  return () => {
    (map as unknown as { set: unknown }).set = realSet;
  };
}

describe('InMemoryStageUpdateRequestApprovalRepository.approveIfPending', () => {
  it('atomically approves a request and transitions the Stage (not_started -> in_progress)', async () => {
    const repos = makeStore();
    const { stage, request } = await seed(repos);

    const { request: approved, stage: updatedStage } = await repos.approvalRepository.approveIfPending(
      approveParams(request.id),
    );

    // 申请：status approved、revision 恰好 +1、decision 固定 type approved、只写决定字段。
    expect(approved.status).toBe('approved');
    expect(approved.revision).toBe(2);
    expect(approved.decision).toEqual({ type: 'approved', note: '批准进入下一阶段', decidedAt: NOW });
    expect(approved.updatedAt).toBe(NOW);
    // 核心字段与 createdAt 全部来自 current。
    expect(approved.id).toBe(request.id);
    expect(approved.projectId).toBe(request.projectId);
    expect(approved.stageId).toBe(request.stageId);
    expect(approved.requesterActorId).toBe(request.requesterActorId);
    expect(approved.expectedStageVersion).toBe(request.expectedStageVersion);
    expect(approved.proposedStatus).toBe(request.proposedStatus);
    expect(approved.reason).toBe(request.reason);
    expect(approved.createdAt).toBe(request.createdAt);

    // Stage：按 proposedStatus 迁移，首次进入 in_progress 写 startedAt，version +1。
    expect(updatedStage.status).toBe('in_progress');
    expect(updatedStage.startedAt).toBe(NOW);
    expect(updatedStage.completedAt).toBeNull();
    expect(updatedStage.version).toBe(stage.version + 1);
    expect(updatedStage.updatedAt).toBe(NOW);
    // 核心字段仍来自原 Stage。
    expect(updatedStage.id).toBe(stage.id);
    expect(updatedStage.projectId).toBe(stage.projectId);
    expect(updatedStage.name).toBe(stage.name);
    expect(updatedStage.createdAt).toBe(stage.createdAt);

    // 两侧都已持久化（同一 store）。
    const readReq = await repos.requestRepository.findById(request.id);
    expect(readReq).toEqual(approved);
    const readStage = await repos.stageRepository.findById(stage.id);
    expect(readStage).toEqual(updatedStage);
  });

  it('entering completed writes startedAt if empty and completedAt', async () => {
    const repos = makeStore();
    const { stage, request } = await seed(repos, { proposedStatus: 'completed' });

    const { stage: updatedStage } = await repos.approvalRepository.approveIfPending(
      approveParams(request.id),
    );
    expect(updatedStage.status).toBe('completed');
    expect(updatedStage.startedAt).toBe(NOW);
    expect(updatedStage.completedAt).toBe(NOW);
    expect(updatedStage.version).toBe(stage.version + 1);
  });

  it('entering completed keeps an existing startedAt', async () => {
    const repos = makeStore();
    const startedAt = '2026-08-01T08:00:00.000Z';
    const stage = makeStage({ status: 'in_progress', startedAt, version: 1 });
    await repos.stageRepository.createIfAbsent(stage);
    const request = makeStageUpdateRequest({
      projectId: stage.projectId,
      stageId: stage.id,
      expectedStageVersion: stage.version,
      proposedStatus: 'completed',
      status: 'pending',
      revision: 1,
    });
    await repos.requestRepository.insertIfAbsent(request);

    const { stage: updatedStage } = await repos.approvalRepository.approveIfPending(
      approveParams(request.id),
    );
    expect(updatedStage.status).toBe('completed');
    expect(updatedStage.startedAt).toBe(startedAt);
    expect(updatedStage.completedAt).toBe(NOW);
    expect(updatedStage.version).toBe(2);
  });

  it('leaving completed clears completedAt but keeps startedAt', async () => {
    const repos = makeStore();
    const startedAt = '2026-08-01T08:00:00.000Z';
    const completedAt = '2026-08-05T08:00:00.000Z';
    const stage = makeStage({ status: 'completed', startedAt, completedAt, version: 1 });
    await repos.stageRepository.createIfAbsent(stage);
    const request = makeStageUpdateRequest({
      projectId: stage.projectId,
      stageId: stage.id,
      expectedStageVersion: stage.version,
      proposedStatus: 'not_started',
      status: 'pending',
      revision: 1,
    });
    await repos.requestRepository.insertIfAbsent(request);

    const { stage: updatedStage } = await repos.approvalRepository.approveIfPending(
      approveParams(request.id),
    );
    expect(updatedStage.status).toBe('not_started');
    expect(updatedStage.startedAt).toBe(startedAt);
    expect(updatedStage.completedAt).toBeNull();
    expect(updatedStage.version).toBe(2);
  });

  it('target status equal to current: request approved but Stage version/updatedAt NOT advanced', async () => {
    const repos = makeStore();
    const { stage, request } = await seed(repos, { stageStatus: 'in_progress', proposedStatus: 'in_progress' });

    const { stage: updatedStage } = await repos.approvalRepository.approveIfPending(
      approveParams(request.id),
    );
    // 申请仍批准成功。
    expect((await repos.requestRepository.findById(request.id))?.status).toBe('approved');
    // Stage 完全不变：version / updatedAt / 时间字段都不推进。
    expect(updatedStage).toEqual(stage);
    expect(updatedStage.version).toBe(stage.version);
    expect(updatedStage.updatedAt).toBe(stage.updatedAt);
  });

  it('throws 404 when the request is missing, writing nothing either side', async () => {
    const repos = makeStore();
    await expect(
      repos.approvalRepository.approveIfPending(approveParams('00000000-0000-4000-8000-000000000000')),
    ).rejects.toBeInstanceOf(StageUpdateRequestNotFoundError);
  });

  it('throws 409 decision conflict for non-pending request or stale revision, writing nothing either side', async () => {
    const repos = makeStore();
    const { stage, request } = await seed(repos);

    // 先由 reject 决定离开 pending（共享底层状态证明决定互斥）。
    await repos.requestRepository.decideIfPending(request.id, 1, {
      type: 'rejected',
      note: '先拒绝',
      decidedAt: NOW,
      updatedAt: NOW,
    });
    await expect(repos.approvalRepository.approveIfPending(approveParams(request.id))).rejects.toBeInstanceOf(
      StageUpdateRequestDecisionConflictError,
    );
    // Stage 完全未变，申请保持 rejected。
    expect(await repos.stageRepository.findById(stage.id)).toEqual(stage);
    expect((await repos.requestRepository.findById(request.id))?.status).toBe('rejected');

    // 仍 pending 但 expectedRevision 陈旧。
    const repos2 = makeStore();
    const { request: request2 } = await seed(repos2);
    await expect(
      repos2.approvalRepository.approveIfPending(approveParams(request2.id, 2)),
    ).rejects.toBeInstanceOf(StageUpdateRequestDecisionConflictError);
    // 两侧都无写入。
    expect((await repos2.requestRepository.findById(request2.id))?.status).toBe('pending');
  });

  it('throws 404 when the real Stage is missing, writing nothing either side', async () => {
    const repos = makeStore();
    const { request } = await seed(repos);
    // 模拟 Stage 已被删除：从共享 store 移除。
    repos.store.stages.delete(request.stageId);

    await expect(repos.approvalRepository.approveIfPending(approveParams(request.id))).rejects.toBeInstanceOf(
      StageNotFoundError,
    );
    // 申请保持 pending。
    expect((await repos.requestRepository.findById(request.id))?.status).toBe('pending');
  });

  it('throws 409 ownership conflict when the Stage projectId no longer matches the request', async () => {
    const repos = makeStore();
    const { stage, request } = await seed(repos);
    // 模拟 Stage 归属已被替换（脏数据）：projectId 与申请不一致。
    repos.store.stages.set(stage.id, { ...stage, projectId: '99999999-9999-4999-8999-999999999999' });

    await expect(repos.approvalRepository.approveIfPending(approveParams(request.id))).rejects.toBeInstanceOf(
      StageUpdateRequestStageOwnershipConflictError,
    );
    // 两侧都无写入。
    expect((await repos.requestRepository.findById(request.id))?.status).toBe('pending');
    expect((await repos.stageRepository.findById(stage.id))?.version).toBe(stage.version);
  });

  it('throws 409 version conflict when the Stage has been advanced, request stays pending', async () => {
    const repos = makeStore();
    const { stage, request } = await seed(repos);
    // 模拟 Stage 已被并发推进到 v2。
    repos.store.stages.set(stage.id, { ...stage, status: 'in_progress', version: 2 });

    await expect(repos.approvalRepository.approveIfPending(approveParams(request.id))).rejects.toBeInstanceOf(
      StageVersionConflictError,
    );
    expect((await repos.requestRepository.findById(request.id))?.status).toBe('pending');
    expect((await repos.stageRepository.findById(stage.id))?.version).toBe(2);
  });

  it('throws 409 for an illegal proposedStatus, writing nothing either side', async () => {
    const repos = makeStore();
    const { stage } = await seed(repos);
    const request = makeStageUpdateRequest({
      projectId: stage.projectId,
      stageId: stage.id,
      expectedStageVersion: stage.version,
      proposedStatus: 'archived' as unknown as ProjectStageStatus,
      status: 'pending',
      revision: 1,
    });
    await repos.requestRepository.insertIfAbsent(request);

    await expect(repos.approvalRepository.approveIfPending(approveParams(request.id))).rejects.toBeInstanceOf(
      StageUpdateRequestProposedStatusInvalidError,
    );
    expect((await repos.requestRepository.findById(request.id))?.status).toBe('pending');
    expect((await repos.stageRepository.findById(stage.id))?.version).toBe(stage.version);
  });

  it('always persists decision type as the literal approved and never accepts forged core fields', async () => {
    const repos = makeStore();
    const { request } = await seed(repos);

    // 绕过 TS 类型注入伪造 decision（type 非 approved、多余键）；仓储必须忽略 type、
    // 只把字面量 approved 与白名单内字段落账。
    const { request: saved } = await repos.approvalRepository.approveIfPending({
      requestId: request.id,
      expectedRevision: 1,
      decision: {
        type: 'needs_changes' as never,
        note: '真实批准说明',
        decidedAt: NOW,
        updatedAt: NOW,
        extra: 'forged',
      } as never,
      now: NOW,
    });
    expect(saved.decision).toEqual({ type: 'approved', note: '真实批准说明', decidedAt: NOW });
    expect(saved.status).toBe('approved');
    expect(saved.revision).toBe(2);
    const read = await repos.requestRepository.findById(request.id);
    expect(read?.decision).toEqual(saved.decision);
  });

  it('rolls back the first side if the second side fails to commit (no residue on the request)', async () => {
    const repos = makeStore();
    const { stage, request } = await seed(repos);

    // 故障注入：Stage Map 的 set 抛错（模拟磁盘 / 数据库写失败），第二侧无法提交。
    const stagesMap = repos.store.stages;
    const originalSet = Map.prototype.set.bind(stagesMap);
    (stagesMap as unknown as { set: unknown }).set = () => {
      throw new Error('simulated second-side failure');
    };
    try {
      await expect(
        repos.approvalRepository.approveIfPending(approveParams(request.id)),
      ).rejects.toThrow('simulated second-side failure');
    } finally {
      (stagesMap as unknown as { set: unknown }).set = originalSet as never;
    }

    // 第一侧（申请）已回滚：仍 pending、revision 1、无决定，未残留“申请已批准”半状态。
    const read = await repos.requestRepository.findById(request.id);
    expect(read?.status).toBe('pending');
    expect(read?.revision).toBe(1);
    expect(read?.decision).toBeNull();
    expect(read?.updatedAt).toBe(request.updatedAt);
    expect((await repos.stageRepository.findById(stage.id))?.version).toBe(stage.version);
  });

  it('strict fault: request Map set writes approved then throws -> request fully rolled back, Stage byte-identical', async () => {
    const repos = makeStore();
    const { stage, request } = await seed(repos);
    const requestBefore = structuredClone(request);
    const stageBefore = structuredClone(stage);

    // 故障注入：申请 Map 的 set 先真实落账 approved / v2，随后才抛错（写已生效的失败）。
    const restore = installWriteThenThrow(repos.store.stageUpdateRequests);
    try {
      await expect(
        repos.approvalRepository.approveIfPending(approveParams(request.id)),
      ).rejects.toThrow('after-write failure');
    } finally {
      restore();
    }

    // 异常向上传播：这里已用 rejects.toThrow 断言，故障不被吞掉，也不伪装成批准成功。

    // 申请整体恢复为批准前快照：pending / revision 1 / decision null，其余字段逐项一致。
    const read = await repos.requestRepository.findById(request.id);
    expect(read).toEqual(requestBefore);
    expect(read?.status).toBe('pending');
    expect(read?.revision).toBe(1);
    expect(read?.decision).toBeNull();

    // Stage 字节级不变（本次故障发生在第二侧写入之前，Stage 从未被改动）。
    expect(await repos.stageRepository.findById(stage.id)).toEqual(stageBefore);
  });

  it('strict fault: Stage Map set writes the new state/version then throws -> BOTH sides restored to the pre-approval snapshot', async () => {
    const repos = makeStore();
    const { stage, request } = await seed(repos);
    const requestBefore = structuredClone(request);
    const stageBefore = structuredClone(stage);

    // 故障注入：Stage Map 的 set 先真实落账 in_progress / v2，随后才抛错（写已生效的失败）。
    const restore = installWriteThenThrow(repos.store.stages);
    try {
      await expect(
        repos.approvalRepository.approveIfPending(approveParams(request.id)),
      ).rejects.toThrow('after-write failure');
    } finally {
      restore();
    }

    // 两侧都整体恢复为批准前快照：申请 pending / revision 1 / decision null，Stage 字节级不变。
    // 覆盖“申请已批准但 Stage 未更新”与“Stage 已更新但申请仍 pending”两种半完成状态。
    const read = await repos.requestRepository.findById(request.id);
    expect(read).toEqual(requestBefore);
    expect(read?.status).toBe('pending');
    expect(read?.revision).toBe(1);
    expect(read?.decision).toBeNull();
    expect(await repos.stageRepository.findById(stage.id)).toEqual(stageBefore);
  });

  it('20 concurrent approvals of the same pending request: exactly one wins and Stage advances once', async () => {
    const repos = makeStore();
    const { stage, request } = await seed(repos);

    const results = await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        repos.approvalRepository
          .approveIfPending({
            requestId: request.id,
            expectedRevision: 1,
            decision: { type: 'approved', note: `批准 ${i}`, decidedAt: NOW, updatedAt: NOW },
            now: NOW,
          })
          .then(
            (r) => ({ ok: true as const, r }),
            (e) => ({ ok: false as const, e }),
          ),
      ),
    );
    const wins = results.filter((r) => r.ok);
    expect(wins.length).toBe(1);
    const winner = wins[0]!;
    expect(winner.ok).toBe(true);
    if (winner.ok) {
      expect(winner.r.request.status).toBe('approved');
    }

    const read = await repos.requestRepository.findById(request.id);
    expect(read?.status).toBe('approved');
    expect(read?.revision).toBe(2);
    const readStage = await repos.stageRepository.findById(stage.id);
    expect(readStage?.status).toBe('in_progress');
    expect(readStage?.version).toBe(stage.version + 1);
  });

  it('20 mixed approve/reject/request-changes: only one final decision; only an approve advances the Stage', async () => {
    const repos = makeStore();
    const { stage, request } = await seed(repos);

    const kinds: Array<'approve' | 'reject' | 'request-changes'> = [
      'approve',
      'reject',
      'request-changes',
    ];
    const results = await Promise.all(
      Array.from({ length: 20 }, (_, i) => {
        const kind = kinds[i % 3];
        if (kind === 'approve') {
          return repos.approvalRepository
            .approveIfPending({
              requestId: request.id,
              expectedRevision: 1,
              decision: { type: 'approved', note: `批准 ${i}`, decidedAt: NOW, updatedAt: NOW },
              now: NOW,
            })
            .then(
              (r) => ({ ok: true as const, kind }),
              (e) => ({ ok: false as const, kind }),
            );
        }
        const type = kind === 'reject' ? 'rejected' : 'needs_changes';
        return repos.requestRepository
          .decideIfPending(request.id, 1, {
            type,
            note: `决定 ${i}`,
            decidedAt: NOW,
            updatedAt: NOW,
          })
          .then(
            (r) => ({ ok: r !== null, kind }),
            () => ({ ok: false, kind }),
          );
      }),
    );
    const wins = results.filter((r) => r.ok);
    expect(wins.length).toBe(1);

    const read = await repos.requestRepository.findById(request.id);
    expect(read?.revision).toBe(2);
    const readStage = await repos.stageRepository.findById(stage.id);
    if (wins[0]!.kind === 'approve') {
      // 只有批准的胜出才会同时更新正式 Stage。
      expect(read?.status).toBe('approved');
      expect(read?.decision?.type).toBe('approved');
      expect(readStage?.status).toBe('in_progress');
      expect(readStage?.version).toBe(stage.version + 1);
    } else {
      // 其余决定胜出：申请离开 pending，Stage 完全不变。
      expect(read?.status).toBe(wins[0]!.kind === 'reject' ? 'rejected' : 'needs_changes');
      expect(readStage).toEqual(stage);
    }
  });

  it('returns deep copies: mutating the returned request or stage does not pollute storage', async () => {
    const repos = makeStore();
    const { request } = await seed(repos);

    const { request: approved, stage: updatedStage } = await repos.approvalRepository.approveIfPending(
      approveParams(request.id),
    );
    approved.reason = 'tampered';
    approved.decision = null;
    approved.revision = 999;
    (updatedStage as ProjectStage).name = 'tampered-stage';

    const read = await repos.requestRepository.findById(request.id);
    expect(read?.reason).toBe(request.reason);
    expect(read?.decision?.type).toBe('approved');
    expect(read?.revision).toBe(2);
    const readStage = await repos.stageRepository.findById(request.stageId);
    expect(readStage?.name).not.toBe('tampered-stage');
  });
});
