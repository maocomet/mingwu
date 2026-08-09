import { describe, expect, it } from 'vitest';
import type { ProjectTask, ProjectTaskStatus } from '@mingwu/contracts';
import { ProjectTaskTreeCorruptionError } from '../src/domain/project-task/errors.js';
import { makeServices, makeTask, uuid } from './helpers.js';

async function createProject(): Promise<{ services: ReturnType<typeof makeServices>; projectId: string }> {
  const services = makeServices();
  const { project } = await services.projectService.createProject({ id: uuid(), name: 'Proj' });
  return { services, projectId: project.id };
}

async function createStage(
  services: ReturnType<typeof makeServices>,
  projectId: string,
  overrides: { name?: string; position?: number; status?: 'completed' } = {},
): Promise<{ id: string }> {
  const { stage } = await services.stageService.createStage(projectId, {
    id: uuid(),
    name: overrides.name ?? 'Stage',
    position: overrides.position,
  });
  if (overrides.status === 'completed') {
    await services.stageService.setStageStatus(stage.id, {
      expectedVersion: stage.version,
      status: 'completed',
    });
  }
  return { id: stage.id };
}

/**
 * 本批未实现任务状态修改接口，测试通过仓储直接注入指定状态的任务
 * （仓储不校验 projectId / stageId 归属，校验由本服务在聚合时负责）。
 */
function injectTask(
  services: ReturnType<typeof makeServices>,
  overrides: Partial<ProjectTask> = {},
): Promise<ProjectTask> {
  return services.taskRepository.createIfAbsent(makeTask(overrides)).then((r) => r.task);
}

