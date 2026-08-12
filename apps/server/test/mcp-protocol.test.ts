import { describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ProjectStatusService } from '../src/application/project-status/project-status-service.js';
import type { StudySessionDetailService } from '../src/application/study-session-detail/study-session-detail-service.js';
import { buildMcpServer } from '../src/mcp/mcp-server.js';
import {
  makeServices,
  makeStudyParticipant,
  makeStudySession,
  makeStudySummary,
  makeTask,
  uuid,
} from './helpers.js';

function buildTestServer() {
  const services = makeServices();
  const server = buildMcpServer({
    aiTaskService: services.aiTaskService,
    projectStatusService: services.projectStatusService,
    stageService: services.stageService,
    studySessionDetailService: services.studySessionDetailService,
    studySessionCurrentService: services.studySessionCurrentService,
    studyReportService: services.studyReportService,
    stageUpdateRequestService: services.stageUpdateRequestService,
    projectWorkReportService: services.projectWorkReportService,
    serviceName: 'mingwu-server',
    serviceVersion: '0.1.0',
    logger: { error: () => undefined },
    authContext: null,
  });
  return { server, services };
}

/** 用官方 Client + SDK 内存 transport 建立真实协议连接（自动完成 initialize 握手）。 */
async function connectClient(server: McpServer): Promise<Client> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test-client', version: '0.0.1' });
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

