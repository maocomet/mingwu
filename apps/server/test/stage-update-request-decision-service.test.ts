import { describe, expect, it } from 'vitest';
import {
  countCodePoints,
  STAGE_UPDATE_NOTE_MAX_LENGTH,
  type AuthenticatedAiActorContext,
  type ProjectStage,
  type StageUpdateRequest,
} from '@mingwu/contracts';
import { StageUpdateRequestService } from '../src/application/stage-update-request/stage-update-request-service.js';
import {
  StageUpdateRequestDecisionConflictError,
  StageUpdateRequestNoteInvalidError,
  StageUpdateRequestNotFoundError,
  StageUpdateRequestRevisionInvalidError,
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
  await services.projectService.createProject({ id: projectId, name: '要求补充测试项目' });
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

/** 时钟每次调用推进一秒，用于断言决定刷新 updatedAt / decidedAt。 */
function makeAdvancingClock(base: string) {
  let i = 0;
  return () => new Date(Date.parse(base) + i++ * 1000).toISOString();
}

/** 通过服务创建一个 pending 申请，返回其完整对象。 */
async function createPending(
  service: StageUpdateRequestService,
  stage: ProjectStage,
): Promise<StageUpdateRequest> {
  return service.submit(authContextFor(uuid()), {
    id: uuid(),
    stageId: stage.id,
    expectedStageVersion: stage.version,
    proposedStatus: 'in_progress',
    reason: '完成第一关，申请进入下一阶段',
  });
}

/** 读取关卡全部可比较字段，断言决定前后完全不变。 */
async function readStageSnapshot(services: Services, stageId: string) {
  const stage = await services.stageRepository.findById(stageId);
  if (!stage) {
    throw new Error('stage should exist');
  }
  return {
    status: stage.status,
    version: stage.version,
    startedAt: stage.startedAt,
    completedAt: stage.completedAt,
    createdAt: stage.createdAt,
    updatedAt: stage.updatedAt,
  };
}

describe('StageUpdateRequestService.requestChanges', () => {
  it('marks a pending request as needs_changes: revision 1->2, note/decidedAt correct, original fields unchanged, Stage unchanged', async () => {
    const services = makeServices();
    const { projectId, stage } = await seedStage(services);
    const service = new StageUpdateRequestService(
      services.stageUpdateRequestRepository,
      services.stageUpdateRequestApprovalRepository,
      services.stageRepository,
      makeAdvancingClock(FIXED_NOW),
    );
    const request = await createPending(service, stage);
    // 创建时：revision=1，decision=null，updatedAt 等于 createdAt。
    expect(request.revision).toBe(1);
    expect(request.decision).toBeNull();
    expect(request.updatedAt).toBe(request.createdAt);

    const before = await readStageSnapshot(services, stage.id);
    const decided = await service.requestChanges(request.id, {
      expectedRevision: 1,
      note: '  请补充技术细节与验收标准  ',
    });
    const after = await readStageSnapshot(services, stage.id);

    // 决定结果：needs_changes、revision 2、note trim 后保存、decidedAt 服务端采样。
    expect(decided.status).toBe('needs_changes');
    expect(decided.revision).toBe(2);
    expect(decided.decision).toEqual({
      type: 'needs_changes',
      note: '请补充技术细节与验收标准',
      decidedAt: expect.any(String),
    });
    // updatedAt / decidedAt 由服务端刷新到新的采样时间，不再等于创建时间。
    expect(decided.updatedAt).toBe(decided.decision!.decidedAt);
    expect(decided.updatedAt).not.toBe(decided.createdAt);
    // 原申请核心字段逐项不变。
    expect(decided.projectId).toBe(projectId);
    expect(decided.stageId).toBe(stage.id);
    expect(decided.requesterActorId).toBe(request.requesterActorId);
    expect(decided.expectedStageVersion).toBe(1);
    expect(decided.proposedStatus).toBe('in_progress');
    expect(decided.reason).toBe(request.reason);
    expect(decided.createdAt).toBe(request.createdAt);
    // 正式 Stage 完全不变（status/version/时间字段一个不动）。
    expect(after).toEqual(before);
  });

  it('identical retry after a decision returns the same decided request without advancing revision/updatedAt', async () => {
    const services = makeServices();
    const { stage } = await seedStage(services);
    const service = makeService(services);
    const request = await createPending(service, stage);

    const first = await service.requestChanges(request.id, {
      expectedRevision: 1,
      note: '请补充细节',
    });
    expect(first.status).toBe('needs_changes');
    expect(first.revision).toBe(2);

    // 完全相同请求（note 带排版差异也归一化）重试：幂等返回原决定，revision 不再 +1。
    const retry = await service.requestChanges(request.id, {
      expectedRevision: 1,
      note: '  请补充细节  ',
    });
    expect(retry).toEqual(first);
    expect(retry.revision).toBe(2);
    expect(retry.updatedAt).toBe(first.updatedAt);
    expect(await service.listByStage(stage.id)).toHaveLength(1);
  });

  it('a different note or wrong expectedRevision after decision is a controlled conflict and never overwrites the first decision', async () => {
    const services = makeServices();
    const { stage } = await seedStage(services);
    const service = makeService(services);
    const request = await createPending(service, stage);

    const first = await service.requestChanges(request.id, {
      expectedRevision: 1,
      note: '请补充细节',
    });

    // 已决定后不同 note → 受控冲突。
    await expect(
      service.requestChanges(request.id, { expectedRevision: 1, note: '不同说明' }),
    ).rejects.toBeInstanceOf(StageUpdateRequestDecisionConflictError);
    // 已决定后错误 expectedRevision（即使 note 相同）→ 受控冲突。
    await expect(
      service.requestChanges(request.id, { expectedRevision: 2, note: '请补充细节' }),
    ).rejects.toBeInstanceOf(StageUpdateRequestDecisionConflictError);
    // 已决定后完全不同的请求 → 受控冲突。
    await expect(
      service.requestChanges(request.id, { expectedRevision: 99, note: '另一个说明' }),
    ).rejects.toBeInstanceOf(StageUpdateRequestDecisionConflictError);

    // 第一次决定从未被覆盖。
    const read = await service.getById(request.id);
    expect(read?.status).toBe('needs_changes');
    expect(read?.revision).toBe(2);
    expect(read?.decision?.note).toBe('请补充细节');
    expect(read).toEqual(first);
  });

  it('rejects a stale/wrong expectedRevision while the request is still pending', async () => {
    const services = makeServices();
    const { stage } = await seedStage(services);
    const service = makeService(services);
    const request = await createPending(service, stage);

    await expect(
      service.requestChanges(request.id, { expectedRevision: 2, note: '说明' }),
    ).rejects.toBeInstanceOf(StageUpdateRequestDecisionConflictError);
    await expect(
      service.requestChanges(request.id, { expectedRevision: 99, note: '说明' }),
    ).rejects.toBeInstanceOf(StageUpdateRequestDecisionConflictError);

    // 仍保持 pending，未被写入任何决定。
    const read = await service.getById(request.id);
    expect(read?.status).toBe('pending');
    expect(read?.decision).toBeNull();
    expect(read?.revision).toBe(1);
  });

  it('rejects an unknown request id with StageUpdateRequestNotFoundError', async () => {
    const services = makeServices();
    const { stage } = await seedStage(services);
    const service = makeService(services);
    await createPending(service, stage);

    await expect(
      service.requestChanges(uuid(), { expectedRevision: 1, note: '说明' }),
    ).rejects.toBeInstanceOf(StageUpdateRequestNotFoundError);
  });

  it('rejects non-positive / non-integer expectedRevision as a revision error', async () => {
    const services = makeServices();
    const { stage } = await seedStage(services);
    const service = makeService(services);
    const request = await createPending(service, stage);

    await expect(
      service.requestChanges(request.id, { expectedRevision: 0, note: '说明' }),
    ).rejects.toBeInstanceOf(StageUpdateRequestRevisionInvalidError);
    await expect(
      service.requestChanges(request.id, { expectedRevision: -1, note: '说明' }),
    ).rejects.toBeInstanceOf(StageUpdateRequestRevisionInvalidError);
    await expect(
      service.requestChanges(request.id, { expectedRevision: 1.5, note: '说明' }),
    ).rejects.toBeInstanceOf(StageUpdateRequestRevisionInvalidError);

    // 无副作用。
    const read = await service.getById(request.id);
    expect(read?.status).toBe('pending');
    expect(read?.decision).toBeNull();
  });

  it('rejects blank note and enforces the code-point boundary (astral emoji MAX passes, MAX+1 fails)', async () => {
    const services = makeServices();
    const { stage } = await seedStage(services);
    const service = makeService(services);
    const request = await createPending(service, stage);

    // trim 后为空。
    await expect(
      service.requestChanges(request.id, { expectedRevision: 1, note: '' }),
    ).rejects.toBeInstanceOf(StageUpdateRequestNoteInvalidError);
    await expect(
      service.requestChanges(request.id, { expectedRevision: 1, note: '   ' }),
    ).rejects.toBeInstanceOf(StageUpdateRequestNoteInvalidError);

    // 恰好上限个 astral emoji 放行（按 code point 计数，而非 UTF-16 单元）。
    const exact = await service.requestChanges(request.id, {
      expectedRevision: 1,
      note: '😀'.repeat(STAGE_UPDATE_NOTE_MAX_LENGTH),
    });
    expect(countCodePoints(exact.decision!.note)).toBe(STAGE_UPDATE_NOTE_MAX_LENGTH);

    // 上限 + 1 拒绝（新的 pending 申请，避免撞上已决定冲突）。
    const second = await createPending(service, stage);
    await expect(
      service.requestChanges(second.id, {
        expectedRevision: 1,
        note: '😀'.repeat(STAGE_UPDATE_NOTE_MAX_LENGTH + 1),
      }),
    ).rejects.toBeInstanceOf(StageUpdateRequestNoteInvalidError);
    const read = await service.getById(second.id);
    expect(read?.status).toBe('pending');
    expect(read?.decision).toBeNull();
  });

  it('20 concurrent same-revision different-note decisions: exactly one winner, rest are controlled conflicts, final revision 2', async () => {
    const services = makeServices();
    const { stage } = await seedStage(services);
    const service = makeService(services);
    const request = await createPending(service, stage);

    const results = await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        service
          .requestChanges(request.id, { expectedRevision: 1, note: `说明 ${i}` })
          .catch((err: unknown) => err),
      ),
    );
    const successes = results.filter((r) => !(r instanceof Error));
    const conflicts = results.filter((r) => r instanceof StageUpdateRequestDecisionConflictError);
    // 不同 note：恰好一个决定胜出，其余全部为受控冲突。
    expect(successes.length).toBe(1);
    expect(conflicts.length).toBe(19);

    const read = await service.getById(request.id);
    expect(read?.status).toBe('needs_changes');
    expect(read?.revision).toBe(2);
    expect(read?.decision?.note).toBe((successes[0] as StageUpdateRequest).decision?.note);
    // 决定前后正式 Stage 不变。
    const after = await readStageSnapshot(services, stage.id);
    expect(after.status).toBe('not_started');
    expect(after.version).toBe(1);
  });

  it('20 concurrent same-revision same-note decisions: one decision wins, the rest are stable conflicts or idempotent hits; final revision 2', async () => {
    const services = makeServices();
    const { stage } = await seedStage(services);
    const service = makeService(services);
    const request = await createPending(service, stage);

    const results = await Promise.all(
      Array.from({ length: 20 }, () =>
        service
          .requestChanges(request.id, { expectedRevision: 1, note: '同一条说明' })
          .catch((err: unknown) => err),
      ),
    );
    const successes = results.filter((r) => !(r instanceof Error));
    const conflicts = results.filter((r) => r instanceof StageUpdateRequestDecisionConflictError);
    // 同 note 并发：至少一个成功创建决定；其余要么幂等命中（同决定）要么稳定冲突，
    // 绝不覆盖第一次决定。
    expect(successes.length).toBeGreaterThanOrEqual(1);
    expect(successes.length + conflicts.length).toBe(20);

    const read = await service.getById(request.id);
    expect(read?.status).toBe('needs_changes');
    expect(read?.revision).toBe(2);
    for (const r of successes) {
      expect((r as StageUpdateRequest).decision?.note).toBe('同一条说明');
      expect((r as StageUpdateRequest).revision).toBe(2);
    }
  });
});

