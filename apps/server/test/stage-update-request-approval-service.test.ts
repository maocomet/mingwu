import { describe, expect, it } from 'vitest';
import type { AuthenticatedAiActorContext, ProjectStage, StageUpdateRequest } from '@mingwu/contracts';
import { StageUpdateRequestService } from '../src/application/stage-update-request/stage-update-request-service.js';
import { StageNotFoundError, StageVersionConflictError } from '../src/domain/stage/errors.js';
import {
  StageUpdateRequestDecisionConflictError,
  StageUpdateRequestNoteInvalidError,
  StageUpdateRequestNotFoundError,
  StageUpdateRequestRevisionInvalidError,
  StageUpdateRequestStageOwnershipConflictError,
} from '../src/domain/stage-update-request/errors.js';
import { makeServices, uuid } from './helpers.js';

type Services = ReturnType<typeof makeServices>;

const FIXED_NOW = '2026-08-11T08:00:00.000Z';

/** 受信上下文：只含服务端认证层能解析出的字段。 */
function authContextFor(actorId: string): AuthenticatedAiActorContext {
  return Object.freeze({ actorId, actorCode: 'test-actor', actorType: 'resident_ai' });
}

/** 共享仓储：创建项目与一个初始关卡（status=not_started, version=1）。 */
async function seedStage(services: Services): Promise<{ projectId: string; stage: ProjectStage }> {
  const projectId = uuid();
  await services.projectService.createProject({ id: projectId, name: '批准服务测试项目' });
  const { stage } = await services.stageService.createStage(projectId, {
    id: uuid(),
    name: '第一关',
    position: 1,
  });
  return { projectId, stage };
}

/** 构造使用固定时钟、与共享仓储同源的服务实例。 */
function makeService(services: Services) {
  return new StageUpdateRequestService(
    services.stageUpdateRequestRepository,
    services.stageUpdateRequestApprovalRepository,
    services.stageRepository,
    () => FIXED_NOW,
  );
}

/** 通过服务创建一个 pending 申请。 */
async function createPending(
  service: StageUpdateRequestService,
  stage: ProjectStage,
  proposedStatus: ProjectStage['status'] = 'in_progress',
): Promise<StageUpdateRequest> {
  return service.submit(authContextFor(uuid()), {
    id: uuid(),
    stageId: stage.id,
    expectedStageVersion: stage.version,
    proposedStatus,
    reason: '完成第一关，申请进入下一阶段',
  });
}

