import { Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import type { AuthenticatedAiActorContext, StageUpdateRequest } from '@mingwu/contracts';
import type { AppDeps } from '../src/app.js';
import { buildApp } from '../src/app.js';
import type { StageUpdateRequestService } from '../src/application/stage-update-request/stage-update-request-service.js';
import { loadConfig } from '../src/config.js';
import { makeServices, uuid } from './helpers.js';

type App = ReturnType<typeof buildApp>;
type Services = ReturnType<typeof makeServices>;

function setup(
  overrides: { stageUpdateRequestService?: StageUpdateRequestService; logger?: AppDeps['logger'] } = {},
): { app: App; services: Services } {
  const config = loadConfig({ NODE_ENV: 'test' });
  const services = makeServices();
  const app = buildApp({
    config,
    projectService: services.projectService,
    stageService: services.stageService,
    taskService: services.taskService,
    projectStatusService: services.projectStatusService,
    studySessionService: services.studySessionService,
    studySessionDetailService: services.studySessionDetailService,
    studySessionCurrentService: services.studySessionCurrentService,
    studySummaryService: services.studySummaryService,
    studyReportService: services.studyReportService,
    stageUpdateRequestService:
      overrides.stageUpdateRequestService ?? services.stageUpdateRequestService,
    projectWorkReportService: services.projectWorkReportService,
    ...(overrides.logger ? { logger: overrides.logger } : {}),
  });
  return { app, services };
}

/** 用 pino 同步 stream 捕获 Fastify 日志，用于断言未知异常日志脱敏。 */
function createLogCapture() {
  const chunks: Buffer[] = [];
  const stream = new Writable({
    write(chunk: Buffer, _enc: BufferEncoding, callback: (error?: Error | null) => void) {
      chunks.push(Buffer.from(chunk));
      callback();
    },
  });
  const logger: AppDeps['logger'] = { level: 'info', stream };
  const text = () => Buffer.concat(chunks).toString('utf8');
  return { logger, text };
}

/** 假服务：requestChanges 抛含秘密的未知异常，用于断言响应与日志都脱敏。 */
function throwingRequestChangesService(secret: string): StageUpdateRequestService {
  return {
    async requestChanges() {
      throw new Error(`db connection failed: ${secret}`);
    },
    async submit() {
      throw new Error('not used');
    },
    async getById() {
      return null;
    },
    async listByStage() {
      return [];
    },
  } as unknown as StageUpdateRequestService;
}

/** 假服务：reject 抛含秘密的未知异常，用于断言响应与日志都脱敏。 */
function throwingRejectService(secret: string): StageUpdateRequestService {
  return {
    async reject() {
      throw new Error(`db connection failed: ${secret}`);
    },
    async submit() {
      throw new Error('not used');
    },
    async getById() {
      return null;
    },
    async listByStage() {
      return [];
    },
  } as unknown as StageUpdateRequestService;
}

/** 受信上下文：只含服务端认证层能解析出的字段。 */
function authContextFor(actorId: string): AuthenticatedAiActorContext {
  return Object.freeze({ actorId, actorCode: 'test-actor', actorType: 'resident_ai' });
}

/** 通过 App HTTP API 建项目/关卡，再经共享服务提交一条 pending 申请。 */
async function createPendingRequest(
  app: App,
  services: Services,
): Promise<{ projectId: string; stage: { id: string; version: number }; request: StageUpdateRequest }> {
  const projectRes = await app.inject({
    method: 'POST',
    url: '/api/v1/projects',
    payload: { id: uuid(), name: '要求补充 API 项目' },
  });
  expect(projectRes.statusCode).toBe(201);
  const projectId = projectRes.json().id as string;

  const stageRes = await app.inject({
    method: 'POST',
    url: `/api/v1/projects/${projectId}/stages`,
    payload: { id: uuid(), name: '第一关', position: 1 },
  });
  expect(stageRes.statusCode).toBe(201);
  const stage = stageRes.json() as { id: string; version: number };

  const request = await services.stageUpdateRequestService.submit(authContextFor(uuid()), {
    id: uuid(),
    stageId: stage.id,
    expectedStageVersion: stage.version,
    proposedStatus: 'in_progress',
    reason: '完成第一关，申请进入下一阶段',
  });
  return { projectId, stage, request };
}

describe('POST /api/v1/stage-update-requests/:id/request-changes', () => {
  it('marks a pending request needs_changes: 200 with trimmed note, revision 2, original fields and Stage unchanged', async () => {
    const { app, services } = setup();
    const { projectId, stage, request } = await createPendingRequest(app, services);

    const before = await services.stageRepository.findById(stage.id);
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/stage-update-requests/${request.id}/request-changes`,
      payload: { expectedRevision: 1, note: '  请补充技术细节  ' },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as StageUpdateRequest;
    expect(body.status).toBe('needs_changes');
    expect(body.revision).toBe(2);
    expect(body.decision).toEqual({
      type: 'needs_changes',
      note: '请补充技术细节',
      decidedAt: expect.any(String),
    });
    // 原申请核心字段逐项不变。
    expect(body.projectId).toBe(projectId);
    expect(body.stageId).toBe(stage.id);
    expect(body.requesterActorId).toBe(request.requesterActorId);
    expect(body.expectedStageVersion).toBe(1);
    expect(body.proposedStatus).toBe('in_progress');
    expect(body.reason).toBe(request.reason);
    expect(body.createdAt).toBe(request.createdAt);
    // 响应严格白名单：除声明字段外不得有多余键。
    expect(Object.keys(body).sort()).toEqual([
      'createdAt',
      'decision',
      'expectedStageVersion',
      'id',
      'projectId',
      'proposedStatus',
      'reason',
      'requesterActorId',
      'revision',
      'stageId',
      'status',
      'updatedAt',
    ]);
    // 正式 Stage 完全不变。
    const after = await services.stageRepository.findById(stage.id);
    expect(after && { status: after.status, version: after.version }).toEqual(
      before && { status: before.status, version: before.version },
    );
  });

  it('identical retry returns the same decided request without advancing revision', async () => {
    const { app, services } = setup();
    const { stage, request } = await createPendingRequest(app, services);

    const first = await app.inject({
      method: 'POST',
      url: `/api/v1/stage-update-requests/${request.id}/request-changes`,
      payload: { expectedRevision: 1, note: '请补充细节' },
    });
    expect(first.statusCode).toBe(200);
    const retry = await app.inject({
      method: 'POST',
      url: `/api/v1/stage-update-requests/${request.id}/request-changes`,
      payload: { expectedRevision: 1, note: '  请补充细节  ' },
    });
    expect(retry.statusCode).toBe(200);
    expect(retry.json()).toEqual(first.json());
    expect(retry.json().revision).toBe(2);
    expect(await services.stageUpdateRequestService.listByStage(stage.id)).toHaveLength(1);
  });

  it('returns 404 for an unknown request id', async () => {
    const { app } = setup();
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/stage-update-requests/${uuid()}/request-changes`,
      payload: { expectedRevision: 1, note: '说明' },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe('stage_update_request_not_found');
  });

  it('returns 409 decision conflict for wrong expectedRevision while pending and for a different note after decision', async () => {
    const { app, services } = setup();
    const { request } = await createPendingRequest(app, services);

    // 仍 pending 但 expectedRevision 与当前 revision 不一致。
    const stale = await app.inject({
      method: 'POST',
      url: `/api/v1/stage-update-requests/${request.id}/request-changes`,
      payload: { expectedRevision: 2, note: '说明' },
    });
    expect(stale.statusCode).toBe(409);
    expect(stale.json().error).toBe('stage_update_request_decision_conflict');

    // 已决定后不同 note → 受控冲突，绝不覆盖第一次决定。
    const first = await app.inject({
      method: 'POST',
      url: `/api/v1/stage-update-requests/${request.id}/request-changes`,
      payload: { expectedRevision: 1, note: '第一次说明' },
    });
    expect(first.statusCode).toBe(200);
    const other = await app.inject({
      method: 'POST',
      url: `/api/v1/stage-update-requests/${request.id}/request-changes`,
      payload: { expectedRevision: 1, note: '不同说明' },
    });
    expect(other.statusCode).toBe(409);
    expect(other.json().error).toBe('stage_update_request_decision_conflict');
  });

  it('rejects protected or extra body fields with 400 validation_failed', async () => {
    const { app, services } = setup();
    const { request } = await createPendingRequest(app, services);
    const url = `/api/v1/stage-update-requests/${request.id}/request-changes`;

    const protectedFields: Array<Record<string, unknown>> = [
      { expectedRevision: 1, note: '说明', status: 'approved' },
      { expectedRevision: 1, note: '说明', decision: { type: 'needs_changes', note: '伪造', decidedAt: 't' } },
      { expectedRevision: 1, note: '说明', decidedAt: '2026-01-01T00:00:00.000Z' },
      { expectedRevision: 1, note: '说明', updatedAt: '2026-01-01T00:00:00.000Z' },
      { expectedRevision: 1, note: '说明', revision: 99 },
      { expectedRevision: 1, note: '说明', actorId: uuid() },
      { expectedRevision: 1, note: '说明', requesterActorId: uuid() },
      { expectedRevision: 1, note: '说明', stageId: uuid() },
      { expectedRevision: 1, note: '说明', proposedStatus: 'completed' },
    ];
    for (const payload of protectedFields) {
      const res = await app.inject({ method: 'POST', url, payload });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe('validation_failed');
    }

    // 缺失必填 / expectedRevision 非法 / note 空白（schema 层）。
    const invalidPayloads: Array<Record<string, unknown>> = [
      { note: '说明' },
      { expectedRevision: 1 },
      { expectedRevision: 0, note: '说明' },
      { expectedRevision: 1.5, note: '说明' },
      { expectedRevision: '1', note: '说明' },
      { expectedRevision: 1, note: '' },
    ];
    for (const payload of invalidPayloads) {
      const res = await app.inject({ method: 'POST', url, payload });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe('validation_failed');
    }

    // 空白 note 通过 schema 但被服务层拒绝（trim 后为空）→ 受控 400。
    const blank = await app.inject({
      method: 'POST',
      url,
      payload: { expectedRevision: 1, note: '   ' },
    });
    expect(blank.statusCode).toBe(400);
    expect(blank.json().error).toBe('stage_update_request_note_invalid');
  });

  it('rejects a non-UUID params id with 400 validation_failed', async () => {
    const { app } = setup();
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/stage-update-requests/not-a-uuid/request-changes',
      payload: { expectedRevision: 1, note: '说明' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('validation_failed');
  });

  it('rejects over-limit note at the schema layer (400 validation_failed) without echoing the note', async () => {
    const { app, services } = setup();
    const { request } = await createPendingRequest(app, services);
    const tooLong = '中'.repeat(2001);
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/stage-update-requests/${request.id}/request-changes`,
      payload: { expectedRevision: 1, note: tooLong },
    });
    // JSON Schema maxLength 与契约常量一致，API 层先行拒绝；服务层 note_invalid
    // 作为绕过 schema 直接调用时的自守兜底。
    expect(res.statusCode).toBe(400);
    const body = res.json();
    expect(body.error).toBe('validation_failed');
    // 错误消息不回显 note / 申请内容 / 身份。
    expect(JSON.stringify(body)).not.toContain('中');
  });

  it('desensitizes an unknown exception: controlled 500, secrets never reach the response or the log', async () => {
    const { logger, text } = createLogCapture();
    const SECRET = 'postgres://app:password=TEST_SECRET@db.internal:5432/mingwu?ssl=true';
    const { app } = setup({
      stageUpdateRequestService: throwingRequestChangesService(SECRET),
      logger,
    });

    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/stage-update-requests/${uuid()}/request-changes`,
      payload: { expectedRevision: 1, note: '说明' },
    });
    // 未知异常只返回受控 500，不把堆栈 / 原始 message 反弹给调用方。
    expect(res.statusCode).toBe(500);
    expect(res.json().error).toBe('internal_error');
    expect(res.body).not.toContain(SECRET);
    expect(res.body).not.toContain('TEST_SECRET');
    expect(res.body).not.toContain('postgres://');
    expect(res.body).not.toContain('db connection failed');
    // 捕获日志只记录稳定分类（errType），绝不含密码 / 连接串 / 原始异常 message。
    const logText = text();
    expect(logText).not.toContain(SECRET);
    expect(logText).not.toContain('TEST_SECRET');
    expect(logText).not.toContain('postgres://');
    expect(logText).not.toContain('db connection failed');
    expect(logText).toContain('unhandled error');
  });
});

