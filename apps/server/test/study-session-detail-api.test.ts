import { describe, expect, it } from 'vitest';
import * as net from 'node:net';
import type { StudySessionDetail } from '@mingwu/contracts';
import { buildApp } from '../src/app.js';
import { StudyReportService as StudyReportServiceImpl } from '../src/application/study-report/study-report-service.js';
import { loadConfig } from '../src/config.js';
import { makeActorContext, makeServices, uuid } from './helpers.js';

type App = ReturnType<typeof buildApp>;
type Services = ReturnType<typeof makeServices>;

function setup() {
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
  });
  return { app, services };
}

/**
 * 播种一个完整 Session：创建 → 启动 running → 两个 AI Actor 追加共三份报告 →
 * 结束为 completed → 提交用户总结。报告服务与 makeServices 共享同一组仓储，但
 * 注入固定递增时钟，保证 submittedAt / joinedAt 单调递增、聚合排序可预测。
 */
async function seedFullSession(
  services: Services,
): Promise<{ sessionId: string; actorA: string; actorB: string }> {
  const sessionId = uuid();
  const actorA = makeActorContext();
  const actorB = makeActorContext();
  const fixed = [
    '2026-08-10T08:00:00.000Z',
    '2026-08-10T08:00:01.000Z',
    '2026-08-10T08:00:02.000Z',
  ];
  let tick = 0;
  const reportService = new StudyReportServiceImpl(
    services.studyReportRepository,
    services.studyParticipantRepository,
    services.studySessionRepository,
    () => fixed[tick++]!,
  );

  await services.studySessionService.createStudySession({
    id: sessionId,
    timerMode: 'count_down',
    taskText: '背单词',
    plannedDurationSeconds: 2400,
  });
  let session = await services.studySessionService.getById(sessionId);
  session = await services.studySessionService.startStudySession(sessionId, {
    expectedVersion: session.version,
  });
  await reportService.appendReport(actorA, {
    id: uuid(),
    studySessionId: sessionId,
    content: 'A 报告 1',
  });
  await reportService.appendReport(actorB, {
    id: uuid(),
    studySessionId: sessionId,
    content: 'B 报告 1',
  });
  await reportService.appendReport(actorA, {
    id: uuid(),
    studySessionId: sessionId,
    content: 'A 报告 2',
  });
  await services.studySessionService.endStudySession(sessionId, {
    expectedVersion: session.version,
  });
  await services.studySummaryService.putBySessionId(sessionId, {
    content: '今天的单词都背完了',
    source: 'user',
    expectedRevision: 0,
  });
  return { sessionId, actorA: actorA.actorId, actorB: actorB.actorId };
}

