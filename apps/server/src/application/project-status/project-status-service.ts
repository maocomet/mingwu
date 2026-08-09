import type {
  Project,
  ProjectActiveTask,
  ProjectCurrentStage,
  ProjectCurrentStatus,
  ProjectStage,
  ProjectStageStatus,
  ProjectStatusProject,
  ProjectTask,
  ProjectTaskStatus,
} from '@mingwu/contracts';
import { ProjectNotFoundError } from '../../domain/project/errors.js';
import type { ProjectRepository } from '../../domain/project/repository.js';
import { ProjectTaskTreeCorruptionError } from '../../domain/project-task/errors.js';
import type { ProjectTaskRepository } from '../../domain/project-task/repository.js';
import type { StageRepository } from '../../domain/stage/repository.js';

/** currentStage 选择中视为"正在推进"的关卡状态。 */
const ACTIVE_STAGE_STATUSES: ReadonlySet<ProjectStageStatus> = new Set([
  'in_progress',
  'pending_review',
  'needs_changes',
  'blocked',
]);

/** activeTasks 只收录这些任务状态。 */
const ACTIVE_TASK_STATUSES: ReadonlySet<ProjectTaskStatus> = new Set([
  'in_progress',
  'pending_review',
  'needs_changes',
  'blocked',
]);

/**
 * 只读聚合服务：GET /api/v1/projects/:projectId/status 的应用服务能力。
 * 每次调用都从共享的 Project / ProjectStage / ProjectTask 仓储实时计算，
 * 不保存第二套进度或状态快照，不缓存陈旧副本——刚刚发生的关卡元数据/状态
 * 修改在下次查询时立即反映。用户 / AI 均可复用，本批不新增 MCP 暴露。
 */
export class ProjectStatusService {
  constructor(
    private readonly projectRepository: ProjectRepository,
    private readonly stageRepository: StageRepository,
    private readonly taskRepository: ProjectTaskRepository,
  ) {}

  async getStatus(projectId: string): Promise<ProjectCurrentStatus> {
    const project = await this.projectRepository.findById(projectId);
    if (!project) {
      throw new ProjectNotFoundError(projectId);
    }

    // listByProject 已按 position 升序返回；排序细节由选择规则再次保证。
    const stages = await this.stageRepository.listByProject(projectId);
    const stageSummary = buildStageSummary(stages);
    const currentStage = selectCurrentStage(stages);

    // 任务统计按当前所有正式 ProjectTask 记录计数（含主任务与分任务）。
    // 若后续产品决定改按叶子任务或权重计算，需要单独变更此规则并更新检查点。
    let taskTotal = 0;
    let taskCompleted = 0;
    const taskByStatus = zeroTaskCounts();
    const activeEntries: { stagePosition: number; task: ProjectTask }[] = [];

    for (const stage of stages) {
      const tasks = await this.taskRepository.listByStage(stage.id);
      for (const task of tasks) {
        validateTaskBelongsToProject(projectId, stage, task);
        taskTotal += 1;
        taskByStatus[task.status] += 1;
        if (task.status === 'completed') {
          taskCompleted += 1;
        }
        if (ACTIVE_TASK_STATUSES.has(task.status)) {
          activeEntries.push({ stagePosition: stage.position, task });
        }
      }
    }

    // activeTasks 排序：先按所属关卡 position，再按任务 position，position 相同时
    // 以 id 做稳定兜底排序。
    activeEntries.sort(
      (a, b) =>
        a.stagePosition - b.stagePosition ||
        a.task.position - b.task.position ||
        (a.task.id < b.task.id ? -1 : a.task.id > b.task.id ? 1 : 0),
    );

    return {
      project: toProjectSummary(project),
      currentStage,
      stageSummary,
      taskSummary: { total: taskTotal, completed: taskCompleted, byStatus: taskByStatus },
      overallProgressPercent: computeProgress(
        taskTotal,
        taskCompleted,
        stageSummary.total,
        stageSummary.completed,
      ),
      activeTasks: activeEntries.map((e) => toActiveTask(e.task)),
    };
  }
}