describe('ProjectStatusService', () => {
  it('empty project: currentStage null, full zero counts and progress 0', async () => {
    const { services, projectId } = await createProject();
    const status = await services.projectStatusService.getStatus(projectId);
    expect(status.project).toEqual({ id: projectId, name: 'Proj', status: 'active', version: 1 });
    expect(status.currentStage).toBeNull();
    expect(status.stageSummary).toEqual({
      total: 0,
      completed: 0,
      byStatus: {
        locked: 0,
        not_started: 0,
        in_progress: 0,
        pending_review: 0,
        needs_changes: 0,
        blocked: 0,
        completed: 0,
      },
    });
    expect(status.taskSummary).toEqual({
      total: 0,
      completed: 0,
      byStatus: {
        not_started: 0,
        in_progress: 0,
        pending_review: 0,
        needs_changes: 0,
        blocked: 0,
        completed: 0,
      },
    });
    expect(status.overallProgressPercent).toBe(0);
    expect(status.activeTasks).toEqual([]);
  });

  it('uses stage completion when only stages exist, then switches to task completion', async () => {
    const { services, projectId } = await createProject();
    await createStage(services, projectId, { name: 'S1', position: 1 });
    await createStage(services, projectId, { name: 'S2', position: 2 });
    await createStage(services, projectId, { name: 'S3', position: 3, status: 'completed' });

    const stageOnly = await services.projectStatusService.getStatus(projectId);
    expect(stageOnly.stageSummary.total).toBe(3);
    expect(stageOnly.stageSummary.completed).toBe(1);
    // 1/3 关卡完成 → 33（四舍五入）
    expect(stageOnly.overallProgressPercent).toBe(33);

    // 添加正式任务后，进度切换到任务完成率（2/4 → 50）。
    const stage = await services.stageRepository.listByProject(projectId);
    for (const [position, completed] of [
      [1, false],
      [2, true],
      [3, false],
      [4, true],
    ] as const) {
      await injectTask(services, {
        projectId,
        stageId: stage[0]!.id,
        title: `T${position}`,
        position,
        status: completed ? 'completed' : 'not_started',
        completedAt: completed ? new Date().toISOString() : null,
      });
    }

    const withTasks = await services.projectStatusService.getStatus(projectId);
    expect(withTasks.taskSummary.total).toBe(4);
    expect(withTasks.taskSummary.completed).toBe(2);
    expect(withTasks.overallProgressPercent).toBe(50);
  });

  it('rounds task-based progress to the nearest integer', async () => {
    const oneOfThree = await createProject();
    const stageA = await createStage(oneOfThree.services, oneOfThree.projectId, { position: 1 });
    for (const [position, completed] of [
      [1, true],
      [2, false],
      [3, false],
    ] as const) {
      await injectTask(oneOfThree.services, {
        projectId: oneOfThree.projectId,
        stageId: stageA.id,
        title: `T${position}`,
        position,
        status: completed ? 'completed' : 'not_started',
        completedAt: completed ? new Date().toISOString() : null,
      });
    }
    expect(
      (await oneOfThree.services.projectStatusService.getStatus(oneOfThree.projectId))
        .overallProgressPercent,
    ).toBe(33);

    const twoOfThree = await createProject();
    const stageB = await createStage(twoOfThree.services, twoOfThree.projectId, { position: 1 });
    for (const [position, completed] of [
      [1, true],
      [2, true],
      [3, false],
    ] as const) {
      await injectTask(twoOfThree.services, {
        projectId: twoOfThree.projectId,
        stageId: stageB.id,
        title: `T${position}`,
        position,
        status: completed ? 'completed' : 'not_started',
        completedAt: completed ? new Date().toISOString() : null,
      });
    }
    expect(
      (await twoOfThree.services.projectStatusService.getStatus(twoOfThree.projectId))
        .overallProgressPercent,
    ).toBe(67);
  });

  it('produces complete byStatus counts for all seven stage statuses and six task statuses', async () => {
    const { services, projectId } = await createProject();
    const stageStatuses = [
      'locked',
      'not_started',
      'in_progress',
      'pending_review',
      'needs_changes',
      'blocked',
      'completed',
    ] as const;
    let position = 1;
    for (const status of stageStatuses) {
      const { stage } = await services.stageService.createStage(projectId, {
        id: uuid(),
        name: status,
        position,
      });
      position += 1;
      // not_started 是创建默认值，其余状态显式设置。
      if (status !== 'not_started') {
        await services.stageService.setStageStatus(stage.id, {
          expectedVersion: stage.version,
          status,
        });
      }
    }

    const firstStage = (await services.stageRepository.listByProject(projectId))[0]!;
    const taskStatuses: ProjectTaskStatus[] = [
      'not_started',
      'in_progress',
      'pending_review',
      'needs_changes',
      'blocked',
      'completed',
    ];
    let taskPosition = 1;
    for (const status of taskStatuses) {
      await injectTask(services, {
        projectId,
        stageId: firstStage.id,
        title: status,
        position: taskPosition,
        status,
        completedAt: status === 'completed' ? new Date().toISOString() : null,
      });
      taskPosition += 1;
    }

    const status = await services.projectStatusService.getStatus(projectId);
    expect(status.stageSummary.total).toBe(7);
    expect(status.stageSummary.completed).toBe(1);
    expect(status.stageSummary.byStatus).toEqual({
      locked: 1,
      not_started: 1,
      in_progress: 1,
      pending_review: 1,
      needs_changes: 1,
      blocked: 1,
      completed: 1,
    });
    expect(status.taskSummary.total).toBe(6);
    expect(status.taskSummary.completed).toBe(1);
    expect(status.taskSummary.byStatus).toEqual({
      not_started: 1,
      in_progress: 1,
      pending_review: 1,
      needs_changes: 1,
      blocked: 1,
      completed: 1,
    });
  });

  describe('currentStage selection', () => {
    it('prefers the smallest-position active stage over a smaller-position not_started stage', async () => {
      const { services, projectId } = await createProject();
      const { stage: ns } = await services.stageService.createStage(projectId, { id: uuid(), name: 'NS1', position: 1 });
      const { stage: ip } = await services.stageService.createStage(projectId, { id: uuid(), name: 'IP', position: 2 });
      await services.stageService.createStage(projectId, { id: uuid(), name: 'IP2', position: 5 });
      await services.stageService.setStageStatus(ip.id, { expectedVersion: ip.version, status: 'in_progress' });
      const status = await services.projectStatusService.getStatus(projectId);
      // 位置更小的 not_started 不敌任何 active 状态
      void ns;
      expect(status.currentStage?.id).toBe(ip.id);
      expect(status.currentStage?.name).toBe('IP');
      expect(status.currentStage?.status).toBe('in_progress');
    });

    it('picks the smallest position among active statuses', async () => {
      const { services, projectId } = await createProject();
      const { stage: ip2 } = await services.stageService.createStage(projectId, { id: uuid(), name: 'IP2', position: 5 });
      const { stage: ip1 } = await services.stageService.createStage(projectId, { id: uuid(), name: 'IP1', position: 2 });
      await services.stageService.setStageStatus(ip1.id, { expectedVersion: ip1.version, status: 'in_progress' });
      await services.stageService.setStageStatus(ip2.id, { expectedVersion: ip2.version, status: 'blocked' });
      const status = await services.projectStatusService.getStatus(projectId);
      expect(status.currentStage?.id).toBe(ip1.id);
    });

    it('falls back to the smallest-position not_started stage when nothing is active', async () => {
      const { services, projectId } = await createProject();
      await services.stageService.createStage(projectId, { id: uuid(), name: 'A', position: 3 });
      const { stage: ns } = await services.stageService.createStage(projectId, { id: uuid(), name: 'B', position: 1 });
      await services.stageService.createStage(projectId, { id: uuid(), name: 'C', position: 2 });
      const status = await services.projectStatusService.getStatus(projectId);
      expect(status.currentStage?.id).toBe(ns.id);
    });

    it('prefers not_started over locked', async () => {
      const { services, projectId } = await createProject();
      const { stage: locked } = await services.stageService.createStage(projectId, { id: uuid(), name: 'L', position: 1 });
      await services.stageService.setStageStatus(locked.id, {
        expectedVersion: locked.version,
        status: 'locked',
      });
      const { stage: ns } = await services.stageService.createStage(projectId, { id: uuid(), name: 'NS', position: 2 });
      const status = await services.projectStatusService.getStatus(projectId);
      expect(status.currentStage?.id).toBe(ns.id);
    });

    it('falls back to the smallest-position locked stage', async () => {
      const { services, projectId } = await createProject();
      const { stage: l2 } = await services.stageService.createStage(projectId, { id: uuid(), name: 'L2', position: 5 });
      await services.stageService.setStageStatus(l2.id, { expectedVersion: l2.version, status: 'locked' });
      const { stage: l1 } = await services.stageService.createStage(projectId, { id: uuid(), name: 'L1', position: 1 });
      await services.stageService.setStageStatus(l1.id, { expectedVersion: l1.version, status: 'locked' });
      const status = await services.projectStatusService.getStatus(projectId);
      expect(status.currentStage?.id).toBe(l1.id);
    });

    it('returns null when every stage is completed', async () => {
      const { services, projectId } = await createProject();
      const { stage: a } = await services.stageService.createStage(projectId, { id: uuid(), name: 'A', position: 1 });
      const { stage: b } = await services.stageService.createStage(projectId, { id: uuid(), name: 'B', position: 2 });
      await services.stageService.setStageStatus(a.id, { expectedVersion: a.version, status: 'completed' });
      await services.stageService.setStageStatus(b.id, { expectedVersion: b.version, status: 'completed' });
      const status = await services.projectStatusService.getStatus(projectId);
      expect(status.currentStage).toBeNull();
    });
  });

  it('filters, sorts and flattens activeTasks across stages', async () => {
    const { services, projectId } = await createProject();
    const stageA = (await services.stageService.createStage(projectId, { id: uuid(), name: 'A', position: 1 })).stage;
    const stageB = (await services.stageService.createStage(projectId, { id: uuid(), name: 'B', position: 2 })).stage;

    const t1 = { id: uuid(), status: 'in_progress' as const };
    const t2 = { id: uuid(), status: 'blocked' as const };
    const t1s = { id: uuid(), status: 'in_progress' as const };
    const t3 = { id: uuid(), status: 'completed' as const };
    const t4 = { id: uuid(), status: 'not_started' as const };
    const t5 = { id: uuid(), status: 'pending_review' as const };
    const t6 = { id: uuid(), status: 'needs_changes' as const };
    const t7 = { id: uuid(), status: 'in_progress' as const };

    // Stage A：T1, T1s(分任务), T2 active；T3 completed、T4 not_started 应被排除。
    await injectTask(services, { projectId, stageId: stageA.id, id: t1.id, title: 'T1', position: 1, status: t1.status });
    await injectTask(services, {
      projectId,
      stageId: stageA.id,
      id: t1s.id,
      title: 'T1s',
      parentTaskId: t1.id,
      position: 3,
      status: t1s.status,
    });
    await injectTask(services, { projectId, stageId: stageA.id, id: t2.id, title: 'T2', position: 2, status: t2.status });
    await injectTask(services, {
      projectId,
      stageId: stageA.id,
      id: t3.id,
      title: 'T3',
      position: 4,
      status: t3.status,
      completedAt: new Date().toISOString(),
    });
    await injectTask(services, { projectId, stageId: stageA.id, id: t4.id, title: 'T4', position: 5, status: t4.status });

    // Stage B：T5, T6, T7 active。
    await injectTask(services, { projectId, stageId: stageB.id, id: t5.id, title: 'T5', position: 1, status: t5.status });
    await injectTask(services, { projectId, stageId: stageB.id, id: t6.id, title: 'T6', position: 2, status: t6.status });
    await injectTask(services, { projectId, stageId: stageB.id, id: t7.id, title: 'T7', position: 3, status: t7.status });

    const status = await services.projectStatusService.getStatus(projectId);
    // 排序：先按关卡 position，再按任务 position；分任务以扁平条目出现。
    const ids = status.activeTasks.map((t) => t.id);
    expect(ids).toEqual([t1.id, t2.id, t1s.id, t5.id, t6.id, t7.id]);

    const flatT1s = status.activeTasks.find((t) => t.id === t1s.id)!;
    expect(flatT1s.parentTaskId).toBe(t1.id);
    expect(flatT1s.stageId).toBe(stageA.id);
    expect(status.activeTasks.some((t) => t.id === t3.id || t.id === t4.id)).toBe(false);
    const flatT5 = status.activeTasks.find((t) => t.id === t5.id)!;
    expect(flatT5.stageId).toBe(stageB.id);
    expect(flatT5.status).toBe('pending_review');
  });

  it('throws a controlled corruption error when a task belongs to another project', async () => {
    const { services, projectId } = await createProject();
    const stage = (await services.stageService.createStage(projectId, { id: uuid(), name: 'S1', position: 1 })).stage;

    const otherProjectId = uuid();
    // 直接向仓储注入 projectId 与当前项目不一致、但挂在当前项目关卡下的脏任务。
    await injectTask(services, { projectId: otherProjectId, stageId: stage.id, position: 1 });

    await expect(
      services.projectStatusService.getStatus(projectId),
    ).rejects.toBeInstanceOf(ProjectTaskTreeCorruptionError);
  });

  it('reflects stage status changes immediately', async () => {
    const { services, projectId } = await createProject();
    const { stage } = await services.stageService.createStage(projectId, { id: uuid(), name: 'S1', position: 1 });

    const before = await services.projectStatusService.getStatus(projectId);
    expect(before.currentStage?.id).toBe(stage.id);
    expect(before.stageSummary.completed).toBe(0);

    await services.stageService.setStageStatus(stage.id, {
      expectedVersion: stage.version,
      status: 'completed',
    });

    const after = await services.projectStatusService.getStatus(projectId);
    expect(after.currentStage).toBeNull();
    expect(after.stageSummary.completed).toBe(1);
    expect(after.overallProgressPercent).toBe(100);
  });
});