describe('StageUpdateRequestService.approve', () => {
  it('approves a pending request and atomically transitions the Stage (not_started -> in_progress)', async () => {
    const services = makeServices();
    const { projectId, stage } = await seedStage(services);
    const service = makeService(services);
    const request = await createPending(service, stage);

    const approved = await service.approve(request.id, {
      expectedRevision: 1,
      note: '  同意进入下一阶段  ',
    });
    expect(approved.status).toBe('approved');
    expect(approved.revision).toBe(2);
    expect(approved.decision).toEqual({
      type: 'approved',
      note: '同意进入下一阶段',
      decidedAt: FIXED_NOW,
    });
    expect(approved.updatedAt).toBe(FIXED_NOW);
    // 原申请核心字段逐项不变。
    expect(approved.projectId).toBe(projectId);
    expect(approved.stageId).toBe(stage.id);
    expect(approved.requesterActorId).toBe(request.requesterActorId);
    expect(approved.expectedStageVersion).toBe(1);
    expect(approved.proposedStatus).toBe('in_progress');
    expect(approved.reason).toBe(request.reason);
    expect(approved.createdAt).toBe(request.createdAt);

    // 正式 Stage 同步迁移：首次进入 in_progress 写 startedAt，version +1。
    const updated = await services.stageRepository.findById(stage.id);
    expect(updated?.status).toBe('in_progress');
    expect(updated?.startedAt).toBe(FIXED_NOW);
    expect(updated?.completedAt).toBeNull();
    expect(updated?.version).toBe(stage.version + 1);
    expect(updated?.updatedAt).toBe(FIXED_NOW);
    expect(updated?.createdAt).toBe(stage.createdAt);
  });

  it('entering completed sets startedAt if empty and completedAt; leaving completed clears completedAt, keeps startedAt', async () => {
    const services = makeServices();
    const { stage } = await seedStage(services);
    const service = makeService(services);

    // not_started -> completed：startedAt 与 completedAt 都写入。
    const reqToCompleted = await createPending(service, stage, 'completed');
    await service.approve(reqToCompleted.id, { expectedRevision: 1, note: '全部完成' });
    const completedStage = await services.stageRepository.findById(stage.id);
    expect(completedStage?.status).toBe('completed');
    expect(completedStage?.startedAt).toBe(FIXED_NOW);
    expect(completedStage?.completedAt).toBe(FIXED_NOW);
    expect(completedStage?.version).toBe(2);

    // completed -> not_started：completedAt 清空、startedAt 保留。
    const reqToReset = await createPending(service, completedStage!, 'not_started');
    await service.approve(reqToReset.id, { expectedRevision: 1, note: '回到未开始' });
    const resetStage = await services.stageRepository.findById(stage.id);
    expect(resetStage?.status).toBe('not_started');
    expect(resetStage?.startedAt).toBe(FIXED_NOW);
    expect(resetStage?.completedAt).toBeNull();
    expect(resetStage?.version).toBe(3);
  });

  it('target status equal to current: request approved but Stage version/updatedAt NOT advanced', async () => {
    const services = makeServices();
    const { stage } = await seedStage(services);
    const service = makeService(services);
    // 先把 Stage 推进到 in_progress。
    await services.stageService.setStageStatus(stage.id, {
      status: 'in_progress',
      expectedVersion: stage.version,
    });
    const advanced = (await services.stageRepository.findById(stage.id))!;
    expect(advanced.version).toBe(stage.version + 1);
    const snapshot = { ...advanced };

    const request = await createPending(service, advanced, 'in_progress');
    const approved = await service.approve(request.id, { expectedRevision: 1, note: '确认维持当前状态' });
    expect(approved.status).toBe('approved');
    expect(approved.revision).toBe(2);

    const after = await services.stageRepository.findById(stage.id);
    expect(after).toEqual(snapshot);
    expect(after?.version).toBe(advanced.version);
    expect(after?.updatedAt).toBe(advanced.updatedAt);
  });

  it('identical approve retry returns the original approved request without re-modifying Stage, even after the Stage is later upgraded', async () => {
    const services = makeServices();
    const { stage } = await seedStage(services);
    const service = makeService(services);
    const request = await createPending(service, stage);

    const first = await service.approve(request.id, { expectedRevision: 1, note: '批准进入下一阶段' });
    expect(first.status).toBe('approved');

    // Stage 稍后被正常写入升级（模拟后续主进度推进）。
    const upgraded = await services.stageService.setStageStatus(stage.id, {
      status: 'completed',
      expectedVersion: stage.version + 1,
    });
    expect(upgraded.version).toBe(stage.version + 2);

    // 相同批准重试：幂等返回原申请，不依赖 Stage 之后的版本，也不再次修改 Stage。
    const retry = await service.approve(request.id, { expectedRevision: 1, note: '  批准进入下一阶段  ' });
    expect(retry).toEqual(first);
    expect(retry.revision).toBe(2);
    const after = await services.stageRepository.findById(stage.id);
    expect(after?.version).toBe(upgraded.version);
    expect(await services.stageUpdateRequestService.listByStage(stage.id)).toHaveLength(1);
  });

  it('Stage pre-advanced before approval: stable 409 version conflict, request stays pending, no silent overwrite', async () => {
    const services = makeServices();
    const { stage } = await seedStage(services);
    const service = makeService(services);
    const request = await createPending(service, stage);

    // 提交申请后、批准前，正式 Stage 被正常写入推进。
    await services.stageService.setStageStatus(stage.id, {
      status: 'in_progress',
      expectedVersion: stage.version,
    });
    const advanced = (await services.stageRepository.findById(stage.id))!;
    expect(advanced.version).toBe(stage.version + 1);

    await expect(
      service.approve(request.id, { expectedRevision: 1, note: '批准进入下一阶段' }),
    ).rejects.toBeInstanceOf(StageVersionConflictError);

    // 申请保持 pending，Stage 未被覆盖为申请所依据的旧版本。
    const read = await services.stageUpdateRequestService.getById(request.id);
    expect(read?.status).toBe('pending');
    expect(read?.revision).toBe(1);
    expect(read?.decision).toBeNull();
    expect((await services.stageRepository.findById(stage.id))?.version).toBe(advanced.version);
  });

  it('returns 404 when the request is missing', async () => {
    const services = makeServices();
    const service = makeService(services);
    await expect(
      service.approve(uuid(), { expectedRevision: 1, note: '批准' }),
    ).rejects.toBeInstanceOf(StageUpdateRequestNotFoundError);
  });

  it('returns 404 when the real Stage is missing (request stays pending)', async () => {
    const services = makeServices();
    const { stage } = await seedStage(services);
    const service = makeService(services);
    const request = await createPending(service, stage);

    // 模拟 Stage 被删除。
    services.store.stages.delete(stage.id);

    await expect(
      service.approve(request.id, { expectedRevision: 1, note: '批准' }),
    ).rejects.toBeInstanceOf(StageNotFoundError);
    expect((await services.stageUpdateRequestService.getById(request.id))?.status).toBe('pending');
  });

  it('returns 409 ownership conflict when the Stage projectId no longer matches the request', async () => {
    const services = makeServices();
    const { stage } = await seedStage(services);
    const service = makeService(services);
    const request = await createPending(service, stage);

    // 模拟 Stage 归属被替换（脏数据）。
    services.store.stages.set(stage.id, { ...stage, projectId: uuid() });

    await expect(
      service.approve(request.id, { expectedRevision: 1, note: '批准' }),
    ).rejects.toBeInstanceOf(StageUpdateRequestStageOwnershipConflictError);
    expect((await services.stageUpdateRequestService.getById(request.id))?.status).toBe('pending');
  });

  it('returns 409 for wrong expectedRevision while pending, and for a different note after approval', async () => {
    const services = makeServices();
    const { stage } = await seedStage(services);
    const service = makeService(services);
    const request = await createPending(service, stage);

    // 仍 pending 但 expectedRevision 陈旧。
    await expect(
      service.approve(request.id, { expectedRevision: 2, note: '批准' }),
    ).rejects.toBeInstanceOf(StageUpdateRequestDecisionConflictError);

    // 成功批准后，不同 note → 409，绝不覆盖第一次决定。
    await service.approve(request.id, { expectedRevision: 1, note: '第一次批准' });
    await expect(
      service.approve(request.id, { expectedRevision: 1, note: '不同批准说明' }),
    ).rejects.toBeInstanceOf(StageUpdateRequestDecisionConflictError);
    const read = await services.stageUpdateRequestService.getById(request.id);
    expect(read?.decision?.note).toBe('第一次批准');
  });

  it('approve and the other decisions are mutually exclusive across types (409)', async () => {
    const services = makeServices();
    const { stage } = await seedStage(services);
    const service = makeService(services);

    // 先批准：之后 requestChanges / reject 都必须 409，绝不覆盖批准决定。
    const approved = await createPending(service, stage);
    await service.approve(approved.id, { expectedRevision: 1, note: '批准' });
    await expect(
      service.requestChanges(approved.id, { expectedRevision: 1, note: '请补充' }),
    ).rejects.toBeInstanceOf(StageUpdateRequestDecisionConflictError);
    await expect(
      service.reject(approved.id, { expectedRevision: 1, note: '拒绝' }),
    ).rejects.toBeInstanceOf(StageUpdateRequestDecisionConflictError);

    // approve 推进了正式 Stage 版本；后续申请以最新版本为准。
    const advancedStage = (await services.stageRepository.findById(stage.id))!;
    expect(advancedStage.version).toBe(stage.version + 1);

    // 对称：先 needs_changes / rejected，之后 approve 也必须 409，Stage 不变。
    const changes = await createPending(service, advancedStage);
    await service.requestChanges(changes.id, { expectedRevision: 1, note: '请补充' });
    await expect(
      service.approve(changes.id, { expectedRevision: 1, note: '批准' }),
    ).rejects.toBeInstanceOf(StageUpdateRequestDecisionConflictError);

    const rejected = await createPending(service, advancedStage);
    await service.reject(rejected.id, { expectedRevision: 1, note: '拒绝' });
    await expect(
      service.approve(rejected.id, { expectedRevision: 1, note: '批准' }),
    ).rejects.toBeInstanceOf(StageUpdateRequestDecisionConflictError);

    const read = await services.stageUpdateRequestService.getById(changes.id);
    expect(read?.status).toBe('needs_changes');
    expect(read?.decision?.type).toBe('needs_changes');
    const readRejected = await services.stageUpdateRequestService.getById(rejected.id);
    expect(readRejected?.status).toBe('rejected');
    expect(readRejected?.decision?.type).toBe('rejected');
  });

  it('validates input: non-integer expectedRevision and blank note are controlled 400 errors', async () => {
    const services = makeServices();
    const { stage } = await seedStage(services);
    const service = makeService(services);
    const request = await createPending(service, stage);

    await expect(
      service.approve(request.id, { expectedRevision: 0, note: '批准' }),
    ).rejects.toBeInstanceOf(StageUpdateRequestRevisionInvalidError);
    await expect(
      service.approve(request.id, { expectedRevision: 1.5, note: '批准' }),
    ).rejects.toBeInstanceOf(StageUpdateRequestRevisionInvalidError);
    await expect(
      service.approve(request.id, { expectedRevision: 1, note: '   ' }),
    ).rejects.toBeInstanceOf(StageUpdateRequestNoteInvalidError);
    // 校验失败不写任何数据。
    expect((await services.stageUpdateRequestService.getById(request.id))?.status).toBe('pending');
  });

  it('controlled error messages never echo the note, reason or requester identity', async () => {
    const services = makeServices();
    const { stage } = await seedStage(services);
    const service = makeService(services);
    const DISTINCTIVE_NOTE = '唯一不可回显的批准说明-7f3a';
    const DISTINCTIVE_REASON = '唯一不可回显的申请理由-9c2b';
    const actorId = uuid();

    const request = await service.submit(authContextFor(actorId), {
      id: uuid(),
      stageId: stage.id,
      expectedStageVersion: stage.version,
      proposedStatus: 'in_progress',
      reason: DISTINCTIVE_REASON,
    });

    await service.approve(request.id, { expectedRevision: 1, note: DISTINCTIVE_NOTE });

    // 已决定后不同 note 的 409：消息只含申请 id 与稳定文案，不回显 note。
    try {
      await service.approve(request.id, { expectedRevision: 1, note: '不同说明' });
      throw new Error('expected a decision conflict');
    } catch (err) {
      const message = (err as Error).message;
      expect(message).not.toContain(DISTINCTIVE_NOTE);
      expect(message).not.toContain(DISTINCTIVE_REASON);
      expect(message).not.toContain(actorId);
    }
  });

  it('20 concurrent approvals: exactly one wins, request approved once and Stage advances once', async () => {
    const services = makeServices();
    const { stage } = await seedStage(services);
    const service = makeService(services);
    const request = await createPending(service, stage);

    const results = await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        service
          .approve(request.id, { expectedRevision: 1, note: `批准 ${i}` })
          .then(() => 'ok' as const, () => 'lost' as const),
      ),
    );
    expect(results.filter((r) => r === 'ok')).toHaveLength(1);

    const read = await services.stageUpdateRequestService.getById(request.id);
    expect(read?.status).toBe('approved');
    expect(read?.revision).toBe(2);
    const stageAfter = await services.stageRepository.findById(stage.id);
    expect(stageAfter?.status).toBe('in_progress');
    expect(stageAfter?.version).toBe(stage.version + 1);
  });

  it('20 mixed approve/reject/request-changes: only one final decision; only an approve advances the Stage', async () => {
    const services = makeServices();
    const { stage } = await seedStage(services);
    const service = makeService(services);
    const request = await createPending(service, stage);

    const results = await Promise.all(
      Array.from({ length: 20 }, (_, i) => {
        const kind = i % 3;
        if (kind === 0) {
          return service
            .approve(request.id, { expectedRevision: 1, note: `批准 ${i}` })
            .then(() => 'ok' as const, () => 'lost' as const);
        }
        if (kind === 1) {
          return service
            .reject(request.id, { expectedRevision: 1, note: `拒绝 ${i}` })
            .then(() => 'ok' as const, () => 'lost' as const);
        }
        return service
          .requestChanges(request.id, { expectedRevision: 1, note: `补充 ${i}` })
          .then(() => 'ok' as const, () => 'lost' as const);
      }),
    );
    const wins = results.filter((r) => r === 'ok');
    expect(wins).toHaveLength(1);

    const read = await services.stageUpdateRequestService.getById(request.id);
    expect(read?.revision).toBe(2);
    const stageAfter = await services.stageRepository.findById(stage.id);
    if (read?.status === 'approved') {
      // 批准的胜出才同步更新正式 Stage。
      expect(read?.decision?.type).toBe('approved');
      expect(stageAfter?.status).toBe('in_progress');
      expect(stageAfter?.version).toBe(stage.version + 1);
    } else {
      // 其余决定胜出：Stage 完全不变。
      expect(stageAfter).toEqual(stage);
    }
  });

  it('a normal Stage write and an approval are mutually exclusive on the Stage version', async () => {
    const services = makeServices();
    const { stage } = await seedStage(services);
    const service = makeService(services);
    const request = await createPending(service, stage);

    // 两者都以 v1 为乐观并发前提竞争 Stage 写入：approve（经申请）与 setStageStatus。
    const [stageWrite, approval] = await Promise.all([
      services.stageService
        .setStageStatus(stage.id, { status: 'in_progress', expectedVersion: stage.version })
        .then(() => 'stage-won' as const, () => 'stage-lost' as const),
      service
        .approve(request.id, { expectedRevision: 1, note: '批准' })
        .then(() => 'approve-won' as const, () => 'approve-lost' as const),
    ]);

    const stageAfter = (await services.stageRepository.findById(stage.id))!;
    const requestAfter = (await services.stageUpdateRequestService.getById(request.id))!;
    // 至少且最多一边成功写入 Stage 版本；两侧状态一致、无半完成。
    expect([stageWrite, approval].filter((r) => r.endsWith('-won'))).toHaveLength(1);
    expect(stageAfter.status).toBe('in_progress');
    expect(stageAfter.version).toBe(stage.version + 1);
    if (approval === 'approve-won') {
      expect(requestAfter.status).toBe('approved');
    } else {
      expect(requestAfter.status).toBe('pending');
      expect(requestAfter.decision).toBeNull();
    }
  });
});
