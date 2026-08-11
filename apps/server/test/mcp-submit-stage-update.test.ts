import { describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  STAGE_UPDATE_REASON_MAX_LENGTH,
  type AiActorType,
  type ProjectStage,
  type StageUpdateRequest,
} from '@mingwu/contracts';
import type { StageUpdateRequestService } from '../src/application/stage-update-request/stage-update-request-service.js';
import type { McpAuthContext } from '../src/domain/mcp-auth/mcp-auth-context.js';
import { buildMcpServer, type McpLogger } from '../src/mcp/mcp-server.js';
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
  stageUpdateRequestService?: StageUpdateRequestService;
  logger?: McpLogger;
}

function buildTestServer(opts: BuildOptions = {}) {
  const services = opts.services ?? makeServices();
  const server = buildMcpServer({
    projectStatusService: services.projectStatusService,
    stageService: services.stageService,
    studySessionDetailService: services.studySessionDetailService,
    studySessionCurrentService: services.studySessionCurrentService,
    studyReportService: services.studyReportService,
    stageUpdateRequestService: opts.stageUpdateRequestService ?? services.stageUpdateRequestService,
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
  const client = new Client({ name: 'submit-stage-update-test-client', version: '0.0.1' });
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

/** 共享仓储：创建项目与一个初始关卡（status=not_started, version=1）。 */
async function seedStage(services: Services): Promise<ProjectStage> {
  const projectId = uuid();
  await services.projectService.createProject({ id: projectId, name: '申请工具项目' });
  const { stage } = await services.stageService.createStage(projectId, {
    id: uuid(),
    name: '第一关',
    position: 1,
  });
  return stage;
}

/** 读取关卡当前 status 与 version，断言在申请前后完全不变。 */
async function stageSnapshot(services: Services, stageId: string) {
  const stage = await services.stageRepository.findById(stageId);
  if (!stage) {
    throw new Error('stage should exist');
  }
  return { status: stage.status, version: stage.version };
}
describe('MCP project_submit_stage_update write tool', () => {
  it('is listed by tools/list; resident_ai with default profile submits a pending request attributed to the bound actor', async () => {
    const { server, services } = buildTestServer({
      authContext: authContextFor(AUTH_FIXTURES.actorA.actorId, 'resident_ai'),
    });
    const stage = await seedStage(services);
    const client = await connectClient(server);
    try {
      const { tools } = await client.listTools();
      expect(tools.some((t) => t.name === 'project_submit_stage_update')).toBe(true);

      const requestId = uuid();
      const result = await client.callTool({
        name: 'project_submit_stage_update',
        arguments: {
          request_id: requestId,
          stage_id: stage.id,
          expected_stage_version: 1,
          proposed_status: 'in_progress',
          reason: '完成第一关学习，申请进入下一阶段',
        },
      });
      expect(result.isError).not.toBe(true);
      const request = JSON.parse(firstText(result)) as StageUpdateRequest;
      expect(request.id).toBe(requestId);
      expect(request.stageId).toBe(stage.id);
      expect(request.projectId).toBe(stage.projectId);
      expect(request.requesterActorId).toBe(AUTH_FIXTURES.actorA.actorId);
      expect(request.expectedStageVersion).toBe(1);
      expect(request.proposedStatus).toBe('in_progress');
      expect(request.status).toBe('pending');
      expect(typeof request.createdAt).toBe('string');
      // 成功结果不得回显 token / connectionId / permissionProfile。
      const serialized = firstText(result);
      expect(serialized).not.toContain(AUTH_FIXTURES.connection1.token);
      expect(serialized).not.toContain(AUTH_FIXTURES.connection1.connectionId);
      expect(serialized).not.toContain('permissionProfile');

      // 服务读回与 MCP 返回一致，且 Stage 完全未变化。
      const read = await services.stageUpdateRequestService.getById(requestId);
      expect(read).toEqual(request);
      expect(await stageSnapshot(services, stage.id)).toEqual({
        status: 'not_started',
        version: 1,
      });
    } finally {
      await client.close();
      await server.close();
    }
  });

  it('temporary_ai submits under default profile; reviewer / unknown profile / anonymous are rejected with zero writes', async () => {
    const services = makeServices();
    const stage = await seedStage(services);

    // temporary_ai 在 default 权限下允许提交。
    const temp = buildTestServer({
      services,
      authContext: authContextFor(uuid(), 'temporary_ai'),
    });
    const tempClient = await connectClient(temp.server);
    try {
      const ok = await tempClient.callTool({
        name: 'project_submit_stage_update',
        arguments: {
          request_id: uuid(),
          stage_id: stage.id,
          expected_stage_version: 1,
          proposed_status: 'in_progress',
          reason: '临时 AI 申请',
        },
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
        name: 'project_submit_stage_update',
        arguments: {
          request_id: uuid(),
          stage_id: stage.id,
          expected_stage_version: 1,
          proposed_status: 'in_progress',
          reason: 'reviewer 申请',
        },
      });
      expect(denied.isError).toBe(true);
      expect(firstText(denied)).toBe('当前身份无权提交关卡更新申请');
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
        name: 'project_submit_stage_update',
        arguments: {
          request_id: uuid(),
          stage_id: stage.id,
          expected_stage_version: 1,
          proposed_status: 'in_progress',
          reason: 'admin 申请',
        },
      });
      expect(denied.isError).toBe(true);
      expect(firstText(denied)).toBe('当前身份无权提交关卡更新申请');
    } finally {
      await profileClient.close();
      await unknownProfile.server.close();
    }

    // 匿名只读上下文：工具可见但写入 fail-closed 拒绝。
    const anon = buildTestServer({ services, authContext: null });
    const anonClient = await connectClient(anon.server);
    try {
      const { tools } = await anonClient.listTools();
      expect(tools.some((t) => t.name === 'project_submit_stage_update')).toBe(true);
      const denied = await anonClient.callTool({
        name: 'project_submit_stage_update',
        arguments: {
          request_id: uuid(),
          stage_id: stage.id,
          expected_stage_version: 1,
          proposed_status: 'in_progress',
          reason: '匿名申请',
        },
      });
      expect(denied.isError).toBe(true);
      expect(firstText(denied)).toBe('当前连接未授权写操作');
    } finally {
      await anonClient.close();
      await anon.server.close();
    }

    // 只有 temporary_ai 那一条成功写入：其余全部零写入，Stage 未变化。
    const requests = await services.stageUpdateRequestRepository.listByStage(stage.id);
    expect(requests).toHaveLength(1);
    expect(requests[0]!.reason).toBe('临时 AI 申请');
    expect(await stageSnapshot(services, stage.id)).toEqual({ status: 'not_started', version: 1 });
  });

  it('rejects smuggled identity / project / decision fields without writing', async () => {
    const { server, services } = buildTestServer({
      authContext: authContextFor(AUTH_FIXTURES.actorA.actorId, 'resident_ai'),
    });
    const stage = await seedStage(services);
    const client = await connectClient(server);
    try {
      const result = await client.callTool({
        name: 'project_submit_stage_update',
        arguments: {
          request_id: uuid(),
          stage_id: stage.id,
          expected_stage_version: 1,
          proposed_status: 'in_progress',
          reason: '正常理由',
          projectId: uuid(),
          project_id: uuid(),
          actorId: '00000000-0000-4000-8000-000000000099',
          actor_id: '00000000-0000-4000-8000-000000000098',
          actorCode: 'forged-actor',
          requesterActorId: '00000000-0000-4000-8000-000000000097',
          status: 'approved',
          approvedBy: 'xiaomiao',
          decidedAt: '2026-01-01T00:00:00.000Z',
        },
      });
      // 严格 schema 拒绝额外字段。
      expect(result.isError).toBe(true);
      // 零写入：不产生任何申请，Stage 未变化。
      expect(await services.stageUpdateRequestRepository.listByStage(stage.id)).toHaveLength(0);
      expect(await stageSnapshot(services, stage.id)).toEqual({ status: 'not_started', version: 1 });
    } finally {
      await client.close();
      await server.close();
    }
  });

  it('maps missing stage, stale version, invalid status, blank/too-long reason to controlled errors with zero writes', async () => {
    const { server, services } = buildTestServer({
      authContext: authContextFor(AUTH_FIXTURES.actorA.actorId, 'resident_ai'),
    });
    const stage = await seedStage(services);
    const client = await connectClient(server);
    try {
      // Stage 不存在。
      const missing = await client.callTool({
        name: 'project_submit_stage_update',
        arguments: {
          request_id: uuid(),
          stage_id: uuid(),
          expected_stage_version: 1,
          proposed_status: 'in_progress',
          reason: '理由',
        },
      });
      expect(missing.isError).toBe(true);
      expect(firstText(missing)).toBe('关卡不存在');

      // 版本陈旧。
      const stale = await client.callTool({
        name: 'project_submit_stage_update',
        arguments: {
          request_id: uuid(),
          stage_id: stage.id,
          expected_stage_version: 99,
          proposed_status: 'in_progress',
          reason: '理由',
        },
      });
      expect(stale.isError).toBe(true);
      expect(firstText(stale)).toBe('关卡版本已变化，请刷新后重试');

      // 非法目标状态：入口 enum 白名单先行拒绝（不进入服务，也不产生申请）。
      const badStatus = await client.callTool({
        name: 'project_submit_stage_update',
        arguments: {
          request_id: uuid(),
          stage_id: stage.id,
          expected_stage_version: 1,
          proposed_status: 'not_a_status',
          reason: '理由',
        },
      });
      expect(badStatus.isError).toBe(true);

      // 纯空白理由。
      const blank = await client.callTool({
        name: 'project_submit_stage_update',
        arguments: {
          request_id: uuid(),
          stage_id: stage.id,
          expected_stage_version: 1,
          proposed_status: 'in_progress',
          reason: '   ',
        },
      });
      expect(blank.isError).toBe(true);
      expect(firstText(blank)).toBe('申请理由不合法');

      // Unicode 上界：恰好上限个 code point 允许。
      const exact = await client.callTool({
        name: 'project_submit_stage_update',
        arguments: {
          request_id: uuid(),
          stage_id: stage.id,
          expected_stage_version: 1,
          proposed_status: 'in_progress',
          reason: '😀'.repeat(STAGE_UPDATE_REASON_MAX_LENGTH),
        },
      });
      expect(exact.isError).not.toBe(true);

      // 超过上界 → 拒绝。
      const tooLong = await client.callTool({
        name: 'project_submit_stage_update',
        arguments: {
          request_id: uuid(),
          stage_id: stage.id,
          expected_stage_version: 1,
          proposed_status: 'in_progress',
          reason: '😀'.repeat(STAGE_UPDATE_REASON_MAX_LENGTH + 1),
        },
      });
      expect(tooLong.isError).toBe(true);

      // 首尾带空白、trim 后恰好上限 → 允许，保存为规范化理由。
      const padded = await client.callTool({
        name: 'project_submit_stage_update',
        arguments: {
          request_id: uuid(),
          stage_id: stage.id,
          expected_stage_version: 1,
          proposed_status: 'in_progress',
          reason: `  ${'中'.repeat(STAGE_UPDATE_REASON_MAX_LENGTH)}  `,
        },
      });
      expect(padded.isError).not.toBe(true);

      // 只成功写入三条（exact 与 padded，加一次：blank 不写入），Stage 未变化。
      const requests = await services.stageUpdateRequestRepository.listByStage(stage.id);
      expect(requests).toHaveLength(2);
      expect(await stageSnapshot(services, stage.id)).toEqual({ status: 'not_started', version: 1 });
    } finally {
      await client.close();
      await server.close();
    }
  });

  it('same request_id with same semantics retries idempotently; different semantics conflict without overwriting', async () => {
    const { server, services } = buildTestServer({
      authContext: authContextFor(AUTH_FIXTURES.actorA.actorId, 'resident_ai'),
    });
    const stage = await seedStage(services);
    const client = await connectClient(server);
    try {
      const requestId = uuid();
      const first = await client.callTool({
        name: 'project_submit_stage_update',
        arguments: {
          request_id: requestId,
          stage_id: stage.id,
          expected_stage_version: 1,
          proposed_status: 'in_progress',
          reason: '同理由',
        },
      });
      expect(first.isError).not.toBe(true);

      // 同 id + 同 Stage + 同 Actor + 同版本 + 同状态 + 同规范化理由（排版差异）→ 幂等成功。
      const retry = await client.callTool({
        name: 'project_submit_stage_update',
        arguments: {
          request_id: requestId,
          stage_id: stage.id,
          expected_stage_version: 1,
          proposed_status: 'in_progress',
          reason: '  同理由  ',
        },
      });
      expect(retry.isError).not.toBe(true);
      const retryRequest = JSON.parse(firstText(retry)) as StageUpdateRequest;
      expect(retryRequest.id).toBe(requestId);
      expect(retryRequest.createdAt).toBe((JSON.parse(firstText(first)) as StageUpdateRequest).createdAt);
      expect(await services.stageUpdateRequestRepository.listByStage(stage.id)).toHaveLength(1);

      // 同 id 不同理由 → 受控冲突。
      const conflictReason = await client.callTool({
        name: 'project_submit_stage_update',
        arguments: {
          request_id: requestId,
          stage_id: stage.id,
          expected_stage_version: 1,
          proposed_status: 'in_progress',
          reason: '不同理由',
        },
      });
      expect(conflictReason.isError).toBe(true);
      expect(firstText(conflictReason)).toBe('申请已存在且语义冲突，不覆盖旧申请');

      // 同 id 不同目标状态 → 受控冲突。
      const conflictStatus = await client.callTool({
        name: 'project_submit_stage_update',
        arguments: {
          request_id: requestId,
          stage_id: stage.id,
          expected_stage_version: 1,
          proposed_status: 'pending_review',
          reason: '同理由',
        },
      });
      expect(conflictStatus.isError).toBe(true);
      expect(firstText(conflictStatus)).toBe('申请已存在且语义冲突，不覆盖旧申请');

      // 同 id 不同 Stage → 受控冲突。
      const stage2 = await seedStage(services);
      const conflictStage = await client.callTool({
        name: 'project_submit_stage_update',
        arguments: {
          request_id: requestId,
          stage_id: stage2.id,
          expected_stage_version: 1,
          proposed_status: 'in_progress',
          reason: '同理由',
        },
      });
      expect(conflictStage.isError).toBe(true);
      expect(firstText(conflictStage)).toBe('申请已存在且语义冲突，不覆盖旧申请');

      // 同 id 不同 Actor → 受控冲突。
      const connB = buildTestServer({
        services,
        authContext: authContextFor(AUTH_FIXTURES.actorB.actorId, 'resident_ai'),
      });
      const cB = await connectClient(connB.server);
      try {
        const conflictActor = await cB.callTool({
          name: 'project_submit_stage_update',
          arguments: {
            request_id: requestId,
            stage_id: stage.id,
            expected_stage_version: 1,
            proposed_status: 'in_progress',
            reason: '同理由',
          },
        });
        expect(conflictActor.isError).toBe(true);
        expect(firstText(conflictActor)).toBe('申请已存在且语义冲突，不覆盖旧申请');
      } finally {
        await cB.close();
        await connB.server.close();
      }

      // 旧申请从未被覆盖，仍只有一份，Stage 未变化。
      expect(await services.stageUpdateRequestRepository.listByStage(stage.id)).toHaveLength(1);
      expect(await stageSnapshot(services, stage.id)).toEqual({ status: 'not_started', version: 1 });
    } finally {
      await client.close();
      await server.close();
    }
  });

  it('retries idempotently after the stage advances to v2; differing semantics conflict and are not masked by the stage state', async () => {
    const { server, services } = buildTestServer({
      authContext: authContextFor(AUTH_FIXTURES.actorA.actorId, 'resident_ai'),
    });
    const stage = await seedStage(services);
    const client = await connectClient(server);
    try {
      const requestId = uuid();
      const args = {
        request_id: requestId,
        stage_id: stage.id,
        expected_stage_version: 1,
        proposed_status: 'in_progress',
        reason: '同理由',
      };
      const first = await client.callTool({
        name: 'project_submit_stage_update',
        arguments: args,
      });
      expect(first.isError).not.toBe(true);
      const firstRequest = JSON.parse(firstText(first)) as StageUpdateRequest;
      expect(firstRequest.expectedStageVersion).toBe(1);

      // 正式关卡正常推进到 v2。
      await services.stageService.setStageStatus(stage.id, {
        status: 'in_progress',
        expectedVersion: 1,
      });
      expect((await services.stageRepository.findById(stage.id))?.version).toBe(2);

      // 完全相同请求（仍带 expected_stage_version=1）重试：幂等返回原申请，不报版本冲突。
      const retry = await client.callTool({
        name: 'project_submit_stage_update',
        arguments: args,
      });
      expect(retry.isError).not.toBe(true);
      expect(JSON.parse(firstText(retry))).toEqual(firstRequest);

      // 同 id 不同理由 → 明确冲突，不被当前 Stage 状态掩盖。
      const reasonConflict = await client.callTool({
        name: 'project_submit_stage_update',
        arguments: { ...args, reason: '不同理由' },
      });
      expect(reasonConflict.isError).toBe(true);
      expect(firstText(reasonConflict)).toBe('申请已存在且语义冲突，不覆盖旧申请');

      // 同 id 不同目标状态 → 明确冲突。
      const statusConflict = await client.callTool({
        name: 'project_submit_stage_update',
        arguments: { ...args, proposed_status: 'completed' },
      });
      expect(statusConflict.isError).toBe(true);
      expect(firstText(statusConflict)).toBe('申请已存在且语义冲突，不覆盖旧申请');

      // 同 id 且 expected_stage_version=2（现在正好等于当前版本）→ 仍是幂等语义冲突。
      const versionConflict = await client.callTool({
        name: 'project_submit_stage_update',
        arguments: { ...args, expected_stage_version: 2 },
      });
      expect(versionConflict.isError).toBe(true);
      expect(firstText(versionConflict)).toBe('申请已存在且语义冲突，不覆盖旧申请');

      // 只有一条申请且未被覆盖；正式 Stage 保持 v2。
      expect(await services.stageUpdateRequestRepository.listByStage(stage.id)).toHaveLength(1);
      expect(await stageSnapshot(services, stage.id)).toEqual({ status: 'in_progress', version: 2 });
    } finally {
      await client.close();
      await server.close();
    }
  });

  it('20 concurrent same-id submissions create exactly one request', async () => {
    const { server, services } = buildTestServer({
      authContext: authContextFor(AUTH_FIXTURES.actorA.actorId, 'resident_ai'),
    });
    const stage = await seedStage(services);
    const client = await connectClient(server);
    try {
      const requestId = uuid();
      const results = await Promise.all(
        Array.from({ length: 20 }, (_, i) =>
          client.callTool({
            name: 'project_submit_stage_update',
            arguments: {
              request_id: requestId,
              stage_id: stage.id,
              expected_stage_version: 1,
              proposed_status: 'in_progress',
              reason: `并发理由 ${i}`,
            },
          }),
        ),
      );
      // 不同理由的同 id 并发：恰好一条成功，其余 19 条全部是明确的幂等语义冲突
      // 文本，而非任意错误；绝不产生两条不同申请。
      const successes = results.filter((r) => r.isError !== true);
      const conflicts = results.filter(
        (r) => r.isError === true && firstText(r) === '申请已存在且语义冲突，不覆盖旧申请',
      );
      expect(successes.length).toBe(1);
      expect(conflicts.length).toBe(19);
      const requests = await services.stageUpdateRequestRepository.listByStage(stage.id);
      expect(requests).toHaveLength(1);
      expect(await stageSnapshot(services, stage.id)).toEqual({ status: 'not_started', version: 1 });
    } finally {
      await client.close();
      await server.close();
    }
  });

  it('sanitizes an unknown submit exception: generic result, log without raw message or secret', async () => {
    const capture = createLogCapture();
    const services = makeServices();
    const throwingService = {
      submit: async () => {
        throw new Error('boom password=SUBMIT_SECRET leaked');
      },
    } as unknown as StageUpdateRequestService;
    const { server } = buildTestServer({
      services,
      stageUpdateRequestService: throwingService,
      authContext: authContextFor(AUTH_FIXTURES.actorA.actorId, 'resident_ai'),
      logger: capture.logger,
    });
    const client = await connectClient(server);
    try {
      const result = await client.callTool({
        name: 'project_submit_stage_update',
        arguments: {
          request_id: uuid(),
          stage_id: uuid(),
          expected_stage_version: 1,
          proposed_status: 'in_progress',
          reason: '正文',
        },
      });
      expect(result.isError).toBe(true);
      expect(firstText(result)).toBe('内部错误');
      expect(firstText(result)).not.toContain('SUBMIT_SECRET');
      const logText = capture.text();
      expect(logText).not.toContain('SUBMIT_SECRET');
      expect(logText).not.toContain('boom');
      expect(logText).toContain('mcp tool internal error');
    } finally {
      await client.close();
      await server.close();
    }
  });
});