describe('POST /api/v1/stage-update-requests/:id/reject', () => {
  it('marks a pending request rejected: 200 with trimmed note, revision 2, original fields and Stage unchanged', async () => {
    const { app, services } = setup();
    const { projectId, stage, request } = await createPendingRequest(app, services);

    const before = await services.stageRepository.findById(stage.id);
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/stage-update-requests/${request.id}/reject`,
      payload: { expectedRevision: 1, note: '  不符合验收标准，予以拒绝  ' },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as StageUpdateRequest;
    expect(body.status).toBe('rejected');
    expect(body.revision).toBe(2);
    expect(body.decision).toEqual({
      type: 'rejected',
      note: '不符合验收标准，予以拒绝',
      decidedAt: expect.any(String),
    });
    // 原申请核心字段逐项不变。
    expect(body.projectId).toBe(projectId);
    expect(body.stageId).toBe(stage.id);
    expect(body.requesterActorId).toBe(request.requesterActorId);
    expect(body.expectedStageVersion).toBe(1);
    expect(body.proposedStatus).toBe('in_progress');
    expect(body.reason).toBe(request.reason);
    expect(body.createdAt).toBe(request.createdAt);
    // 响应严格白名单：除声明字段外不得有多余键。
    expect(Object.keys(body).sort()).toEqual([
      'createdAt',
      'decision',
      'expectedStageVersion',
      'id',
      'projectId',
      'proposedStatus',
      'reason',
      'requesterActorId',
      'revision',
      'stageId',
      'status',
      'updatedAt',
    ]);
    // 正式 Stage 完全不变。
    const after = await services.stageRepository.findById(stage.id);
    expect(after && { status: after.status, version: after.version }).toEqual(
      before && { status: before.status, version: before.version },
    );
  });

  it('identical retry returns the same rejected request without advancing revision', async () => {
    const { app, services } = setup();
    const { stage, request } = await createPendingRequest(app, services);

    const first = await app.inject({
      method: 'POST',
      url: `/api/v1/stage-update-requests/${request.id}/reject`,
      payload: { expectedRevision: 1, note: '不符合要求' },
    });
    expect(first.statusCode).toBe(200);
    const retry = await app.inject({
      method: 'POST',
      url: `/api/v1/stage-update-requests/${request.id}/reject`,
      payload: { expectedRevision: 1, note: '  不符合要求  ' },
    });
    expect(retry.statusCode).toBe(200);
    expect(retry.json()).toEqual(first.json());
    expect(retry.json().revision).toBe(2);
    expect(await services.stageUpdateRequestService.listByStage(stage.id)).toHaveLength(1);
  });

  it('returns 404 for an unknown request id', async () => {
    const { app } = setup();
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/stage-update-requests/${uuid()}/reject`,
      payload: { expectedRevision: 1, note: '说明' },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe('stage_update_request_not_found');
  });

  it('returns 409 decision conflict for wrong expectedRevision while pending and for a different note after rejection', async () => {
    const { app, services } = setup();
    const { request } = await createPendingRequest(app, services);

    // 仍 pending 但 expectedRevision 与当前 revision 不一致。
    const stale = await app.inject({
      method: 'POST',
      url: `/api/v1/stage-update-requests/${request.id}/reject`,
      payload: { expectedRevision: 2, note: '说明' },
    });
    expect(stale.statusCode).toBe(409);
    expect(stale.json().error).toBe('stage_update_request_decision_conflict');

    // 已决定后不同 note → 受控冲突，绝不覆盖第一次决定。
    const first = await app.inject({
      method: 'POST',
      url: `/api/v1/stage-update-requests/${request.id}/reject`,
      payload: { expectedRevision: 1, note: '第一次说明' },
    });
    expect(first.statusCode).toBe(200);
    const other = await app.inject({
      method: 'POST',
      url: `/api/v1/stage-update-requests/${request.id}/reject`,
      payload: { expectedRevision: 1, note: '不同说明' },
    });
    expect(other.statusCode).toBe(409);
    expect(other.json().error).toBe('stage_update_request_decision_conflict');
  });

  it('a rejected request cannot be re-decided as request-changes (409), and vice versa', async () => {
    const { app, services } = setup();
    const { request } = await createPendingRequest(app, services);

    // 先拒绝：之后 request-changes 必须 409，绝不覆盖拒绝决定。
    const rejectRes = await app.inject({
      method: 'POST',
      url: `/api/v1/stage-update-requests/${request.id}/reject`,
      payload: { expectedRevision: 1, note: '不符合要求' },
    });
    expect(rejectRes.statusCode).toBe(200);
    const crossReq = await app.inject({
      method: 'POST',
      url: `/api/v1/stage-update-requests/${request.id}/request-changes`,
      payload: { expectedRevision: 1, note: '请补充' },
    });
    expect(crossReq.statusCode).toBe(409);
    expect(crossReq.json().error).toBe('stage_update_request_decision_conflict');

    // 对称：先 needs_changes，之后 reject 也必须 409。
    const { request: second } = await createPendingRequest(app, services);
    const changesRes = await app.inject({
      method: 'POST',
      url: `/api/v1/stage-update-requests/${second.id}/request-changes`,
      payload: { expectedRevision: 1, note: '请补充' },
    });
    expect(changesRes.statusCode).toBe(200);
    const crossReject = await app.inject({
      method: 'POST',
      url: `/api/v1/stage-update-requests/${second.id}/reject`,
      payload: { expectedRevision: 1, note: '不符合要求' },
    });
    expect(crossReject.statusCode).toBe(409);
    expect(crossReject.json().error).toBe('stage_update_request_decision_conflict');

    // 两侧首决定都未被覆盖。
    const readFirst = await services.stageUpdateRequestService.getById(request.id);
    expect(readFirst?.status).toBe('rejected');
    expect(readFirst?.decision?.type).toBe('rejected');
    const readSecond = await services.stageUpdateRequestService.getById(second.id);
    expect(readSecond?.status).toBe('needs_changes');
    expect(readSecond?.decision?.type).toBe('needs_changes');
  });

  it('rejects protected or extra body fields with 400 validation_failed', async () => {
    const { app, services } = setup();
    const { request } = await createPendingRequest(app, services);
    const url = `/api/v1/stage-update-requests/${request.id}/reject`;

    const protectedFields: Array<Record<string, unknown>> = [
      { expectedRevision: 1, note: '说明', status: 'approved' },
      { expectedRevision: 1, note: '说明', decision: { type: 'rejected', note: '伪造', decidedAt: 't' } },
      { expectedRevision: 1, note: '说明', decidedAt: '2026-01-01T00:00:00.000Z' },
      { expectedRevision: 1, note: '说明', updatedAt: '2026-01-01T00:00:00.000Z' },
      { expectedRevision: 1, note: '说明', revision: 99 },
      { expectedRevision: 1, note: '说明', actorId: uuid() },
      { expectedRevision: 1, note: '说明', requesterActorId: uuid() },
      { expectedRevision: 1, note: '说明', stageId: uuid() },
      { expectedRevision: 1, note: '说明', proposedStatus: 'completed' },
      { expectedRevision: 1, note: '说明', type: 'needs_changes' },
    ];
    for (const payload of protectedFields) {
      const res = await app.inject({ method: 'POST', url, payload });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe('validation_failed');
    }

    // 缺失必填 / expectedRevision 非法 / note 空白（schema 层）。
    const invalidPayloads: Array<Record<string, unknown>> = [
      { note: '说明' },
      { expectedRevision: 1 },
      { expectedRevision: 0, note: '说明' },
      { expectedRevision: 1.5, note: '说明' },
      { expectedRevision: '1', note: '说明' },
      { expectedRevision: 1, note: '' },
    ];
    for (const payload of invalidPayloads) {
      const res = await app.inject({ method: 'POST', url, payload });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe('validation_failed');
    }

    // 空白 note 通过 schema 但被服务层拒绝（trim 后为空）→ 受控 400。
    const blank = await app.inject({
      method: 'POST',
      url,
      payload: { expectedRevision: 1, note: '   ' },
    });
    expect(blank.statusCode).toBe(400);
    expect(blank.json().error).toBe('stage_update_request_note_invalid');
  });

  it('rejects a non-UUID params id with 400 validation_failed', async () => {
    const { app } = setup();
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/stage-update-requests/not-a-uuid/reject',
      payload: { expectedRevision: 1, note: '说明' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('validation_failed');
  });

  it('rejects over-limit note at the schema layer (400 validation_failed) without echoing the note', async () => {
    const { app, services } = setup();
    const { request } = await createPendingRequest(app, services);
    const tooLong = '中'.repeat(2001);
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/stage-update-requests/${request.id}/reject`,
      payload: { expectedRevision: 1, note: tooLong },
    });
    // JSON Schema maxLength 与契约常量一致，API 层先行拒绝；服务层 note_invalid
    // 作为绕过 schema 直接调用时的自守兜底。
    expect(res.statusCode).toBe(400);
    const body = res.json();
    expect(body.error).toBe('validation_failed');
    // 错误消息不回显 note / 申请内容 / 身份。
    expect(JSON.stringify(body)).not.toContain('中');
  });

  it('desensitizes an unknown exception: controlled 500, secrets never reach the response or the log', async () => {
    const { logger, text } = createLogCapture();
    const SECRET = 'postgres://app:password=TEST_SECRET@db.internal:5432/mingwu?ssl=true';
    const { app } = setup({
      stageUpdateRequestService: throwingRejectService(SECRET),
      logger,
    });

    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/stage-update-requests/${uuid()}/reject`,
      payload: { expectedRevision: 1, note: '说明' },
    });
    // 未知异常只返回受控 500，不把堆栈 / 原始 message 反弹给调用方。
    expect(res.statusCode).toBe(500);
    expect(res.json().error).toBe('internal_error');
    expect(res.body).not.toContain(SECRET);
    expect(res.body).not.toContain('TEST_SECRET');
    expect(res.body).not.toContain('postgres://');
    expect(res.body).not.toContain('db connection failed');
    // 捕获日志只记录稳定分类（errType），绝不含密码 / 连接串 / 原始异常 message。
    const logText = text();
    expect(logText).not.toContain(SECRET);
    expect(logText).not.toContain('TEST_SECRET');
    expect(logText).not.toContain('postgres://');
    expect(logText).not.toContain('db connection failed');
    expect(logText).toContain('unhandled error');
  });
});

