import { Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import type { ProjectStage } from '@mingwu/contracts';
import type { AppDeps } from '../src/app.js';
import { buildApp } from '../src/app.js';
import type { ProjectWorkReportService } from '../src/application/project-work-report/project-work-report-service.js';
import { ProjectWorkReportScopeCorruptError } from '../src/domain/project-work-report/errors.js';
import { loadConfig } from '../src/config.js';
import {
  makeProjectWorkReport,
  makeServices,
  makeStage,
  uuid,
} from './helpers.js';

type App = ReturnType<typeof buildApp>;
type Services = ReturnType<typeof makeServices>;

function setup(
  overrides: {
    projectWorkReportService?: ProjectWorkReportService;
    logger?: AppDeps['logger'];
  } = {},
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
    stageUpdateRequestService: services.stageUpdateRequestService,
    projectWorkReportService:
      overrides.projectWorkReportService ?? services.projectWorkReportService,
    ...(overrides.logger ? { logger: overrides.logger } : {}),
  });
  return { app, services };
}

/** 用 pino 同步 stream 捕获 Fastify 日志，用于断言范围腐败详情只进日志。 */
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

/** 假服务：按关卡读取时抛范围腐败（stageId 不匹配），用于 API 层 500 断言。 */
function scopeCorruptService(): ProjectWorkReportService {
  return {
    async listByStage() {
      throw new ProjectWorkReportScopeCorruptError(
        'leak-report-1',
        'leak-stage-1',
        'leak-project-1',
        'leak-stage-2',
        'leak-project-1',
      );
    },
  } as unknown as ProjectWorkReportService;
}

/** 在共享仓储中落一条真实 Stage，返回完整对象（报告 seed 必须沿用其 projectId）。 */
async function seedStage(services: Services): Promise<ProjectStage> {
  const stage = makeStage({});
  await services.stageRepository.createIfAbsent(stage);
  return stage;
}