describe('GET /api/v1/study-sessions/:id/detail', () => {
  it('returns the full four-part shape for an empty session with summary null and empty arrays', async () => {
    const { app } = setup();
    const id = uuid();
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/study-sessions',
      payload: { id, timerMode: 'count_down' },
    });
    expect(created.statusCode).toBe(201);

    const res = await app.inject({ method: 'GET', url: `/api/v1/study-sessions/${id}/detail` });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    // 响应 schema 严格：恰好四部分，无多余字段。
    expect(Object.keys(body).sort()).toEqual(['participants', 'reports', 'session', 'summary']);
    expect(body.session.id).toBe(id);
    expect(body.summary).toBeNull();
    expect(body.participants).toEqual([]);
    expect(body.reports).toEqual([]);
  });

  it('returns the detail identical to StudySessionDetailService with stable participant / report ordering', async () => {
    const { app, services } = setup();
    const { sessionId, actorA, actorB } = await seedFullSession(services);

    const res = await app.inject({ method: 'GET', url: `/api/v1/study-sessions/${sessionId}/detail` });
    expect(res.statusCode).toBe(200);
    const body = res.json() as StudySessionDetail;
    expect(Object.keys(body).sort()).toEqual(['participants', 'reports', 'session', 'summary']);

    // 与既有聚合服务逐项一致（同一份真实数据，路由内不重新拼装 / 排序）。
    const viaService = await services.studySessionDetailService.getDetail(sessionId);
    expect(body).toEqual(viaService);

    // 用户总结存在。
    expect(body.summary).not.toBeNull();
    expect(body.summary?.content).toBe('今天的单词都背完了');

    // 两个 AI 参与者，按 joinedAt ASC 稳定排序；真实 Actor 互不覆盖。
    expect(body.participants).toHaveLength(2);
    const participantActorIds = body.participants.map((p) => p.actorId);
    expect([...participantActorIds].sort()).toEqual([actorA, actorB].sort());
    const participantTimes = body.participants.map((p) => p.joinedAt);
    expect(participantTimes).toEqual([...participantTimes].sort());

    // 三份报告，按 submittedAt ASC 稳定排序；sequenceNumber 按 Actor 独立递增。
    expect(body.reports).toHaveLength(3);
    const reportTimes = body.reports.map((r) => r.submittedAt);
    expect(reportTimes).toEqual([...reportTimes].sort());
    const seqByActor = new Map<string, number[]>();
    for (const r of body.reports) {
      const seqs = seqByActor.get(r.actorId) ?? [];
      seqs.push(r.sequenceNumber);
      seqByActor.set(r.actorId, seqs);
    }
    expect(seqByActor.get(actorA)).toEqual([1, 2]);
    expect(seqByActor.get(actorB)).toEqual([1]);
  });

  it('returns controlled 404 study_session_not_found for an unknown session', async () => {
    const { app } = setup();
    const res = await app.inject({ method: 'GET', url: `/api/v1/study-sessions/${uuid()}/detail` });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe('study_session_not_found');
  });

  it('rejects a non-UUID id with a controlled 400', async () => {
    const { app } = setup();
    const res = await app.inject({ method: 'GET', url: '/api/v1/study-sessions/not-a-uuid/detail' });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('validation_failed');
  });

  it('rejects unknown query parameters, including identity fields', async () => {
    const { app } = setup();
    const id = uuid();
    await app.inject({
      method: 'POST',
      url: '/api/v1/study-sessions',
      payload: { id, timerMode: 'count_down' },
    });
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/study-sessions/${id}/detail?actorId=x`,
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('validation_failed');
  });

  it('keeps the existing core GET /study-sessions/:id shape unchanged', async () => {
    const { app, services } = setup();
    const { sessionId } = await seedFullSession(services);
    const res = await app.inject({ method: 'GET', url: `/api/v1/study-sessions/${sessionId}` });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    // 核心接口仍是 Session 本体，不含四部分聚合字段，未被详情接口改变。
    expect(body.id).toBe(sessionId);
    expect(body.status).toBe('completed');
    expect('summary' in body).toBe(false);
    expect('participants' in body).toBe(false);
    expect('reports' in body).toBe(false);
  });

  it('rejects any request body with a controlled 400, while a bodyless GET succeeds', async () => {
    const { app } = setup();
    const id = uuid();
    await app.inject({
      method: 'POST',
      url: '/api/v1/study-sessions',
      payload: { id, timerMode: 'count_down' },
    });

    // body 含身份字段 → 400，且不回显 body 内容。
    const forged = await app.inject({
      method: 'GET',
      url: `/api/v1/study-sessions/${id}/detail`,
      headers: { 'content-type': 'application/json' },
      payload: { actorId: 'forged' },
    });
    expect(forged.statusCode).toBe(400);
    expect(forged.json().error).toBe('validation_failed');
    expect(forged.body).not.toContain('forged');

    // 空对象 body {} 同样拒绝。
    const emptyObj = await app.inject({
      method: 'GET',
      url: `/api/v1/study-sessions/${id}/detail`,
      headers: { 'content-type': 'application/json' },
      payload: {},
    });
    expect(emptyObj.statusCode).toBe(400);
    expect(emptyObj.json().error).toBe('validation_failed');

    // 无 body 的 GET 正常返回 200 与完整详情。
    const noBody = await app.inject({
      method: 'GET',
      url: `/api/v1/study-sessions/${id}/detail`,
    });
    expect(noBody.statusCode).toBe(200);
    const body = noBody.json();
    expect(body.session.id).toBe(id);
    expect(body.summary).toBeNull();
  });

  it('rejects the body before calling the detail service (unknown session + body is 400, not 404)', async () => {
    const { app } = setup();
    // 未知 Session 带 body：若入口先拒绝，返回 400；若 body 被忽略而调用 service，
    // 会返回 404 study_session_not_found。返回 400 即证明 service 未被调用。
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/study-sessions/${uuid()}/detail`,
      headers: { 'content-type': 'application/json' },
      payload: { actorId: 'forged' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('validation_failed');
    expect(res.body).not.toContain('study_session_not_found');
    expect(res.body).not.toContain('forged');
  });
});

