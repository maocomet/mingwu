import { describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ProjectStatusService } from '../src/application/project-status/project-status-service.js';
import { buildMcpServer } from '../src/mcp/mcp-server.js';
import { makeServices, makeTask, uuid } from './helpers.js';

function buildTestServer() {
  const services = makeServices();
  const server = buildMcpServer({
    projectStatusService: services.projectStatusService,
    stageService: services.stageService,
    serviceName: 'mingwu-server',
    serviceVersion: '0.1.0',
    logger: { error: () => undefined },
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
  it('initialize succeeds and exposes exactly the three read-only tools with strict schemas', async () => {
    const { server } = buildTestServer();
    const client = await connectClient(server);
    try {
      const { tools } = await client.listTools();
      expect(tools.map((t) => t.name).sort()).toEqual([
        'project_get_stage',
        'project_get_status',
        'project_list_stages',
      ]);
      // 每个工具都明确只读。
      for (const tool of tools) {
        expect(tool.description).toContain('只读');
      }
      // 严格 input schema：禁止未知字段、只允许指定 UUID 字段。
      for (const tool of tools) {
        const field = tool.name === 'project_get_stage' ? 'stage_id' : 'project_id';
        expect(tool.inputSchema.type).toBe('object');
        expect(tool.inputSchema.additionalProperties).toBe(false);
        expect(tool.inputSchema.required).toEqual([field]);
        const prop = tool.inputSchema.properties?.[field] as Record<string, unknown> | undefined;
        expect(prop?.type).toBe('string');
        expect(prop?.format).toBe('uuid');
      }
      // 不存在任何写工具。
      const names = tools.map((t) => t.name);
      expect(names).not.toContain('project_submit_stage_update');
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
      projectStatusService: throwingStatus,
      stageService: services.stageService,
      serviceName: 'mingwu-server',
      serviceVersion: '0.1.0',
      logger,
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
});
