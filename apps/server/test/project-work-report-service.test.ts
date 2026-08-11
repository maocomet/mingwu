import { describe, expect, it } from 'vitest';
import type { ProjectStage, ProjectWorkReport } from '@mingwu/contracts';
import { ProjectWorkReportService } from '../src/application/project-work-report/project-work-report-service.js';
import { StageNotFoundError } from '../src/domain/stage/errors.js';
import {
  ProjectWorkReportScopeCorruptError,
} from '../src/domain/project-work-report/errors.js';
import type { ProjectWorkReportRepository } from '../src/domain/project-work-report/repository.js';
import { makeProjectWorkReport, makeServices, makeStage, uuid } from './helpers.js';

type Services = ReturnType<typeof makeServices>;

/** 假只读仓储：直接返回固定报告，用于复现“存储返回脏数据”的服务端完整性防线。 */
function fakeRepo(reports: ProjectWorkReport[]): ProjectWorkReportRepository {
  return {
    async listByStageId() {
      return reports;
    },
  };
}

/** 在共享仓储中落一条真实 Stage，返回完整对象（报告 seed 必须沿用其 projectId）。 */
async function seedStage(services: Services): Promise<ProjectStage> {
  const stage = makeStage({});
  await services.stageRepository.createIfAbsent(stage);
  return stage;
}

describe('ProjectWorkReportService.listByStage', () => {
  it('throws 404 StageNotFoundError for an unknown stage (empty list is NOT treated as missing)', async () => {
    const services = makeServices();
    await expect(services.projectWorkReportService.listByStage(uuid())).rejects.toBeInstanceOf(
      StageNotFoundError,
    );
  });

  it('returns an empty list for an existing stage with no reports', async () => {
    const services = makeServices();
    const stage = await seedStage(services);
    expect(await services.projectWorkReportService.listByStage(stage.id)).toEqual([]);
  });

  it('returns only reports directly associated with the stage, in stable order (submittedAt DESC, id ASC)', async () => {
    const services = makeServices();
    const stage = await seedStage(services);
    const otherStage = await seedStage(services);
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
    services.projectWorkReportRepository.seed(
      makeProjectWorkReport({
        stageId: stage.id,
        projectId: stage.projectId,
        submittedAt: '2026-08-11T02:00:00.000Z',
      }),
    );
    services.projectWorkReportRepository.seed(
      makeProjectWorkReport({
        stageId: stage.id,
        projectId: stage.projectId,
        submittedAt: '2026-08-11T08:00:00.000Z',
      }),
    );

    const reports = await services.projectWorkReportService.listByStage(stage.id);
    expect(reports).toHaveLength(2);
    // 其他关卡 / 项目级报告不混入。
    expect(reports.every((r) => r.stageId === stage.id)).toBe(true);
    // submittedAt 新到旧。
    expect(reports[0]!.submittedAt).toBe('2026-08-11T08:00:00.000Z');
    expect(reports[1]!.submittedAt).toBe('2026-08-11T02:00:00.000Z');
  });

  it('returns deep copies: mutating the result does not pollute the store', async () => {
    const services = makeServices();
    const stage = await seedStage(services);
    const original = makeProjectWorkReport({
      stageId: stage.id,
      projectId: stage.projectId,
      submittedAt: '2026-08-11T01:00:00.000Z',
    });
    services.projectWorkReportRepository.seed(original);

    const reports = await services.projectWorkReportService.listByStage(stage.id);
    reports[0]!.roundGoal = 'mutated';
    reports[0]!.changedFiles.push('mutated.ts');

    const again = await services.projectWorkReportService.listByStage(stage.id);
    expect(again[0]!.roundGoal).toBe(original.roundGoal);
    expect(again[0]!.changedFiles).toEqual(original.changedFiles);
  });

  it('dirty data: a report whose stageId does not match the requested stage triggers scope corruption (500 error class)', async () => {
    const services = makeServices();
    const stage = await seedStage(services);
    const dirty = makeProjectWorkReport({
      stageId: uuid(),
      projectId: stage.projectId,
      submittedAt: '2026-08-11T01:00:00.000Z',
    });
    const service = new ProjectWorkReportService(fakeRepo([dirty]), services.stageRepository);

    try {
      await service.listByStage(stage.id);
      throw new Error('expected a scope corruption error');
    } catch (err) {
      expect(err).toBeInstanceOf(ProjectWorkReportScopeCorruptError);
      const e = err as ProjectWorkReportScopeCorruptError;
      expect(e.reportId).toBe(dirty.id);
      expect(e.expectedStageId).toBe(stage.id);
      expect(e.expectedProjectId).toBe(stage.projectId);
      expect(e.actualStageId).toBe(dirty.stageId);
      // 错误消息不回显内部 ID，供 app.ts 作为固定 500 响应体。
      expect(e.message).not.toContain(dirty.id);
      expect(e.message).not.toContain(stage.id);
    }
  });

  it('dirty data: a report whose projectId does not match the real Stage project triggers scope corruption (500 error class)', async () => {
    const services = makeServices();
    const stage = await seedStage(services);
    const dirty = makeProjectWorkReport({
      stageId: stage.id,
      projectId: uuid(),
      submittedAt: '2026-08-11T01:00:00.000Z',
    });
    const service = new ProjectWorkReportService(fakeRepo([dirty]), services.stageRepository);

    await expect(service.listByStage(stage.id)).rejects.toBeInstanceOf(
      ProjectWorkReportScopeCorruptError,
    );
    expect(await services.stageRepository.findById(stage.id)).toEqual(stage);
  });
});
