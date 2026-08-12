import { describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  countCodePoints,
  STUDY_REPORT_CONTENT_MAX_LENGTH,
  type AiActorType,
  type StudyReport,
} from '@mingwu/contracts';
import type { StudyParticipantRepository } from '../src/domain/study-participant/repository.js';
import {
  StudyReportService as StudyReportServiceImpl,
  type StudyReportService,
} from '../src/application/study-report/study-report-service.js';
import type { McpAuthContext } from '../src/domain/mcp-auth/mcp-auth-context.js';
import {
  buildMcpServer,
  type McpLogger,
} from '../src/mcp/mcp-server.js';
import { AUTH_FIXTURES } from './mcp-auth-fixtures.js';
import { makeServices, uuid } from './helpers.js';

type Services = ReturnType<typeof makeServices>;

/** 构造受信只读 MCP 认证上下文（冻结）。permissionProfile 默认 default。 */
function authContextFor(
  actorId: string,
  actorType: AiActorType,
  permissionProfile = 'default',
  connectionId = uuid(),
): McpAuthContext {
  return Object.freeze({
    actorId,
    actorCode: 'test-actor',
    actorType,
    connectionId,
    permissionProfile,
  });
}

interface BuildOptions {
  authContext?: McpAuthContext | null;
  services?: Services;
  studyReportService?: StudyReportService;
  logger?: McpLogger;
}

function buildTestServer(opts: BuildOptions = {}) {
  const services = opts.services ?? makeServices();
  const server = buildMcpServer({
    aiTaskService: services.aiTaskService,
    projectStatusService: services.projectStatusService,
    stageService: services.stageService,
    studySessionDetailService: services.studySessionDetailService,
    studySessionCurrentService: services.studySessionCurrentService,
    studyReportService: opts.studyReportService ?? services.studyReportService,
    stageUpdateRequestService: services.stageUpdateRequestService,
    projectWorkReportService: services.projectWorkReportService,
    serviceName: 'mingwu-server',
    serviceVersion: '0.1.0',
    logger: opts.logger ?? { error: () => undefined },
    authContext: opts.authContext ?? null,
  });
  return { server, services };
}

/** 用官方 Client + SDK 内存 transport 建立真实协议连接（自动完成 initialize 握手）。 */
async function connectClient(server: McpServer): Promise<Client> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'append-test-client', version: '0.0.1' });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return client;
}

/** callTool 未提供 resultSchema 时返回联合类型；这里只取其中的文本内容块。 */
function firstText(result: {
  [key: string]: unknown;
  content?: ReadonlyArray<{ type: string; text?: string }>;
}): string {
  const block = result.content?.[0];
  if (!block || block.type !== 'text' || typeof block.text !== 'string') {
    throw new Error('expected text content block');
  }
  return block.text;
}

/** 创建一个可追加报告的 running Session（草稿创建后立即开始）。 */
async function createRunningSession(services: Services): Promise<{ id: string }> {
  const { studySession } = await services.studySessionService.createStudySession({
    id: uuid(),
    timerMode: 'count_down',
    taskText: '背单词',
    plannedDurationSeconds: 600,
  });
  await services.studySessionService.startStudySession(studySession.id, { expectedVersion: 1 });
  return { id: studySession.id };
}

/** 捕获 McpLogger.error 的全部日志文本，用于断言未知异常脱敏。 */
function createLogCapture() {
  const lines: string[] = [];
  const logger: McpLogger = {
    error: (...args: unknown[]) => {
      lines.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '));
    },
  };
  const text = () => lines.join('\n');
  return { logger, text };
}