describe('GET /api/v1/study-sessions/:id/detail real HTTP fail-fast body rejection', () => {
  async function startRealServer(): Promise<{
    app: App;
    baseUrl: string;
    port: number;
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
    });
    await app.listen({ host: '127.0.0.1', port: 0 });
    const address = app.server.address();
    if (address === null || typeof address === 'string') {
      throw new Error('expected a TCP address object from app.server.address()');
    }
    const port = address.port;
    const baseUrl = `http://127.0.0.1:${port}`;
    return {
      app,
      baseUrl,
      port,
      close: async () => {
        await app.close();
      },
    };
  }

  /** 用裸 TCP socket 发送原始 HTTP 请求，等待服务端关闭后返回完整响应文本。 */
  function sendRaw(port: number, payload: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const socket = net.connect(port, '127.0.0.1');
      let data = '';
      socket.on('data', (chunk: Buffer) => {
        data += chunk.toString('utf8');
      });
      socket.on('close', () => resolve(data));
      socket.on('error', reject);
      socket.write(payload);
    });
  }

  it('rejects a normal non-empty JSON body over a real socket with 400 and no echo', async () => {
    const { app, port, close } = await startRealServer();
    try {
      const id = uuid();
      const payload = [
        `GET /api/v1/study-sessions/${id}/detail HTTP/1.1`,
        `Host: 127.0.0.1:${port}`,
        'Content-Type: application/json',
        'Content-Length: 20',
        'Connection: close',
        '',
        '{"actorId":"forged"}',
      ].join('\r\n');
      const resp = await sendRaw(port, payload);
      expect(resp.split('\r\n')[0]).toBe('HTTP/1.1 400 Bad Request');
      expect(resp).toContain('validation_failed');
      expect(resp).not.toContain('forged');
    } finally {
      await close();
    }
  });

  it('allows a Content-Length: 0 GET with a 200 detail response', async () => {
    const { app, baseUrl, port, close } = await startRealServer();
    try {
      const id = uuid();
      const created = await fetch(`${baseUrl}/api/v1/study-sessions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id, timerMode: 'count_down' }),
      });
      expect(created.status).toBe(201);

      const payload = [
        `GET /api/v1/study-sessions/${id}/detail HTTP/1.1`,
        `Host: 127.0.0.1:${port}`,
        'Content-Length: 0',
        'Connection: close',
        '',
        '',
      ].join('\r\n');
      const resp = await sendRaw(port, payload);
      expect(resp.split('\r\n')[0]).toBe('HTTP/1.1 200 OK');
      expect(resp).toContain('"summary":null');
    } finally {
      await close();
    }
  });

  it('rejects a chunked GET immediately, before the full body is sent', async () => {
    const { app, port, close } = await startRealServer();
    try {
      const id = uuid();
      // 只发送请求头 + 第一段 chunk，不发送终止 chunk（0\r\n\r\n）：若服务端等待
      // 完整 body，连接会一直挂起；基于 Transfer-Encoding 立即 400 并在 body 未读完
      // 时关闭连接，即证明 fail-fast，不会无上限消费请求体。
      const payload = [
        `GET /api/v1/study-sessions/${id}/detail HTTP/1.1`,
        `Host: 127.0.0.1:${port}`,
        'Transfer-Encoding: chunked',
        'Connection: close',
        '',
        '5\r\nhello\r\n',
      ].join('\r\n');
      const resp = await sendRaw(port, payload);
      expect(resp.split('\r\n')[0]).toBe('HTTP/1.1 400 Bad Request');
      expect(resp).toContain('validation_failed');
    } finally {
      await close();
    }
  });
});