/**
 * 真实 HTTP 冒烟：服务真实监听 127.0.0.1 临时端口，经 App HTTP API 建项目/关卡、
 * 共享服务提交申请，再以 fetch 真实 socket 调用 request-changes，读回确认申请已
 * needs_changes、正式 Stage 完全未变化，结束后释放端口并关闭服务。
 */
describe('POST request-changes real-HTTP smoke (127.0.0.1, ephemeral port)', () => {
  async function startServer(): Promise<{
    app: App;
    baseUrl: string;
    services: Services;
    close: () => Promise<void>;
  }> {
    const config = loadConfig({ NODE_ENV: 'test' });
    const services = makeServices();
    const app = buildApp({
      config,
      projectService: services.projectService,
      stageService: services.stageService,
      taskService: services.taskService,
      projectStatusService: services.projectStatusService,
      studySessionService: services.studySessionService,
      studySessionDetailService: services.studySessionDetailService,
      studySessionCurrentService: services.studySessionCurrentService,
      studySummaryService: services.studySummaryService,
      studyReportService: services.studyReportService,
      stageUpdateRequestService: services.stageUpdateRequestService,
      projectWorkReportService: services.projectWorkReportService,
    });
    await app.listen({ host: '127.0.0.1', port: 0 });
    const address = app.server.address();
    if (address === null || typeof address === 'string') {
      throw new Error('expected a TCP address object from app.server.address()');
    }
    const baseUrl = `http://127.0.0.1:${address.port}`;
    return {
      app,
      baseUrl,
      services,
      close: async () => {
        await app.close();
      },
    };
  }

  it('real socket: user requests changes over the App API and the stage is byte-identical afterwards', async () => {
    const { app, baseUrl, services, close } = await startServer();
    try {
      // 经 App HTTP API 建项目与关卡。
      const projectRes = await fetch(`${baseUrl}/api/v1/projects`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id: uuid(), name: '要求补充冒烟项目' }),
      });
      expect(projectRes.status).toBe(201);
      const project = (await projectRes.json()) as { id: string };

      const stageRes = await fetch(`${baseUrl}/api/v1/projects/${project.id}/stages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id: uuid(), name: '第一关', position: 1 }),
      });
      expect(stageRes.status).toBe(201);
      const stage = (await stageRes.json()) as { id: string; version: number; status: string };

      // 记录决定前的正式 Stage 快照。
      const before = await services.stageRepository.findById(stage.id);
      if (!before) {
        throw new Error('stage should exist');
      }
      const snapshot = {
        status: before.status,
        version: before.version,
        startedAt: before.startedAt,
        completedAt: before.completedAt,
        createdAt: before.createdAt,
        updatedAt: before.updatedAt,
      };

      // 经共享服务提交申请（申请由服务端认证身份写入）。
      const request = await services.stageUpdateRequestService.submit(authContextFor(uuid()), {
        id: uuid(),
        stageId: stage.id,
        expectedStageVersion: before.version,
        proposedStatus: 'in_progress',
        reason: '真实 HTTP 冒烟：申请进入下一阶段',
      });
      expect(request.status).toBe('pending');

      // 真实 socket：用户要求补充。
      const res = await fetch(
        `${baseUrl}/api/v1/stage-update-requests/${request.id}/request-changes`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ expectedRevision: 1, note: '请补充验收标准' }),
        },
      );
      expect(res.status).toBe(200);
      const decided = (await res.json()) as StageUpdateRequest;
      expect(decided.status).toBe('needs_changes');
      expect(decided.revision).toBe(2);
      expect(decided.decision?.note).toBe('请补充验收标准');

      // 通过共享服务读回申请，确认写入一致；正式 Stage 完全未变化。
      const read = await services.stageUpdateRequestService.getById(request.id);
      expect(read).toEqual(decided);
      const after = await services.stageRepository.findById(stage.id);
      expect(
        after && {
          status: after.status,
          version: after.version,
          startedAt: after.startedAt,
          completedAt: after.completedAt,
          createdAt: after.createdAt,
          updatedAt: after.updatedAt,
        },
      ).toEqual(snapshot);
    } finally {
      await close();
    }
  });

  it('real socket: user rejects the stage update request over the App API and the stage is byte-identical afterwards', async () => {
    const { app, baseUrl, services, close } = await startServer();
    try {
      // 经 App HTTP API 建项目与关卡。
      const projectRes = await fetch(`${baseUrl}/api/v1/projects`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id: uuid(), name: '拒绝冒烟项目' }),
      });
      expect(projectRes.status).toBe(201);
      const project = (await projectRes.json()) as { id: string };

      const stageRes = await fetch(`${baseUrl}/api/v1/projects/${project.id}/stages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id: uuid(), name: '第一关', position: 1 }),
      });
      expect(stageRes.status).toBe(201);
      const stage = (await stageRes.json()) as { id: string; version: number; status: string };

      // 记录决定前的正式 Stage 快照。
      const before = await services.stageRepository.findById(stage.id);
      if (!before) {
        throw new Error('stage should exist');
      }
      const snapshot = {
        status: before.status,
        version: before.version,
        startedAt: before.startedAt,
        completedAt: before.completedAt,
        createdAt: before.createdAt,
        updatedAt: before.updatedAt,
      };

      // 经共享服务提交申请（申请由服务端认证身份写入）。
      const request = await services.stageUpdateRequestService.submit(authContextFor(uuid()), {
        id: uuid(),
        stageId: stage.id,
        expectedStageVersion: before.version,
        proposedStatus: 'in_progress',
        reason: '真实 HTTP 冒烟：申请进入下一阶段',
      });
      expect(request.status).toBe('pending');

      // 真实 socket：用户拒绝申请。
      const res = await fetch(`${baseUrl}/api/v1/stage-update-requests/${request.id}/reject`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ expectedRevision: 1, note: '不符合验收标准' }),
      });
      expect(res.status).toBe(200);
      const rejected = (await res.json()) as StageUpdateRequest;
      expect(rejected.status).toBe('rejected');
      expect(rejected.revision).toBe(2);
      expect(rejected.decision?.note).toBe('不符合验收标准');

      // 通过共享服务读回申请，确认写入一致；正式 Stage 完全未变化。
      const read = await services.stageUpdateRequestService.getById(request.id);
      expect(read).toEqual(rejected);
      const after = await services.stageRepository.findById(stage.id);
      expect(
        after && {
          status: after.status,
          version: after.version,
          startedAt: after.startedAt,
          completedAt: after.completedAt,
          createdAt: after.createdAt,
          updatedAt: after.updatedAt,
        },
      ).toEqual(snapshot);
    } finally {
      await close();
    }
  });
});