describe('StageUpdateRequestService.reject', () => {
  it('marks a pending request as rejected: revision 1->2, note/decidedAt correct, original fields unchanged, Stage unchanged', async () => {
    const services = makeServices();
    const { projectId, stage } = await seedStage(services);
    const service = new StageUpdateRequestService(
      services.stageUpdateRequestRepository,
      services.stageUpdateRequestApprovalRepository,
      services.stageRepository,
      makeAdvancingClock(FIXED_NOW),
    );
    const request = await createPending(service, stage);

    const before = await readStageSnapshot(services, stage.id);
    const decided = await service.reject(request.id, {
      expectedRevision: 1,
      note: '  不符合验收标准，予以拒绝  ',
    });
    const after = await readStageSnapshot(services, stage.id);

    expect(decided.status).toBe('rejected');
    expect(decided.revision).toBe(2);
    expect(decided.decision).toEqual({
      type: 'rejected',
      note: '不符合验收标准，予以拒绝',
      decidedAt: expect.any(String),
    });
    // updatedAt / decidedAt 由服务端刷新，不再等于创建时间。
    expect(decided.updatedAt).toBe(decided.decision!.decidedAt);
    expect(decided.updatedAt).not.toBe(decided.createdAt);
    // 原申请核心字段逐项不变。
    expect(decided.projectId).toBe(projectId);
    expect(decided.stageId).toBe(stage.id);
    expect(decided.requesterActorId).toBe(request.requesterActorId);
    expect(decided.expectedStageVersion).toBe(1);
    expect(decided.proposedStatus).toBe('in_progress');
    expect(decided.reason).toBe(request.reason);
    expect(decided.createdAt).toBe(request.createdAt);
    // 正式 Stage 完全不变。
    expect(after).toEqual(before);
  });

  it('identical reject retry returns the same decided request without advancing revision/updatedAt', async () => {
    const services = makeServices();
    const { stage } = await seedStage(services);
    const service = makeService(services);
    const request = await createPending(service, stage);

    const first = await service.reject(request.id, {
      expectedRevision: 1,
      note: '不符合要求',
    });
    expect(first.status).toBe('rejected');
    expect(first.revision).toBe(2);

    // 完全相同请求（note 带排版差异也归一化）重试：幂等返回原决定，revision 不再 +1。
    const retry = await service.reject(request.id, {
      expectedRevision: 1,
      note: '  不符合要求  ',
    });
    expect(retry).toEqual(first);
    expect(retry.revision).toBe(2);
    expect(retry.updatedAt).toBe(first.updatedAt);
    expect(await service.listByStage(stage.id)).toHaveLength(1);
  });

  it('a different note or wrong expectedRevision after rejection is a controlled conflict and never overwrites the first decision', async () => {
    const services = makeServices();
    const { stage } = await seedStage(services);
    const service = makeService(services);
    const request = await createPending(service, stage);

    const first = await service.reject(request.id, { expectedRevision: 1, note: '不符合要求' });

    await expect(
      service.reject(request.id, { expectedRevision: 1, note: '不同说明' }),
    ).rejects.toBeInstanceOf(StageUpdateRequestDecisionConflictError);
    await expect(
      service.reject(request.id, { expectedRevision: 2, note: '不符合要求' }),
    ).rejects.toBeInstanceOf(StageUpdateRequestDecisionConflictError);
    await expect(
      service.reject(request.id, { expectedRevision: 99, note: '另一个说明' }),
    ).rejects.toBeInstanceOf(StageUpdateRequestDecisionConflictError);

    const read = await service.getById(request.id);
    expect(read?.status).toBe('rejected');
    expect(read?.revision).toBe(2);
    expect(read?.decision?.note).toBe('不符合要求');
    expect(read).toEqual(first);
  });

  it('rejects a stale/wrong expectedRevision while still pending without writing any decision', async () => {
    const services = makeServices();
    const { stage } = await seedStage(services);
    const service = makeService(services);
    const request = await createPending(service, stage);

    await expect(
      service.reject(request.id, { expectedRevision: 2, note: '说明' }),
    ).rejects.toBeInstanceOf(StageUpdateRequestDecisionConflictError);
    await expect(
      service.reject(request.id, { expectedRevision: 99, note: '说明' }),
    ).rejects.toBeInstanceOf(StageUpdateRequestDecisionConflictError);

    const read = await service.getById(request.id);
    expect(read?.status).toBe('pending');
    expect(read?.decision).toBeNull();
    expect(read?.revision).toBe(1);
  });

  it('rejects an unknown request id with StageUpdateRequestNotFoundError', async () => {
    const services = makeServices();
    const { stage } = await seedStage(services);
    const service = makeService(services);
    await createPending(service, stage);

    await expect(
      service.reject(uuid(), { expectedRevision: 1, note: '说明' }),
    ).rejects.toBeInstanceOf(StageUpdateRequestNotFoundError);
  });

  it('rejects non-positive / non-integer expectedRevision as a revision error with no side effects', async () => {
    const services = makeServices();
    const { stage } = await seedStage(services);
    const service = makeService(services);
    const request = await createPending(service, stage);

    await expect(
      service.reject(request.id, { expectedRevision: 0, note: '说明' }),
    ).rejects.toBeInstanceOf(StageUpdateRequestRevisionInvalidError);
    await expect(
      service.reject(request.id, { expectedRevision: -1, note: '说明' }),
    ).rejects.toBeInstanceOf(StageUpdateRequestRevisionInvalidError);
    await expect(
      service.reject(request.id, { expectedRevision: 1.5, note: '说明' }),
    ).rejects.toBeInstanceOf(StageUpdateRequestRevisionInvalidError);

    const read = await service.getById(request.id);
    expect(read?.status).toBe('pending');
    expect(read?.decision).toBeNull();
  });

  it('rejects blank note and enforces the code-point boundary (astral emoji MAX passes, MAX+1 fails)', async () => {
    const services = makeServices();
    const { stage } = await seedStage(services);
    const service = makeService(services);
    const request = await createPending(service, stage);

    await expect(
      service.reject(request.id, { expectedRevision: 1, note: '' }),
    ).rejects.toBeInstanceOf(StageUpdateRequestNoteInvalidError);
    await expect(
      service.reject(request.id, { expectedRevision: 1, note: '   ' }),
    ).rejects.toBeInstanceOf(StageUpdateRequestNoteInvalidError);

    // 恰好上限个 astral emoji 放行（按 code point 计数）。
    const exact = await service.reject(request.id, {
      expectedRevision: 1,
      note: '😀'.repeat(STAGE_UPDATE_NOTE_MAX_LENGTH),
    });
    expect(countCodePoints(exact.decision!.note)).toBe(STAGE_UPDATE_NOTE_MAX_LENGTH);

    // 上限 + 1 拒绝（新的 pending 申请，避免撞上已决定冲突）。
    const second = await createPending(service, stage);
    await expect(
      service.reject(second.id, {
        expectedRevision: 1,
        note: '😀'.repeat(STAGE_UPDATE_NOTE_MAX_LENGTH + 1),
      }),
    ).rejects.toBeInstanceOf(StageUpdateRequestNoteInvalidError);
    const read = await service.getById(second.id);
    expect(read?.status).toBe('pending');
    expect(read?.decision).toBeNull();
  });

  it('20 concurrent same-revision different-note rejections: exactly one winner, rest are controlled conflicts, final revision 2', async () => {
    const services = makeServices();
    const { stage } = await seedStage(services);
    const service = makeService(services);
    const request = await createPending(service, stage);

    const results = await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        service
          .reject(request.id, { expectedRevision: 1, note: `拒绝理由 ${i}` })
          .catch((err: unknown) => err),
      ),
    );
    const successes = results.filter((r) => !(r instanceof Error));
    const conflicts = results.filter((r) => r instanceof StageUpdateRequestDecisionConflictError);
    // 不同 note：恰好一个决定胜出，其余全部为受控冲突。
    expect(successes.length).toBe(1);
    expect(conflicts.length).toBe(19);

    const read = await service.getById(request.id);
    expect(read?.status).toBe('rejected');
    expect(read?.revision).toBe(2);
    expect(read?.decision?.note).toBe((successes[0] as StageUpdateRequest).decision?.note);
    // 决定前后正式 Stage 不变。
    const after = await readStageSnapshot(services, stage.id);
    expect(after.status).toBe('not_started');
    expect(after.version).toBe(1);
  });

  it('cross-type conflicts: a rejected request cannot be requestChanges’d, a needs_changes request cannot be rejected', async () => {
    const services = makeServices();
    const { stage } = await seedStage(services);
    const service = makeService(services);

    // 先拒绝一个申请：之后任何 requestChanges 都必须 409，绝不覆盖拒绝决定。
    const rejected = await createPending(service, stage);
    const first = await service.reject(rejected.id, { expectedRevision: 1, note: '不符合要求' });
    await expect(
      service.requestChanges(rejected.id, { expectedRevision: 1, note: '请补充' }),
    ).rejects.toBeInstanceOf(StageUpdateRequestDecisionConflictError);
    // 但完全相同类型与内容的 reject 重试仍幂等返回原决定。
    const retry = await service.reject(rejected.id, { expectedRevision: 1, note: '不符合要求' });
    expect(retry).toEqual(first);

    // 对称：先要求补充，之后任何 reject 都必须 409，绝不覆盖 needs_changes 决定。
    const changed = await createPending(service, stage);
    const second = await service.requestChanges(changed.id, { expectedRevision: 1, note: '请补充' });
    await expect(
      service.reject(changed.id, { expectedRevision: 1, note: '不符合要求' }),
    ).rejects.toBeInstanceOf(StageUpdateRequestDecisionConflictError);
    const retryChanged = await service.requestChanges(changed.id, {
      expectedRevision: 1,
      note: '请补充',
    });
    expect(retryChanged).toEqual(second);

    const readRejected = await service.getById(rejected.id);
    expect(readRejected?.status).toBe('rejected');
    expect(readRejected?.decision?.type).toBe('rejected');
    const readChanged = await service.getById(changed.id);
    expect(readChanged?.status).toBe('needs_changes');
    expect(readChanged?.decision?.type).toBe('needs_changes');
  });
});