describe('MCP study_append_report write tool', () => {
  it('resident_ai with default profile appends a report attributed to the bound identity and joins the session', async () => {
    const { server, services } = buildTestServer({
      authContext: authContextFor(AUTH_FIXTURES.actorA.actorId, 'resident_ai'),
    });
    const session = await createRunningSession(services);
    const client = await connectClient(server);
    try {
      // 工具可见（listTools 精确包含本工具）。
      const { tools } = await client.listTools();
      expect(tools.some((t) => t.name === 'study_append_report')).toBe(true);

      const reportId = uuid();
      const result = await client.callTool({
        name: 'study_append_report',
        arguments: { report_id: reportId, session_id: session.id, content: '第一份学习报告' },
      });
      expect(result.isError).not.toBe(true);
      const report = JSON.parse(firstText(result)) as StudyReport;
      expect(report.id).toBe(reportId);
      expect(report.studySessionId).toBe(session.id);
      // actorId 来自绑定身份，不是客户端可指定的字段。
      expect(report.actorId).toBe(AUTH_FIXTURES.actorA.actorId);
      expect(report.sequenceNumber).toBe(1);
      expect(report.content).toBe('第一份学习报告');
      expect(typeof report.submittedAt).toBe('string');
      // 成功结果不得回显 token / connectionId / permissionProfile。
      const serialized = firstText(result);
      expect(serialized).not.toContain(AUTH_FIXTURES.connection1.token);
      expect(serialized).not.toContain(AUTH_FIXTURES.connection1.connectionId);
      expect(serialized).not.toContain('permissionProfile');
      // Participant 同步建立。
      const participants = await services.studyReportService.listParticipants(session.id);
      expect(participants).toEqual([
        {
          studySessionId: session.id,
          actorId: AUTH_FIXTURES.actorA.actorId,
          joinedAt: report.submittedAt,
          lastActiveAt: report.submittedAt,
        },
      ]);
    } finally {
      await client.close();
      await server.close();
    }
  });

  it('temporary_ai appends under default profile; reviewer / unknown profile / anonymous are rejected with zero writes', async () => {
    const services = makeServices();
    const session = await createRunningSession(services);

    // temporary_ai 在 default 权限下允许追加。
    const temp = buildTestServer({
      services,
      authContext: authContextFor(uuid(), 'temporary_ai'),
    });
    const tempClient = await connectClient(temp.server);
    try {
      const ok = await tempClient.callTool({
        name: 'study_append_report',
        arguments: { report_id: uuid(), session_id: session.id, content: '临时报告' },
      });
      expect(ok.isError).not.toBe(true);
    } finally {
      await tempClient.close();
      await temp.server.close();
    }

    // reviewer 拒绝且零写入。
    const rev = buildTestServer({
      services,
      authContext: authContextFor(uuid(), 'reviewer'),
    });
    const revClient = await connectClient(rev.server);
    try {
      const denied = await revClient.callTool({
        name: 'study_append_report',
        arguments: { report_id: uuid(), session_id: session.id, content: 'reviewer 报告' },
      });
      expect(denied.isError).toBe(true);
      expect(firstText(denied)).toBe('当前身份无权追加学习报告');
    } finally {
      await revClient.close();
      await rev.server.close();
    }

    // 未知 permissionProfile 拒绝。
    const unknownProfile = buildTestServer({
      services,
      authContext: authContextFor(uuid(), 'resident_ai', 'admin'),
    });
    const profileClient = await connectClient(unknownProfile.server);
    try {
      const denied = await profileClient.callTool({
        name: 'study_append_report',
        arguments: { report_id: uuid(), session_id: session.id, content: 'admin 报告' },
      });
      expect(denied.isError).toBe(true);
      expect(firstText(denied)).toBe('当前身份无权追加学习报告');
    } finally {
      await profileClient.close();
      await unknownProfile.server.close();
    }

    // 匿名只读上下文：工具可见但写入 fail-closed 拒绝。
    const anon = buildTestServer({ services, authContext: null });
    const anonClient = await connectClient(anon.server);
    try {
      const { tools } = await anonClient.listTools();
      expect(tools.some((t) => t.name === 'study_append_report')).toBe(true);
      const denied = await anonClient.callTool({
        name: 'study_append_report',
        arguments: { report_id: uuid(), session_id: session.id, content: '匿名报告' },
      });
      expect(denied.isError).toBe(true);
      expect(firstText(denied)).toBe('当前连接未授权写操作');
    } finally {
      await anonClient.close();
      await anon.server.close();
    }

    // 只有 temporary_ai 那一条成功写入：其余全部零写入。
    const reports = await services.studyReportService.listReports(session.id);
    expect(reports).toHaveLength(1);
    expect(reports[0]!.content).toBe('临时报告');
    const participants = await services.studyReportService.listParticipants(session.id);
    expect(participants).toHaveLength(1);
  });

  it('rejects smuggled identity / protected fields without writing, so nobody can append for another actor', async () => {
    const { server, services } = buildTestServer({
      authContext: authContextFor(AUTH_FIXTURES.actorA.actorId, 'resident_ai'),
    });
    const session = await createRunningSession(services);
    const client = await connectClient(server);
    try {
      const result = await client.callTool({
        name: 'study_append_report',
        arguments: {
          report_id: uuid(),
          session_id: session.id,
          content: '正常正文',
          actorId: '00000000-0000-4000-8000-000000000099',
          actor_id: '00000000-0000-4000-8000-000000000098',
          actorCode: 'forged-actor',
          author: 'evil-author',
          connectionId: '00000000-0000-4000-8000-000000000097',
          permissionProfile: 'admin',
          sequenceNumber: 999,
          submittedAt: '2020-01-01T00:00:00.000Z',
        },
      });
      // 严格 schema 拒绝额外字段。
      expect(result.isError).toBe(true);
      // 零写入：任何报告与 Participant 都不得产生。
      expect(await services.studyReportService.listReports(session.id)).toHaveLength(0);
      expect(await services.studyReportService.listParticipants(session.id)).toHaveLength(0);
    } finally {
      await client.close();
      await server.close();
    }
  });

  it('two connections mapping to the same actor share one report stream; a different actor gets its own sequence', async () => {
    const services = makeServices();
    const session = await createRunningSession(services);
    // 同一 Actor（actorA）的两条不同连接。
    const conn1 = buildTestServer({
      services,
      authContext: authContextFor(AUTH_FIXTURES.actorA.actorId, 'resident_ai'),
    });
    const conn2 = buildTestServer({
      services,
      authContext: authContextFor(AUTH_FIXTURES.actorA.actorId, 'resident_ai'),
    });
    const c1 = await connectClient(conn1.server);
    const c2 = await connectClient(conn2.server);
    try {
      const r1 = await c1.callTool({
        name: 'study_append_report',
        arguments: { report_id: uuid(), session_id: session.id, content: 'A 连接1 报告' },
      });
      const r2 = await c2.callTool({
        name: 'study_append_report',
        arguments: { report_id: uuid(), session_id: session.id, content: 'A 连接2 报告' },
      });
      const rep1 = JSON.parse(firstText(r1)) as StudyReport;
      const rep2 = JSON.parse(firstText(r2)) as StudyReport;
      expect(rep1.actorId).toBe(AUTH_FIXTURES.actorA.actorId);
      expect(rep2.actorId).toBe(AUTH_FIXTURES.actorA.actorId);
      expect(rep1.sequenceNumber).toBe(1);
      expect(rep2.sequenceNumber).toBe(2);

      // 另一 Actor（actorB）写入同一 Session：序号从 1 开始，互不覆盖。
      const connB = buildTestServer({
        services,
        authContext: authContextFor(AUTH_FIXTURES.actorB.actorId, 'resident_ai'),
      });
      const cB = await connectClient(connB.server);
      try {
        const rB = await cB.callTool({
          name: 'study_append_report',
          arguments: { report_id: uuid(), session_id: session.id, content: 'B 报告' },
        });
        const repB = JSON.parse(firstText(rB)) as StudyReport;
        expect(repB.actorId).toBe(AUTH_FIXTURES.actorB.actorId);
        expect(repB.sequenceNumber).toBe(1);
      } finally {
        await cB.close();
        await connB.server.close();
      }

      // A 的两条报告保留，序号连续。
      const reports = await services.studyReportService.listReports(session.id);
      expect(reports).toHaveLength(3);
      const aReports = reports.filter((r) => r.actorId === AUTH_FIXTURES.actorA.actorId);
      expect(aReports.map((r) => r.sequenceNumber).sort()).toEqual([1, 2]);
    } finally {
      await c1.close();
      await conn1.server.close();
      await c2.close();
      await conn2.server.close();
    }
  });

  it('same report_id with same semantics retries idempotently; different semantics conflict without overwriting', async () => {
    const { server, services } = buildTestServer({
      authContext: authContextFor(AUTH_FIXTURES.actorA.actorId, 'resident_ai'),
    });
    const session = await createRunningSession(services);
    const client = await connectClient(server);
    try {
      const reportId = uuid();
      const first = await client.callTool({
        name: 'study_append_report',
        arguments: { report_id: reportId, session_id: session.id, content: '同正文' },
      });
      expect(first.isError).not.toBe(true);

      // 同 id + 同 Session + 同 Actor + 同规范化正文（排版差异）→ 幂等成功。
      const retry = await client.callTool({
        name: 'study_append_report',
        arguments: { report_id: reportId, session_id: session.id, content: '  同正文  ' },
      });
      expect(retry.isError).not.toBe(true);
      const retryReport = JSON.parse(firstText(retry)) as StudyReport;
      expect(retryReport.id).toBe(reportId);
      expect(retryReport.sequenceNumber).toBe(1);
      expect(await services.studyReportService.listReports(session.id)).toHaveLength(1);

      // 同 id 不同正文 → 受控冲突。
      const conflict = await client.callTool({
        name: 'study_append_report',
        arguments: { report_id: reportId, session_id: session.id, content: '不同正文' },
      });
      expect(conflict.isError).toBe(true);
      expect(firstText(conflict)).toBe('报告已存在且语义冲突，不覆盖旧报告');

      // 同 id 不同 Session → 受控冲突。
      const session2 = await createRunningSession(services);
      const conflictSession = await client.callTool({
        name: 'study_append_report',
        arguments: { report_id: reportId, session_id: session2.id, content: '同正文' },
      });
      expect(conflictSession.isError).toBe(true);
      expect(firstText(conflictSession)).toBe('报告已存在且语义冲突，不覆盖旧报告');

      // 同 id 不同 Actor → 受控冲突。
      const connB = buildTestServer({
        services,
        authContext: authContextFor(AUTH_FIXTURES.actorB.actorId, 'resident_ai'),
      });
      const cB = await connectClient(connB.server);
      try {
        const conflictActor = await cB.callTool({
          name: 'study_append_report',
          arguments: { report_id: reportId, session_id: session.id, content: '同正文' },
        });
        expect(conflictActor.isError).toBe(true);
        expect(firstText(conflictActor)).toBe('报告已存在且语义冲突，不覆盖旧报告');
      } finally {
        await cB.close();
        await connB.server.close();
      }

      // 旧报告从未被覆盖，仍只有一份。
      expect(await services.studyReportService.listReports(session.id)).toHaveLength(1);
    } finally {
      await client.close();
      await server.close();
    }
  });

  it('maps session-not-found, created-only and invalid content to controlled errors with zero writes', async () => {
    const { server, services } = buildTestServer({
      authContext: authContextFor(AUTH_FIXTURES.actorA.actorId, 'resident_ai'),
    });
    const session = await createRunningSession(services);
    const { studySession: createdSession } = await services.studySessionService.createStudySession({
      id: uuid(),
      timerMode: 'count_down',
      taskText: '草稿',
      plannedDurationSeconds: 600,
    });
    const client = await connectClient(server);
    try {
      // Session 不存在。
      const missing = await client.callTool({
        name: 'study_append_report',
        arguments: { report_id: uuid(), session_id: uuid(), content: '正文' },
      });
      expect(missing.isError).toBe(true);
      expect(firstText(missing)).toBe('自习记录不存在');

      // created 草稿不可追加。
      const created = await client.callTool({
        name: 'study_append_report',
        arguments: { report_id: uuid(), session_id: createdSession.id, content: '正文' },
      });
      expect(created.isError).toBe(true);
      expect(firstText(created)).toBe('自习记录尚未开始，无法追加报告');

      // 纯空白正文。
      const blank = await client.callTool({
        name: 'study_append_report',
        arguments: { report_id: uuid(), session_id: session.id, content: '   ' },
      });
      expect(blank.isError).toBe(true);
      expect(firstText(blank)).toBe('报告正文不合法');

      // Unicode 上界：恰好 STUDY_REPORT_CONTENT_MAX_LENGTH 个 code point 允许。
      const exact = await client.callTool({
        name: 'study_append_report',
        arguments: {
          report_id: uuid(),
          session_id: session.id,
          content: '中'.repeat(STUDY_REPORT_CONTENT_MAX_LENGTH),
        },
      });
      expect(exact.isError).not.toBe(true);

      // 超过上界（无论 schema 或服务校验先拦截）→ 拒绝。
      const tooLong = await client.callTool({
        name: 'study_append_report',
        arguments: {
          report_id: uuid(),
          session_id: session.id,
          content: '中'.repeat(STUDY_REPORT_CONTENT_MAX_LENGTH + 1),
        },
      });
      expect(tooLong.isError).toBe(true);

      // 只成功写入 exact 一条。
      const reports = await services.studyReportService.listReports(session.id);
      expect(reports).toHaveLength(1);
    } finally {
      await client.close();
      await server.close();
    }
  });

  it('unifies content length with the service layer: astral emoji and trim boundaries use code point counting', async () => {
    const { server, services } = buildTestServer({
      authContext: authContextFor(AUTH_FIXTURES.actorA.actorId, 'resident_ai'),
    });
    const session = await createRunningSession(services);
    const client = await connectClient(server);
    try {
      // 恰好 5000 个 emoji（astral code point，UTF-16 下 JS length 为 10000）：
      // 入口必须按 countCodePoints(trim) 与服务层统一放行，不得按 code unit 误拒绝。
      const exactReportId = uuid();
      const exact = await client.callTool({
        name: 'study_append_report',
        arguments: {
          report_id: exactReportId,
          session_id: session.id,
          content: '😀'.repeat(STUDY_REPORT_CONTENT_MAX_LENGTH),
        },
      });
      expect(exact.isError).not.toBe(true);
      const exactReport = JSON.parse(firstText(exact)) as StudyReport;
      expect(countCodePoints(exactReport.content)).toBe(STUDY_REPORT_CONTENT_MAX_LENGTH);

      // 5001 个 emoji 被拒绝且零新增。
      const tooLong = await client.callTool({
        name: 'study_append_report',
        arguments: {
          report_id: uuid(),
          session_id: session.id,
          content: '😀'.repeat(STUDY_REPORT_CONTENT_MAX_LENGTH + 1),
        },
      });
      expect(tooLong.isError).toBe(true);

      // 首尾带空白、trim 后恰好 5000 个 emoji：允许，保存内容为规范化后的正文。
      const paddedReportId = uuid();
      const padded = await client.callTool({
        name: 'study_append_report',
        arguments: {
          report_id: paddedReportId,
          session_id: session.id,
          content: `  ${'😀'.repeat(STUDY_REPORT_CONTENT_MAX_LENGTH)}  `,
        },
      });
      expect(padded.isError).not.toBe(true);
      const paddedReport = JSON.parse(firstText(padded)) as StudyReport;
      expect(paddedReport.content).toBe('😀'.repeat(STUDY_REPORT_CONTENT_MAX_LENGTH));

      // 只成功写入两条（exact 与 padded）。
      const reports = await services.studyReportService.listReports(session.id);
      expect(reports).toHaveLength(2);
    } finally {
      await client.close();
      await server.close();
    }
  });

  it('returns a controlled participant-update error and a same-id retry recovers the participant', async () => {
    const services = makeServices();
    const session = await createRunningSession(services);
    // 注入会失败的 Participant 仓储：报告写入成功但 Participant upsert 失败。
    const failingParticipant: StudyParticipantRepository = {
      upsert: async () => {
        throw new Error('db password=PARTICIPANT_SECRET leaked');
      },
      listBySession: async () => [],
    };
    const failingService = new StudyReportServiceImpl(
      services.studyReportRepository,
      failingParticipant,
      services.studySessionRepository,
    );
    const { server } = buildTestServer({
      services,
      studyReportService: failingService,
      authContext: authContextFor(AUTH_FIXTURES.actorA.actorId, 'resident_ai'),
    });
    const client = await connectClient(server);
    const reportId = uuid();
    try {
      const result = await client.callTool({
        name: 'study_append_report',
        arguments: { report_id: reportId, session_id: session.id, content: '正文' },
      });
      expect(result.isError).toBe(true);
      expect(firstText(result)).toBe('参与者更新失败，请使用相同报告 ID 重试');

      // 用正常仓储（同一 services）以同一幂等 id 重试：命中已有报告、序号不推进、
      // Participant 补建成功。
      const normal = buildTestServer({
        services,
        authContext: authContextFor(AUTH_FIXTURES.actorA.actorId, 'resident_ai'),
      });
      const normalClient = await connectClient(normal.server);
      try {
        const retry = await normalClient.callTool({
          name: 'study_append_report',
          arguments: { report_id: reportId, session_id: session.id, content: '正文' },
        });
        expect(retry.isError).not.toBe(true);
        const report = JSON.parse(firstText(retry)) as StudyReport;
        expect(report.sequenceNumber).toBe(1);
      } finally {
        await normalClient.close();
        await normal.server.close();
      }
      // Participant 补建，报告仍只有一份。
      const participants = await services.studyReportService.listParticipants(session.id);
      expect(participants).toHaveLength(1);
      expect(await services.studyReportService.listReports(session.id)).toHaveLength(1);
    } finally {
      await client.close();
      await server.close();
    }
  });

  it('sanitizes an unknown appendReport exception: generic result, log without raw message or secret', async () => {
    const capture = createLogCapture();
    const services = makeServices();
    const throwingService = {
      appendReport: async () => {
        throw new Error('boom password=APPEND_SECRET leaked');
      },
    } as unknown as StudyReportService;
    const { server } = buildTestServer({
      services,
      studyReportService: throwingService,
      authContext: authContextFor(AUTH_FIXTURES.actorA.actorId, 'resident_ai'),
      logger: capture.logger,
    });
    const client = await connectClient(server);
    try {
      const result = await client.callTool({
        name: 'study_append_report',
        arguments: { report_id: uuid(), session_id: uuid(), content: '正文' },
      });
      expect(result.isError).toBe(true);
      expect(firstText(result)).toBe('内部错误');
      expect(firstText(result)).not.toContain('APPEND_SECRET');
      const logText = capture.text();
      expect(logText).not.toContain('APPEND_SECRET');
      expect(logText).not.toContain('boom');
      expect(logText).toContain('mcp tool internal error');
    } finally {
      await client.close();
      await server.close();
    }
  });
});