describe('GET /api/v1/stages/:stageId/reports', () => {
  it('returns 404 stage_not_found for an unknown stage', async () => {
    const { app } = setup();
    const res = await app.inject({ method: 'GET', url: `/api/v1/stages/${uuid()}/reports` });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ error: 'stage_not_found' });
  });

  it('returns 400 for a non-uuid stageId (strict params schema)', async () => {
    const { app } = setup();
    const res = await app.inject({ method: 'GET', url: '/api/v1/stages/not-a-uuid/reports' });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: 'validation_failed' });
  });

  it('returns 200 with an empty list for an existing stage with no reports', async () => {
    const { app, services } = setup();
    const stage = await seedStage(services);
    const res = await app.inject({ method: 'GET', url: `/api/v1/stages/${stage.id}/reports` });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ reports: [] });
  });

  it('returns only directly-associated reports in stable order (submittedAt DESC, id ASC), no cross-stage / project-level leakage', async () => {
    const { app, services } = setup();
    const stage = await seedStage(services);
    const otherStage = await seedStage(services);
    // 同一时间两条：id 升序兜底。
    const lowId = makeProjectWorkReport({
      id: '00000000-0000-4000-8000-000000000001',
      stageId: stage.id,
      projectId: stage.projectId,
      submittedAt: '2026-08-11T05:00:00.000Z',
      roundGoal: 'low-id',
    });
    const highId = makeProjectWorkReport({
      id: '00000000-0000-4000-8000-000000000002',
      stageId: stage.id,
      projectId: stage.projectId,
      submittedAt: '2026-08-11T05:00:00.000Z',
      roundGoal: 'high-id',
    });
    const newest = makeProjectWorkReport({
      stageId: stage.id,
      projectId: stage.projectId,
      submittedAt: '2026-08-11T08:00:00.000Z',
      roundGoal: 'newest',
    });
    services.projectWorkReportRepository.seed(lowId);
    services.projectWorkReportRepository.seed(highId);
    services.projectWorkReportRepository.seed(newest);
    // 其他关卡与项目级报告不混入。
    services.projectWorkReportRepository.seed(
      makeProjectWorkReport({
        stageId: otherStage.id,
        projectId: otherStage.projectId,
        submittedAt: '2026-08-11T09:00:00.000Z',
      }),
    );
    services.projectWorkReportRepository.seed(
      makeProjectWorkReport({ stageId: null, submittedAt: '2026-08-11T09:00:00.000Z' }),
    );

    const res = await app.inject({ method: 'GET', url: `/api/v1/stages/${stage.id}/reports` });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { reports: Array<{ id: string; roundGoal: string }> };
    expect(body.reports.map((r) => r.id)).toEqual([newest.id, lowId.id, highId.id]);
    expect(body.reports.map((r) => r.roundGoal)).toEqual(['newest', 'low-id', 'high-id']);
  });

  it('strict response schema: every report field is declared, no extra content is serialized', async () => {
    const { app, services } = setup();
    const stage = await seedStage(services);
    const report = makeProjectWorkReport({
      stageId: stage.id,
      projectId: stage.projectId,
      submittedAt: '2026-08-11T01:00:00.000Z',
      roundGoal: '严格响应契约',
    });
    services.projectWorkReportRepository.seed(report);

    const res = await app.inject({ method: 'GET', url: `/api/v1/stages/${stage.id}/reports` });
    expect(res.statusCode).toBe(200);
    // toEqual 校验键集合完全一致：任何未声明字段都会让整对象不相等。
    expect(res.json()).toEqual({ reports: [report] });
  });

  it('cross-project dirty data: controlled 500 project_work_report_scope_corrupt, internal IDs only in the log, never in the response', async () => {
    const { logger, text } = createLogCapture();
    const { app, services } = setup({ logger });
    const stage = await seedStage(services);
    const stageId = stage.id;
    const dirtyId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    services.projectWorkReportRepository.seed(
      makeProjectWorkReport({
        id: dirtyId,
        stageId,
        projectId: uuid(),
        submittedAt: '2026-08-11T01:00:00.000Z',
      }),
    );
    // 归属仍正确，仅项目不一致（与正式 Stage 的 projectId 不匹配）。
    expect(stage.projectId).not.toBe(
      (services.store.projectWorkReports.get(dirtyId) as { projectId: string }).projectId,
    );

    const res = await app.inject({ method: 'GET', url: `/api/v1/stages/${stageId}/reports` });
    expect(res.statusCode).toBe(500);
    expect(res.json()).toEqual({
      error: 'project_work_report_scope_corrupt',
      message: 'project work report scope is inconsistent',
    });
    // 内部 ID 不进入响应体。
    expect(res.body).not.toContain(dirtyId);
    expect(res.body).not.toContain(stageId);
    // 明细只进服务端日志。
    expect(text()).toContain(dirtyId);
  });

  it('stageId-mismatch dirty data via a fake service: controlled 500 with no ID leakage', async () => {
    const { logger, text } = createLogCapture();
    const { app } = setup({ projectWorkReportService: scopeCorruptService(), logger });

    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/stages/${uuid()}/reports`,
    });
    expect(res.statusCode).toBe(500);
    expect(res.json()).toEqual({
      error: 'project_work_report_scope_corrupt',
      message: 'project work report scope is inconsistent',
    });
    expect(res.body).not.toContain('leak-report-1');
    expect(res.body).not.toContain('leak-stage-1');
    expect(res.body).not.toContain('leak-project-1');
    expect(text()).toContain('leak-report-1');
  });
});

describe('GET real-HTTP smoke (127.0.0.1, ephemeral port)', () => {
  async function startServer(): Promise<{ app: App; baseUrl: string; services: Services }> {
    const { app, services } = setup();
    await app.listen({ host: '127.0.0.1', port: 0 });
    const address = app.server.address();
    if (address === null || typeof address === 'string') {
      throw new Error('expected a TCP address object from app.server.address()');
    }
    const baseUrl = `http://127.0.0.1:${address.port}`;
    return { app, baseUrl, services };
  }

  it('real socket: lists stage reports in stable order', async () => {
    const { app, baseUrl, services } = await startServer();
    try {
      const stage = makeStage({});
      await services.stageRepository.createIfAbsent(stage);
      services.projectWorkReportRepository.seed(
        makeProjectWorkReport({
          stageId: stage.id,
          projectId: stage.projectId,
          submittedAt: '2026-08-11T02:00:00.000Z',
          roundGoal: '真实 socket 冒烟',
        }),
      );
      const res = await fetch(`${baseUrl}/api/v1/stages/${stage.id}/reports`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { reports: Array<{ stageId: string; roundGoal: string }> };
      expect(body.reports).toHaveLength(1);
      expect(body.reports[0]!.stageId).toBe(stage.id);
      expect(body.reports[0]!.roundGoal).toBe('真实 socket 冒烟');
    } finally {
      await app.close();
    }
  });
});