function toProjectSummary(project: Project): ProjectStatusProject {
  return { id: project.id, name: project.name, status: project.status, version: project.version };
}

function toActiveTask(task: ProjectTask): ProjectActiveTask {
  return {
    id: task.id,
    stageId: task.stageId,
    parentTaskId: task.parentTaskId,
    title: task.title,
    status: task.status,
    position: task.position,
    assignedActorId: task.assignedActorId,
  };
}

function zeroStageCounts(): Record<ProjectStageStatus, number> {
  return {
    locked: 0,
    not_started: 0,
    in_progress: 0,
    pending_review: 0,
    needs_changes: 0,
    blocked: 0,
    completed: 0,
  };
}

function zeroTaskCounts(): Record<ProjectTaskStatus, number> {
  return {
    not_started: 0,
    in_progress: 0,
    pending_review: 0,
    needs_changes: 0,
    blocked: 0,
    completed: 0,
  };
}

function buildStageSummary(stages: ProjectStage[]): ProjectCurrentStatus['stageSummary'] {
  const byStatus = zeroStageCounts();
  let completed = 0;
  for (const stage of stages) {
    byStatus[stage.status] += 1;
    if (stage.status === 'completed') {
      completed += 1;
    }
  }
  return { total: stages.length, completed, byStatus };
}

/**
 * currentStage 选择规则：
 * 1. 先取 position 最小且状态属于 in_progress / pending_review / needs_changes / blocked 的关卡；
 * 2. 没有则取 position 最小的 not_started；
 * 3. 再没有则取 position 最小的 locked；
 * 4. 全部 completed 或没有关卡时返回 null。
 * 各档内按 position 升序取第一个，即该档 position 最小者。
 */
function selectCurrentStage(stages: ProjectStage[]): ProjectCurrentStage | null {
  const sorted = [...stages].sort((a, b) => a.position - b.position);
  const pickFirst = (list: ProjectStage[]): ProjectCurrentStage | null => {
    const stage = list[0];
    if (!stage) {
      return null;
    }
    return {
      id: stage.id,
      name: stage.name,
      position: stage.position,
      status: stage.status,
      version: stage.version,
    };
  };

  const active = sorted.filter((s) => ACTIVE_STAGE_STATUSES.has(s.status));
  if (active.length > 0) {
    return pickFirst(active);
  }
  const notStarted = sorted.filter((s) => s.status === 'not_started');
  if (notStarted.length > 0) {
    return pickFirst(notStarted);
  }
  const locked = sorted.filter((s) => s.status === 'locked');
  if (locked.length > 0) {
    return pickFirst(locked);
  }
  return null;
}

/**
 * 进度公式（实时计算，不独立保存）：
 * - 存在正式 ProjectTask（taskTotal > 0）时：completed task / total task * 100 四舍五入；
 * - 没有任务但存在关卡（stageTotal > 0）时：completed stage / total stage * 100 四舍五入；
 * - 项目没有关卡时为 0。
 */
function computeProgress(
  taskTotal: number,
  taskCompleted: number,
  stageTotal: number,
  stageCompleted: number,
): number {
  if (taskTotal > 0) {
    return Math.round((taskCompleted / taskTotal) * 100);
  }
  if (stageTotal > 0) {
    return Math.round((stageCompleted / stageTotal) * 100);
  }
  return 0;
}

/**
 * 聚合任务时的数据完整性校验：任务必须归属当前项目，且 task.stageId 与它所在
 * 关卡一致。如果读到 task.projectId 与当前项目不一致、或 stageId 错配的脏数据，
 * 不得计入或伪装为正常结果，抛受控的 ProjectTaskTreeCorruptionError；HTTP 层只
 * 返回受控 500 与通用文案，不泄露内部任务 / 关卡 id。
 */
function validateTaskBelongsToProject(projectId: string, stage: ProjectStage, task: ProjectTask): void {
  if (task.projectId !== projectId || task.stageId !== stage.id) {
    throw new ProjectTaskTreeCorruptionError(stage.id, 'scope_mismatch', task.id);
  }
}