describe('MCP protocol (official Client + InMemoryTransport)', () => {
  it('initialize succeeds and exposes the six read-only tools plus three write tools with strict schemas', async () => {
    const { server } = buildTestServer();
    const client = await connectClient(server);
    try {
      const { tools } = await client.listTools();
      expect(tools.map((t) => t.name).sort()).toEqual([
        'project_get_stage',
        'project_get_status',
        'project_list_reports',
        'project_list_stages',
        'project_submit_stage_update',
        'study_append_report',
        'study_get_current_session',
        'study_get_session',
        'task_create',
        'task_list_my_tasks',
      ]);
      // 七个只读工具都明确只读；三个写工具（study_append_report /
      // project_submit_stage_update / task_create）不得标“只读”。
      const READ_ONLY_TOOLS = new Set([
        'project_get_stage',
        'project_get_status',
        'project_list_stages',
        'project_list_reports',
        'study_get_session',
        'study_get_current_session',
        'task_list_my_tasks',
      ]);
      const writeTools = tools.filter((t) => !READ_ONLY_TOOLS.has(t.name));
      expect(writeTools.map((t) => t.name).sort()).toEqual([
        'project_submit_stage_update',
        'study_append_report',
        'task_create',
      ]);
      for (const tool of tools.filter((t) => READ_ONLY_TOOLS.has(t.name))) {
        expect(tool.description).toContain('只读');
      }
      for (const tool of writeTools) {
        expect(tool.description).not.toContain('只读');
      }
      // 严格 input schema：禁止未知字段。需要 UUID 字段的工具只允许指定字段；
      // study_get_current_session 是严格空对象（无任何输入参数）。
      const fieldByTool: Record<string, string[] | null> = {
        project_get_stage: ['stage_id'],
        project_get_status: ['project_id'],
        project_list_stages: ['project_id'],
        project_list_reports: ['stage_id'],
        study_get_session: ['session_id'],
        study_get_current_session: null,
        study_append_report: ['report_id', 'session_id', 'content'],
        project_submit_stage_update: [
          'request_id',
          'stage_id',
          'expected_stage_version',
          'proposed_status',
          'reason',
        ],
        // task_create 只列必填字段：project_task_id / parent_task_id / description
        // 为可选字段，不进 required；可选字段的严格拒绝与长度边界在
        // mcp-task-create.test.ts 中单独覆盖。
        task_create: ['task_id', 'project_id', 'title'],
        // task_list_my_tasks 严格白名单只允许 project_id；身份 / 筛选字段的严格拒绝
        // 在 mcp-task-list-my-tasks.test.ts 中单独覆盖。
        task_list_my_tasks: ['project_id'],
      };
      // 各工具字段类型：uuid 字段为 string + format uuid；其余字段只断言存在。
      const UUID_FIELDS = new Set([
        'project_id',
        'stage_id',
        'session_id',
        'report_id',
        'request_id',
        'task_id',
        'project_task_id',
        'parent_task_id',
      ]);
      for (const tool of tools) {
        expect(tool.inputSchema.type).toBe('object');
        expect(tool.inputSchema.additionalProperties).toBe(false);
        const fields = fieldByTool[tool.name];
        if (fields == null) {
          // 严格空对象：SDK 生成 JSON Schema 时会省略空 required 数组。
          expect(tool.inputSchema.required ?? []).toEqual([]);
          expect(tool.inputSchema.properties ?? {}).toEqual({});
        } else {
          expect((tool.inputSchema.required ?? []).slice().sort()).toEqual(fields!.slice().sort());
          for (const field of fields) {
            const prop = tool.inputSchema.properties?.[field] as Record<string, unknown> | undefined;
            expect(prop).toBeDefined();
            if (UUID_FIELDS.has(field)) {
              expect(prop?.type).toBe('string');
              expect(prop?.format).toBe('uuid');
            }
          }
        }
      }
      // 写工具精确：仅 study_append_report 与 project_submit_stage_update 两个，
      // 不存在任何其他写工具（如直接设置关卡状态的工具）。
      const names = tools.map((t) => t.name);
      expect(names).not.toContain('project_set_stage_status');
      // project_submit_stage_update 的混合类型字段：uuid 字段为 string+format，
      // expected_stage_version 为受正数约束的数字，proposed_status 为带枚举的字符串。
      const submitTool = tools.find((t) => t.name === 'project_submit_stage_update')!;
      const submitProps = submitTool.inputSchema.properties as Record<
        string,
        Record<string, unknown>
      >;
      expect(submitProps.request_id!.type).toBe('string');
      expect(submitProps.request_id!.format).toBe('uuid');
      expect(submitProps.stage_id!.type).toBe('string');
      expect(submitProps.stage_id!.format).toBe('uuid');
      expect(submitProps.expected_stage_version!.type).toBe('integer');
      const ver = submitProps.expected_stage_version! as Record<string, unknown>;
      const hasPositiveBound =
        (typeof ver.minimum === 'number' && (ver.minimum as number) >= 1) ||
        (typeof ver.exclusiveMinimum === 'number' && (ver.exclusiveMinimum as number) >= 0);
      expect(hasPositiveBound).toBe(true);
      expect(submitProps.proposed_status!.type).toBe('string');
      expect(Array.isArray(submitProps.proposed_status!.enum)).toBe(true);
      expect((submitProps.proposed_status!.enum as unknown[]).length).toBeGreaterThan(0);
      expect(submitProps.reason!.type).toBe('string');
    } finally {
      await client.close();
      await server.close();
    }
  });

  it('project_get_status matches the ProjectStatusService semantics and rejects unknown projects', async () => {
    const { server, services } = buildTestServer();
    const { project } = await services.projectService.createProject({ id: uuid(), name: 'Proj' });
    await services.stageService.createStage(project.id, { id: uuid(), name: 'S1', position: 1 });
    const client = await connectClient(server);
    try {
      const result = await client.callTool({
        name: 'project_get_status',
        arguments: { project_id: project.id },
      });
      expect(result.isError).not.toBe(true);
      const parsed = JSON.parse(firstText(result)) as unknown;
      expect(parsed).toEqual(await services.projectStatusService.getStatus(project.id));

      const missing = await client.callTool({
        name: 'project_get_status',
        arguments: { project_id: uuid() },
      });
      expect(missing.isError).toBe(true);
      expect(firstText(missing)).toBe('项目不存在');
    } finally {
      await client.close();
      await server.close();
    }
  });

  it('project_list_stages returns position-ordered stages and errors on unknown projects', async () => {
    const { server, services } = buildTestServer();
    const { project } = await services.projectService.createProject({ id: uuid(), name: 'Proj' });
    await services.stageService.createStage(project.id, { id: uuid(), name: 'C', position: 3 });
    await services.stageService.createStage(project.id, { id: uuid(), name: 'A', position: 1 });
    await services.stageService.createStage(project.id, { id: uuid(), name: 'B', position: 2 });
    const client = await connectClient(server);
    try {
      const result = await client.callTool({
        name: 'project_list_stages',
        arguments: { project_id: project.id },
      });
      expect(result.isError).not.toBe(true);
      const stages = JSON.parse(firstText(result)) as Array<{ name: string; position: number }>;
      expect(stages.map((s) => s.position)).toEqual([1, 2, 3]);
      expect(stages.map((s) => s.name)).toEqual(['A', 'B', 'C']);

      const missing = await client.callTool({
        name: 'project_list_stages',
        arguments: { project_id: uuid() },
      });
      expect(missing.isError).toBe(true);
      expect(firstText(missing)).toBe('项目不存在');
    } finally {
      await client.close();
      await server.close();
    }
  });

  it('project_get_stage returns the single stage and errors when it is unknown', async () => {
    const { server, services } = buildTestServer();
    const { project } = await services.projectService.createProject({ id: uuid(), name: 'Proj' });
    const { stage } = await services.stageService.createStage(project.id, {
      id: uuid(),
      name: '第一关',
      position: 1,
    });
    const client = await connectClient(server);
    try {
      const result = await client.callTool({
        name: 'project_get_stage',
        arguments: { stage_id: stage.id },
      });
      expect(result.isError).not.toBe(true);
      const parsed = JSON.parse(firstText(result)) as { id: string; name: string };
      expect(parsed.id).toBe(stage.id);
      expect(parsed.name).toBe('第一关');
      expect(parsed).toEqual(await services.stageService.getStage(stage.id));

      const missing = await client.callTool({
        name: 'project_get_stage',
        arguments: { stage_id: uuid() },
      });
      expect(missing.isError).toBe(true);
      expect(firstText(missing)).toBe('关卡不存在');
    } finally {
      await client.close();
      await server.close();
    }
  });

  it('rejects a non-UUID value with a controlled isError result', async () => {
    const { server } = buildTestServer();
    const client = await connectClient(server);
    try {
      const result = await client.callTool({
        name: 'project_get_status',
        arguments: { project_id: 'not-a-uuid' },
      });
      expect(result.isError).toBe(true);
      expect(firstText(result)).toContain('Invalid uuid');
    } finally {
      await client.close();
      await server.close();
    }
  });

  it('rejects unknown fields in tool input (strict schema)', async () => {
    const { server } = buildTestServer();
    const client = await connectClient(server);
    try {
      const result = await client.callTool({
        name: 'project_get_status',
        arguments: { project_id: uuid(), bogus: 'x', actorId: 'forged' },
      });
      expect(result.isError).toBe(true);
      expect(firstText(result)).toContain('Unrecognized key');
    } finally {
      await client.close();
      await server.close();
    }
  });

  /** 播种一个带 summary / 参与者 / 报告的会话，返回 sessionId。 */
  async function seedFullStudySession(services: ReturnType<typeof makeServices>): Promise<string> {
    const { studySession } = await services.studySessionService.createStudySession({
      id: uuid(),
      timerMode: 'count_up',
    });
    const sessionId = studySession.id;
    const actorA = uuid();
    await services.studyReportRepository.appendReport({
      id: uuid(),
      studySessionId: sessionId,
      actorId: actorA,
      content: 'A 的学习报告',
      submittedAt: '2026-01-01T08:00:00.000Z',
    });
    await services.studyParticipantRepository.upsert(
      makeStudyParticipant({
        studySessionId: sessionId,
        actorId: actorA,
        joinedAt: '2026-01-01T08:00:00.000Z',
        lastActiveAt: '2026-01-01T08:00:00.000Z',
      }),
    );
    await services.studySummaryRepository.createIfAbsent(
      makeStudySummary({ studySessionId: sessionId, content: '正式总结' }),
    );
    return sessionId;
  }

  it('study_get_session returns the full aggregation and matches the detail service', async () => {
    const { server, services } = buildTestServer();
    const sessionId = await seedFullStudySession(services);
    const client = await connectClient(server);
    try {
      const result = await client.callTool({
        name: 'study_get_session',
        arguments: { session_id: sessionId },
      });
      expect(result.isError).not.toBe(true);
      const parsed = JSON.parse(firstText(result)) as {
        session: { id: string };
        summary: unknown;
        participants: unknown[];
        reports: unknown[];
      };
      expect(parsed.session.id).toBe(sessionId);
      expect(parsed.summary).toBeTruthy();
      expect(parsed.participants).toHaveLength(1);
      expect(parsed.reports).toHaveLength(1);
      expect(parsed).toEqual(await services.studySessionDetailService.getDetail(sessionId));
    } finally {
      await client.close();
      await server.close();
    }
  });

  it('study_get_session returns null summary and empty arrays when none exist', async () => {
    const { server, services } = buildTestServer();
    const { studySession } = await services.studySessionService.createStudySession({
      id: uuid(),
      timerMode: 'count_up',
    });
    const client = await connectClient(server);
    try {
      const result = await client.callTool({
        name: 'study_get_session',
        arguments: { session_id: studySession.id },
      });
      expect(result.isError).not.toBe(true);
      const parsed = JSON.parse(firstText(result)) as {
        summary: unknown;
        participants: unknown[];
        reports: unknown[];
      };
      expect(parsed.summary).toBeNull();
      expect(parsed.participants).toEqual([]);
      expect(parsed.reports).toEqual([]);
    } finally {
      await client.close();
      await server.close();
    }
  });

  it('study_get_session errors on an unknown session', async () => {
    const { server } = buildTestServer();
    const client = await connectClient(server);
    try {
      const result = await client.callTool({
        name: 'study_get_session',
        arguments: { session_id: uuid() },
      });
      expect(result.isError).toBe(true);
      expect(firstText(result)).toBe('自习记录不存在');
    } finally {
      await client.close();
      await server.close();
    }
  });

  it('study_get_session rejects a non-UUID session_id and forged identity fields', async () => {
    const { server } = buildTestServer();
    const client = await connectClient(server);
    try {
      const invalid = await client.callTool({
        name: 'study_get_session',
        arguments: { session_id: 'not-a-uuid' },
      });
      expect(invalid.isError).toBe(true);
      expect(firstText(invalid)).toContain('Invalid uuid');

      const forged = await client.callTool({
        name: 'study_get_session',
        arguments: { session_id: uuid(), actorId: 'forged', actorType: 'resident_ai' },
      });
      expect(forged.isError).toBe(true);
      expect(firstText(forged)).toContain('Unrecognized key');
    } finally {
      await client.close();
      await server.close();
    }
  });

  it('sanitizes unknown study tool errors: generic result, no secret in the captured log', async () => {
    const services = makeServices();
    const messages: unknown[][] = [];
    const logger = { error: (...args: unknown[]) => void messages.push(args) };
    const throwingDetail = {
      getDetail: async () => {
        throw new Error('study database password=TEST_SECRET leaked');
      },
    } as unknown as StudySessionDetailService;
    const server = buildMcpServer({
      aiTaskService: services.aiTaskService,
      projectStatusService: services.projectStatusService,
      stageService: services.stageService,
      studySessionDetailService: throwingDetail,
      studySessionCurrentService: services.studySessionCurrentService,
      studyReportService: services.studyReportService,
      stageUpdateRequestService: services.stageUpdateRequestService,
      projectWorkReportService: services.projectWorkReportService,
      serviceName: 'mingwu-server',
      serviceVersion: '0.1.0',
      logger,
      authContext: null,
    });
    const client = await connectClient(server);
    try {
      const result = await client.callTool({
        name: 'study_get_session',
        arguments: { session_id: uuid() },
      });
      expect(result.isError).toBe(true);
      expect(firstText(result)).toBe('内部错误');
      expect(firstText(result)).not.toContain('TEST_SECRET');
    } finally {
      await client.close();
      await server.close();
    }
    const logText = JSON.stringify(messages);
    expect(logText).toContain('mcp tool internal error');
    expect(logText).toContain('errType');
    expect(logText).not.toContain('TEST_SECRET');
    expect(logText).not.toContain('study database password=');
  });

  it('study_get_session is read-only: repeated and concurrent calls never mutate', async () => {
    const { server, services } = buildTestServer();
    const sessionId = await seedFullStudySession(services);
    const before = {
      session: await services.studySessionRepository.findById(sessionId),
      summary: await services.studySummaryRepository.findByStudySessionId(sessionId),
      participants: await services.studyParticipantRepository.listBySession(sessionId),
      reports: await services.studyReportRepository.listBySession(sessionId),
    };
    const client = await connectClient(server);
    try {
      await Promise.all([
        client.callTool({ name: 'study_get_session', arguments: { session_id: sessionId } }),
        client.callTool({ name: 'study_get_session', arguments: { session_id: sessionId } }),
        client.callTool({ name: 'study_get_session', arguments: { session_id: sessionId } }),
      ]);
      await client.callTool({ name: 'study_get_session', arguments: { session_id: sessionId } });
    } finally {
      await client.close();
      await server.close();
    }
    expect(await services.studySessionRepository.findById(sessionId)).toEqual(before.session);
    expect(await services.studySummaryRepository.findByStudySessionId(sessionId)).toEqual(
      before.summary,
    );
    expect(await services.studyParticipantRepository.listBySession(sessionId)).toEqual(
      before.participants,
    );
    expect(await services.studyReportRepository.listBySession(sessionId)).toEqual(before.reports);
  });

  it('sanitizes unknown tool errors: generic result, no secret in the captured log', async () => {
    const services = makeServices();
    const messages: unknown[][] = [];
    const logger = { error: (...args: unknown[]) => void messages.push(args) };
    const throwingStatus = {
      getStatus: async () => {
        throw new Error('access_token=TEST_SECRET leaked');
      },
    } as unknown as ProjectStatusService;
    const server = buildMcpServer({
      aiTaskService: services.aiTaskService,
      projectStatusService: throwingStatus,
      stageService: services.stageService,
      studySessionDetailService: services.studySessionDetailService,
      studySessionCurrentService: services.studySessionCurrentService,
      studyReportService: services.studyReportService,
      stageUpdateRequestService: services.stageUpdateRequestService,
      projectWorkReportService: services.projectWorkReportService,
      serviceName: 'mingwu-server',
      serviceVersion: '0.1.0',
      logger,
      authContext: null,
    });
    const client = await connectClient(server);
    try {
      const result = await client.callTool({
        name: 'project_get_status',
        arguments: { project_id: uuid() },
      });
      expect(result.isError).toBe(true);
      expect(firstText(result)).toBe('内部错误');
      expect(firstText(result)).not.toContain('TEST_SECRET');
    } finally {
      await client.close();
      await server.close();
    }
    // 捕获日志确实记录了脱敏后的稳定分类（否则断言会空过），且不含原始 message 中的秘密。
    const logText = JSON.stringify(messages);
    expect(logText).toContain('mcp tool internal error');
    expect(logText).toContain('errType');
    expect(logText).not.toContain('TEST_SECRET');
    expect(logText).not.toContain('access_token=');
  });

  it('read-only: repository data is unchanged after all three tools are called', async () => {
    const { server, services } = buildTestServer();
    const { project } = await services.projectService.createProject({ id: uuid(), name: 'Proj' });
    const { stage } = await services.stageService.createStage(project.id, {
      id: uuid(),
      name: 'S1',
      position: 1,
    });
    const { task } = await services.taskRepository.createIfAbsent(
      makeTask({
        projectId: project.id,
        stageId: stage.id,
        position: 1,
      }),
    );
    const before = {
      project: await services.projectRepository.findById(project.id),
      stage: await services.stageRepository.findById(stage.id),
      task: await services.taskRepository.findById(task.id),
    };
    const client = await connectClient(server);
    try {
      await client.callTool({ name: 'project_get_status', arguments: { project_id: project.id } });
      await client.callTool({ name: 'project_list_stages', arguments: { project_id: project.id } });
      await client.callTool({ name: 'project_get_stage', arguments: { stage_id: stage.id } });
    } finally {
      await client.close();
      await server.close();
    }
    expect(await services.projectRepository.findById(project.id)).toEqual(before.project);
    expect(await services.stageRepository.findById(stage.id)).toEqual(before.stage);
    expect(await services.taskRepository.findById(task.id)).toEqual(before.task);
  });

  /** 直接向仓储播种一条 running / paused 会话，返回 sessionId；固定时间用于确定性排序。 */
  async function seedInProgress(
    services: ReturnType<typeof makeServices>,
    overrides: Parameters<typeof makeStudySession>[0] = {},
  ): Promise<string> {
    const defaults = {
      status: 'running' as const,
      startedAt: '2026-01-01T08:00:00.000Z',
      updatedAt: '2026-01-01T08:00:00.000Z',
    };
    const { studySession } = await services.studySessionRepository.createIfAbsent(
      makeStudySession({ ...defaults, ...overrides }),
    );
    return studySession.id;
  }

  it('study_get_current_session returns JSON null when no session is in progress', async () => {
    const { server, services } = buildTestServer();
    // 只有 created 草稿与终态，不算进行中。
    await services.studySessionService.createStudySession({ id: uuid(), timerMode: 'count_up' });
    const client = await connectClient(server);
    try {
      const result = await client.callTool({
        name: 'study_get_current_session',
        arguments: {},
      });
      expect(result.isError).not.toBe(true);
      expect(firstText(result)).toBe('null');
    } finally {
      await client.close();
      await server.close();
    }
  });

  it('study_get_current_session rejects any input fields (strict empty object)', async () => {
    const { server } = buildTestServer();
    const client = await connectClient(server);
    try {
      const withSessionId = await client.callTool({
        name: 'study_get_current_session',
        arguments: { session_id: uuid() },
      });
      expect(withSessionId.isError).toBe(true);
      expect(firstText(withSessionId)).toContain('Unrecognized key');

      const forgedIdentity = await client.callTool({
        name: 'study_get_current_session',
        arguments: { actorId: 'forged', actorType: 'resident_ai' },
      });
      expect(forgedIdentity.isError).toBe(true);
      expect(firstText(forgedIdentity)).toContain('Unrecognized key');
    } finally {
      await client.close();
      await server.close();
    }
  });

  it('study_get_current_session returns the running session four-part aggregation', async () => {
    const { server, services } = buildTestServer();
    const sessionId = await seedInProgress(services);
    const actorId = uuid();
    await services.studyReportRepository.appendReport({
      id: uuid(),
      studySessionId: sessionId,
      actorId,
      content: '当前会话报告',
      submittedAt: '2026-01-01T08:00:00.000Z',
    });
    await services.studyParticipantRepository.upsert(
      makeStudyParticipant({
        studySessionId: sessionId,
        actorId,
        joinedAt: '2026-01-01T08:00:00.000Z',
        lastActiveAt: '2026-01-01T08:00:00.000Z',
      }),
    );
    await services.studySummaryRepository.createIfAbsent(
      makeStudySummary({ studySessionId: sessionId, content: '当前总结' }),
    );
    const client = await connectClient(server);
    try {
      const result = await client.callTool({
        name: 'study_get_current_session',
        arguments: {},
      });
      expect(result.isError).not.toBe(true);
      const parsed = JSON.parse(firstText(result)) as {
        session: { id: string; status: string };
        summary: unknown;
        participants: unknown[];
        reports: unknown[];
      };
      expect(parsed.session.id).toBe(sessionId);
      expect(parsed.session.status).toBe('running');
      expect(parsed.summary).toBeTruthy();
      expect(parsed.participants).toHaveLength(1);
      expect(parsed.reports).toHaveLength(1);
    } finally {
      await client.close();
      await server.close();
    }
  });

  it('study_get_current_session picks the newest by startedAt DESC then updatedAt DESC then id DESC', async () => {
    const { server, services } = buildTestServer();
    // 全部固定 UUID 与固定时间：结果不依赖随机值或 Map 插入顺序。
    await seedInProgress(services, {
      id: '00000000-0000-4000-8000-000000000001',
      startedAt: '2026-01-01T08:00:00.000Z',
      updatedAt: '2026-01-01T08:30:00.000Z',
    });
    await seedInProgress(services, {
      id: '00000000-0000-4000-8000-000000000002',
      startedAt: '2026-01-01T08:00:00.000Z',
      updatedAt: '2026-01-01T09:00:00.000Z',
    });
    await seedInProgress(services, {
      id: '00000000-0000-4000-8000-000000000003',
      status: 'paused',
      startedAt: '2026-01-01T07:00:00.000Z',
      updatedAt: '2026-01-01T07:00:00.000Z',
    });
    const client = await connectClient(server);
    try {
      const result = await client.callTool({
        name: 'study_get_current_session',
        arguments: {},
      });
      expect(result.isError).not.toBe(true);
      const parsed = JSON.parse(firstText(result)) as { session: { id: string } };
      expect(parsed.session.id).toBe('00000000-0000-4000-8000-000000000002');
    } finally {
      await client.close();
      await server.close();
    }
  });

  it('study_get_current_session surfaces dirty in-progress sessions as a sanitized internal error', async () => {
    const services = makeServices();
    const messages: unknown[][] = [];
    const logger = { error: (...args: unknown[]) => void messages.push(args) };
    await services.studySessionRepository.createIfAbsent(
      makeStudySession({
        id: uuid(),
        status: 'running',
        startedAt: 'not-a-time',
        updatedAt: '2026-01-01T08:00:00.000Z',
      }),
    );
    const server = buildMcpServer({
      aiTaskService: services.aiTaskService,
      projectStatusService: services.projectStatusService,
      stageService: services.stageService,
      studySessionDetailService: services.studySessionDetailService,
      studySessionCurrentService: services.studySessionCurrentService,
      studyReportService: services.studyReportService,
      stageUpdateRequestService: services.stageUpdateRequestService,
      projectWorkReportService: services.projectWorkReportService,
      serviceName: 'mingwu-server',
      serviceVersion: '0.1.0',
      logger,
      authContext: null,
    });
    const client = await connectClient(server);
    try {
      const result = await client.callTool({
        name: 'study_get_current_session',
        arguments: {},
      });
      expect(result.isError).toBe(true);
      expect(firstText(result)).toBe('内部错误');
      expect(firstText(result)).not.toContain('not-a-time');
    } finally {
      await client.close();
      await server.close();
    }
    const logText = JSON.stringify(messages);
    expect(logText).toContain('mcp tool internal error');
    expect(logText).toContain('errType');
    expect(logText).not.toContain('not-a-time');
  });

  it('study_get_current_session surfaces an in-progress session with unparseable updatedAt as a sanitized internal error', async () => {
    const services = makeServices();
    const messages: unknown[][] = [];
    const logger = { error: (...args: unknown[]) => void messages.push(args) };
    // startedAt 合法、updatedAt 非法：updatedAt 参与正式选择，脏数据按受控内部错误处理，
    // MCP 响应与日志都不得回显非法值本身。
    await services.studySessionRepository.createIfAbsent(
      makeStudySession({
        id: uuid(),
        status: 'running',
        startedAt: '2026-01-01T08:00:00.000Z',
        updatedAt: 'not-a-time',
      }),
    );
    const server = buildMcpServer({
      aiTaskService: services.aiTaskService,
      projectStatusService: services.projectStatusService,
      stageService: services.stageService,
      studySessionDetailService: services.studySessionDetailService,
      studySessionCurrentService: services.studySessionCurrentService,
      studyReportService: services.studyReportService,
      stageUpdateRequestService: services.stageUpdateRequestService,
      projectWorkReportService: services.projectWorkReportService,
      serviceName: 'mingwu-server',
      serviceVersion: '0.1.0',
      logger,
      authContext: null,
    });
    const client = await connectClient(server);
    try {
      const result = await client.callTool({
        name: 'study_get_current_session',
        arguments: {},
      });
      expect(result.isError).toBe(true);
      expect(firstText(result)).toBe('内部错误');
      expect(firstText(result)).not.toContain('not-a-time');
    } finally {
      await client.close();
      await server.close();
    }
    const logText = JSON.stringify(messages);
    expect(logText).toContain('mcp tool internal error');
    expect(logText).toContain('errType');
    expect(logText).not.toContain('not-a-time');
  });

  it('study_get_current_session is read-only: repeated and concurrent calls never mutate', async () => {
    const { server, services } = buildTestServer();
    const sessionId = await seedInProgress(services);
    await services.studyReportRepository.appendReport({
      id: uuid(),
      studySessionId: sessionId,
      actorId: uuid(),
      content: '只读报告',
      submittedAt: '2026-01-01T08:00:00.000Z',
    });
    const before = {
      session: await services.studySessionRepository.findById(sessionId),
      summary: await services.studySummaryRepository.findByStudySessionId(sessionId),
      participants: await services.studyParticipantRepository.listBySession(sessionId),
      reports: await services.studyReportRepository.listBySession(sessionId),
    };
    const client = await connectClient(server);
    try {
      await Promise.all([
        client.callTool({ name: 'study_get_current_session', arguments: {} }),
        client.callTool({ name: 'study_get_current_session', arguments: {} }),
        client.callTool({ name: 'study_get_current_session', arguments: {} }),
      ]);
      await client.callTool({ name: 'study_get_current_session', arguments: {} });
    } finally {
      await client.close();
      await server.close();
    }
    expect(await services.studySessionRepository.findById(sessionId)).toEqual(before.session);
    expect(await services.studySummaryRepository.findByStudySessionId(sessionId)).toEqual(
      before.summary,
    );
    expect(await services.studyParticipantRepository.listBySession(sessionId)).toEqual(
      before.participants,
    );
    expect(await services.studyReportRepository.listBySession(sessionId)).toEqual(before.reports);
  });
});
