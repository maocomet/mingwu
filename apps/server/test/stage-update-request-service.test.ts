import { describe, expect, it } from 'vitest';
import {
  AI_ACTOR_CODE_MAX_LENGTH,
  countCodePoints,
  PROJECT_STAGE_STATUSES,
  STAGE_UPDATE_REASON_MAX_LENGTH,
  type AuthenticatedAiActorContext,
  type ProjectStage,
  type ProjectStageStatus,
  type StageUpdateRequest,
} from '@mingwu/contracts';
import { StageUpdateRequestService } from '../src/application/stage-update-request/stage-update-request-service.js';
import { StageNotFoundError, StageVersionConflictError } from '../src/domain/stage/errors.js';
import {
  StageUpdateRequestExpectedVersionInvalidError,
  StageUpdateRequestIdempotencyConflictError,
  StageUpdateRequestIdInvalidError,
  StageUpdateRequestProposedStatusInvalidError,
  StageUpdateRequestReasonInvalidError,
  StageUpdateRequesterInvalidError,
} from '../src/domain/stage-update-request/errors.js';
import { makeServices, uuid } from './helpers.js';

type Services = ReturnType<typeof makeServices>;

const FIXED_NOW = '2026-08-10T12:00:00.000Z';

/** 受信上下文：只含服务端认证层能解析出的字段，不含任何连接/权限敏感信息。 */
function authContextFor(
  actorId: string,
  actorCode = 'test-actor',
  actorType: AuthenticatedAiActorContext['actorType'] = 'resident_ai',
): AuthenticatedAiActorContext {
  return Object.freeze({ actorId, actorCode, actorType });
}

/** 共享仓储：创建项目与一个初始关卡（status=not_started, version=1）。 */
async function seedStage(services: Services): Promise<{ projectId: string; stage: ProjectStage }> {
  const projectId = uuid();
  await services.projectService.createProject({ id: projectId, name: '申请测试项目' });
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

function inputFor(
  stageId: string,
  overrides: Partial<{
    id: string;
    expectedStageVersion: number;
    proposedStatus: ProjectStageStatus;
    reason: string;
  }> = {},
) {
  return {
    id: overrides.id ?? uuid(),
    stageId,
    expectedStageVersion: overrides.expectedStageVersion ?? 1,
    proposedStatus: overrides.proposedStatus ?? 'in_progress',
    reason: overrides.reason ?? '进入下一阶段',
  };
}

/** 读取关卡当前 status 与 version，断言在申请前后完全不变。 */
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

describe('StageUpdateRequestService.submit', () => {
  it('creates a pending request attributed to the bound actor with server-derived projectId and clock', async () => {
    const services = makeServices();
    const { projectId, stage } = await seedStage(services);
    const service = makeService(services);
    const actor = authContextFor(uuid(), 'xiaoke');

    const before = await readStageSnapshot(services, stage.id);
    const request = await service.submit(actor, inputFor(stage.id));
    const after = await readStageSnapshot(services, stage.id);

    expect(request.status).toBe('pending');
    expect(request.projectId).toBe(projectId);
    expect(request.stageId).toBe(stage.id);
    expect(request.requesterActorId).toBe(actor.actorId);
    expect(request.expectedStageVersion).toBe(1);
    expect(request.proposedStatus).toBe('in_progress');
    expect(request.createdAt).toBe(FIXED_NOW);
    // 申请绝不修改正式主进度。
    expect(after).toEqual(before);
  });

  it('trims surrounding whitespace from reason before storing', async () => {
    const services = makeServices();
    const { stage } = await seedStage(services);
    const service = makeService(services);
    const request = await service.submit(
      authContextFor(uuid()),
      inputFor(stage.id, { reason: '  进入下一阶段  ' }),
    );
    expect(request.reason).toBe('进入下一阶段');
  });

  it('rejects a stage that does not exist with zero writes', async () => {
    const services = makeServices();
    const { stage } = await seedStage(services);
    const service = makeService(services);
    const missingId = uuid();

    await expect(service.submit(authContextFor(uuid()), inputFor(missingId))).rejects.toBeInstanceOf(
      StageNotFoundError,
    );
    expect(await service.listByStage(missingId)).toEqual([]);
    // 已有关卡不受影响。
    const after = await readStageSnapshot(services, stage.id);
    expect(after.status).toBe('not_started');
  });

  it('rejects a stale expectedStageVersion as a stable conflict without creating a request', async () => {
    const services = makeServices();
    const { stage } = await seedStage(services);
    const service = makeService(services);
    const actor = authContextFor(uuid());
    const input = inputFor(stage.id, { expectedStageVersion: 99 });

    await expect(service.submit(actor, input)).rejects.toBeInstanceOf(StageVersionConflictError);
    expect(await service.listByStage(stage.id)).toEqual([]);
    const after = await readStageSnapshot(services, stage.id);
    expect(after.status).toBe('not_started');
    expect(after.version).toBe(1);
    expect(after.startedAt).toBeNull();
    expect(after.completedAt).toBeNull();
  });

  it('rejects invalid proposedStatus, blank/too-long reason, non-positive version and non-uuid id', async () => {
    const services = makeServices();
    const { stage } = await seedStage(services);
    const service = makeService(services);
    const actor = authContextFor(uuid());

    await expect(
      service.submit(actor, inputFor(stage.id, { proposedStatus: 'not_a_status' as ProjectStageStatus })),
    ).rejects.toBeInstanceOf(StageUpdateRequestProposedStatusInvalidError);
    await expect(
      service.submit(actor, inputFor(stage.id, { proposedStatus: '' as ProjectStageStatus })),
    ).rejects.toBeInstanceOf(StageUpdateRequestProposedStatusInvalidError);

    await expect(
      service.submit(actor, inputFor(stage.id, { reason: '   ' })),
    ).rejects.toBeInstanceOf(StageUpdateRequestReasonInvalidError);
    await expect(
      service.submit(actor, inputFor(stage.id, { reason: '' })),
    ).rejects.toBeInstanceOf(StageUpdateRequestReasonInvalidError);
    await expect(
      service.submit(actor, inputFor(stage.id, { reason: '中'.repeat(STAGE_UPDATE_REASON_MAX_LENGTH + 1) })),
    ).rejects.toBeInstanceOf(StageUpdateRequestReasonInvalidError);

    await expect(
      service.submit(actor, inputFor(stage.id, { expectedStageVersion: 0 })),
    ).rejects.toBeInstanceOf(StageUpdateRequestExpectedVersionInvalidError);
    await expect(
      service.submit(actor, inputFor(stage.id, { expectedStageVersion: 1.5 })),
    ).rejects.toBeInstanceOf(StageUpdateRequestExpectedVersionInvalidError);

    await expect(
      service.submit(actor, { ...inputFor(stage.id), id: 'not-a-uuid' }),
    ).rejects.toBeInstanceOf(StageUpdateRequestIdInvalidError);

    expect(await service.listByStage(stage.id)).toEqual([]);
    const after = await readStageSnapshot(services, stage.id);
    expect(after.status).toBe('not_started');
    expect(after.version).toBe(1);
  });

  it('accepts exactly MAX reason in astral emoji and rejects MAX+1, matching the entry contract', async () => {
    const services = makeServices();
    const { stage } = await seedStage(services);
    const service = makeService(services);

    const exact = await service.submit(
      authContextFor(uuid()),
      inputFor(stage.id, { reason: '😀'.repeat(STAGE_UPDATE_REASON_MAX_LENGTH) }),
    );
    expect(countCodePoints(exact.reason)).toBe(STAGE_UPDATE_REASON_MAX_LENGTH);

    await expect(
      service.submit(
        authContextFor(uuid()),
        inputFor(stage.id, { reason: '😀'.repeat(STAGE_UPDATE_REASON_MAX_LENGTH + 1) }),
      ),
    ).rejects.toBeInstanceOf(StageUpdateRequestReasonInvalidError);

    expect(await service.listByStage(stage.id)).toHaveLength(1);
  });

  it('rejects an invalid bound identity context without writing any request', async () => {
    const services = makeServices();
    const { stage } = await seedStage(services);
    const service = makeService(services);

    const badActorId = authContextFor('not-a-uuid');
    const badActorCode = authContextFor(uuid(), '');
    const tooLongCode = authContextFor(uuid(), 'a'.repeat(AI_ACTOR_CODE_MAX_LENGTH + 1));
    const badActorType = authContextFor(uuid(), 'test-actor', 'user' as never);

    for (const ctx of [badActorId, badActorCode, tooLongCode, badActorType]) {
      await expect(service.submit(ctx, inputFor(stage.id))).rejects.toBeInstanceOf(
        StageUpdateRequesterInvalidError,
      );
    }
    expect(await service.listByStage(stage.id)).toEqual([]);
  });

  it('idempotent same-id retry returns the same request; any differing semantic conflicts without overwriting', async () => {
    const services = makeServices();
    const { stage, projectId } = await seedStage(services);
    const service = makeService(services);
    const actor = authContextFor(uuid(), 'xiaoke');
    const requestId = uuid();

    const first = await service.submit(actor, inputFor(stage.id, { id: requestId, reason: '进入下一阶段' }));
    const retry = await service.submit(
      actor,
      inputFor(stage.id, { id: requestId, reason: '  进入下一阶段  ' }),
    );
    // 同 id + 同 Stage + 同 Actor + 同版本 + 同状态 + 同规范化理由 → 幂等命中。
    expect(retry).toEqual(first);
    expect(await service.listByStage(stage.id)).toHaveLength(1);

    // 同 id 任一语义不同 → 稳定 IdempotencyConflictError（预检先于 Stage 版本校验，
    // 不会被陈旧版本等外部状态掩盖）。
    const conflictingInputs: Array<{
      reason?: string;
      proposedStatus?: ProjectStageStatus;
      expectedStageVersion?: number;
    }> = [
      { reason: '不同理由' },
      { proposedStatus: 'completed' },
      { expectedStageVersion: 99 }, // 版本不同：幂等语义冲突优先，不再先触发版本校验
    ];
    for (const o of conflictingInputs) {
      await expect(
        service.submit(actor, inputFor(stage.id, { id: requestId, ...o })),
      ).rejects.toBeInstanceOf(StageUpdateRequestIdempotencyConflictError);
    }
    // 同 id 但 Stage 不同 → 幂等语义冲突（不读取其他 Stage 的存在性）。
    const { stage: otherStage } = await seedStage(services);
    await expect(
      service.submit(actor, inputFor(otherStage.id, { id: requestId, reason: '进入下一阶段' })),
    ).rejects.toBeInstanceOf(StageUpdateRequestIdempotencyConflictError);

    // 同 id 但 Actor 不同 → 幂等语义冲突。
    await expect(
      service.submit(
        authContextFor(uuid(), 'xiaomiao'),
        inputFor(stage.id, { id: requestId, reason: '进入下一阶段' }),
      ),
    ).rejects.toBeInstanceOf(StageUpdateRequestIdempotencyConflictError);

    // 原申请从未被覆盖。
    const all = await service.listByStage(stage.id);
    expect(all).toHaveLength(1);
    expect(all[0]).toEqual(first);
    expect(all[0]!.createdAt).toBe(FIXED_NOW);
    expect(projectId).toBe(stage.projectId);
  });

  it('returns the original request on an identical retry after the stage advances to v2 (no version conflict)', async () => {
    const services = makeServices();
    const { stage, projectId } = await seedStage(services);
    const service = makeService(services);
    const actor = authContextFor(uuid(), 'xiaoke');
    const requestId = uuid();

    // 首次基于 v1 成功。
    const first = await service.submit(
      actor,
      inputFor(stage.id, { id: requestId, reason: '进入下一阶段' }),
    );
    expect(first.expectedStageVersion).toBe(1);

    // 正式关卡正常推进到 v2。
    await services.stageService.setStageStatus(stage.id, {
      status: 'in_progress',
      expectedVersion: 1,
    });
    const advanced = await services.stageRepository.findById(stage.id);
    expect(advanced?.version).toBe(2);

    // 完全相同请求（仍带 expectedStageVersion=1）重试：幂等返回原申请，不因当前
    // Stage 已是 v2 而报版本冲突；仍只有一条申请。
    const retry = await service.submit(
      actor,
      inputFor(stage.id, { id: requestId, reason: '进入下一阶段' }),
    );
    expect(retry).toEqual(first);
    expect(retry.projectId).toBe(projectId);
    expect(await service.listByStage(stage.id)).toHaveLength(1);
    expect(await service.getById(requestId)).toEqual(first);
  });

  it('after the stage advances, same id with any differing semantic returns a stable idempotency conflict, not masked by the stage state', async () => {
    const services = makeServices();
    const { stage } = await seedStage(services);
    const service = makeService(services);
    const actor = authContextFor(uuid(), 'xiaoke');
    const requestId = uuid();

    await service.submit(
      actor,
      inputFor(stage.id, { id: requestId, reason: '进入下一阶段' }),
    );

    // 关卡推进到 v2：当前版本不再是申请所依据的 v1。
    await services.stageService.setStageStatus(stage.id, {
      status: 'in_progress',
      expectedVersion: 1,
    });
    expect((await services.stageRepository.findById(stage.id))?.version).toBe(2);

    // 同 id 各字段不同 → 全部稳定 IdempotencyConflictError，不被 Stage 已到 v2 掩盖。
    const otherStage = (await seedStage(services)).stage;
    const conflictingAttempts = [
      () => service.submit(actor, inputFor(stage.id, { id: requestId, reason: '不同理由' })),
      () => service.submit(actor, inputFor(stage.id, { id: requestId, proposedStatus: 'completed' })),
      () => service.submit(actor, inputFor(stage.id, { id: requestId, expectedStageVersion: 2 })),
      () => service.submit(actor, inputFor(otherStage.id, { id: requestId, reason: '进入下一阶段' })),
      () =>
        service.submit(
          authContextFor(uuid(), 'xiaomiao'),
          inputFor(stage.id, { id: requestId }),
        ),
    ];
    for (const attempt of conflictingAttempts) {
      await expect(attempt()).rejects.toBeInstanceOf(StageUpdateRequestIdempotencyConflictError);
    }

    // 原申请从未被覆盖，仍只有一条；正式 Stage 保持 v2。
    const all = await service.listByStage(stage.id);
    expect(all).toHaveLength(1);
    expect(all[0]!.expectedStageVersion).toBe(1);
    expect((await services.stageRepository.findById(stage.id))?.version).toBe(2);
  });

  it('20 concurrent same-id identical-semantics submissions all succeed idempotently with exactly one record', async () => {
    const services = makeServices();
    const { stage } = await seedStage(services);
    const service = makeService(services);
    const actor = authContextFor(uuid());
    const requestId = uuid();

    const results = await Promise.all(
      Array.from({ length: 20 }, () =>
        service.submit(
          actor,
          inputFor(stage.id, { id: requestId, reason: '进入下一阶段' }),
        ),
      ),
    );
    // 完全同语义并发：全部幂等成功并返回同一个申请，只有一条真正落账。
    const requests = await service.listByStage(stage.id);
    expect(requests).toHaveLength(1);
    expect(requests[0]!.id).toBe(requestId);
    for (const r of results) {
      expect(r).toEqual(requests[0]);
    }
  });

  it('20 concurrent same-id different-semantics submissions: exactly one success, rest are controlled idempotency conflicts', async () => {
    const services = makeServices();
    const { stage } = await seedStage(services);
    const service = makeService(services);
    const actor = authContextFor(uuid());
    const requestId = uuid();

    const results = await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        service
          .submit(
            actor,
            inputFor(stage.id, { id: requestId, reason: `理由 ${i}` }),
          )
          .catch((err: unknown) => err),
      ),
    );
    // 不同理由的同 id 并发：恰好一条成功，其余全部为明确的幂等语义冲突，
    // 而非任意 Error；绝不产生两条不同申请。
    const requests = await service.listByStage(stage.id);
    expect(requests).toHaveLength(1);
    const successful = results.filter((r) => !(r instanceof Error));
    const conflicts = results.filter(
      (r) => r instanceof StageUpdateRequestIdempotencyConflictError,
    );
    expect(successful.length).toBe(1);
    expect(conflicts.length).toBe(19);
    expect(successful[0]).toEqual(requests[0]);
  });

  it('lists requests per stage only', async () => {
    const services = makeServices();
    const { stage: stageA } = await seedStage(services);
    const { stage: stageB } = await seedStage(services);
    const service = makeService(services);

    await service.submit(authContextFor(uuid(), 'xiaoke'), inputFor(stageA.id));
    await service.submit(authContextFor(uuid(), 'xiaomiao'), inputFor(stageB.id));

    expect(await service.listByStage(stageA.id)).toHaveLength(1);
    expect(await service.listByStage(stageB.id)).toHaveLength(1);
    const request = await service.getById((await service.listByStage(stageA.id))[0]!.id);
    expect(request?.status).toBe('pending');
    expect(await service.getById(uuid())).toBeNull();
  });
});
