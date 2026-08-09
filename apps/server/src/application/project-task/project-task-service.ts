import type {
  CreateProjectTaskInput,
  ProgressTree,
  ProgressTreeStage,
  ProjectTask,
  ProjectTaskNode,
} from '@mingwu/contracts';
import { ProjectNotFoundError } from '../../domain/project/errors.js';
import type { ProjectRepository } from '../../domain/project/repository.js';
import { StageNotFoundError } from '../../domain/stage/errors.js';
import type { StageRepository } from '../../domain/stage/repository.js';
import {
  ProjectTaskIdempotencyConflictError,
  ProjectTaskNotFoundError,
  ProjectTaskParentNotFoundError,
  ProjectTaskPositionConflictError,
  ProjectTaskScopeConflictError,
  ProjectTaskTreeCorruptionError,
} from '../../domain/project-task/errors.js';
import type { ProjectTaskRepository } from '../../domain/project-task/repository.js';

export interface CreateProjectTaskResult {
  task: ProjectTask;
  created: boolean;
}

/**
 * 自动分配 position 的最大重试次数。position 在同一父级（stage + parentTaskId）
 * 下单调递增、必然收敛，只要并发创建数低于上限即全部成功。
 */
const AUTO_POSITION_RETRY_LIMIT = 50;

/**
 * 幂等语义比较。position 只在客户端显式提供时才参与比较：自动分配的幂等重试
 * 不应因重算出的位置不同而被误判为冲突。
 */
function sameCreateSemantics(input: CreateProjectTaskInput, existing: ProjectTask): boolean {
  return (
    (input.parentTaskId ?? null) === existing.parentTaskId &&
    input.title === existing.title &&
    (input.description ?? null) === existing.description &&
    (input.completionCriteria ?? null) === existing.completionCriteria &&
    (input.assignedActorId ?? null) === existing.assignedActorId &&
    (input.position === undefined || input.position === existing.position)
  );
}

export class ProjectTaskService {
  constructor(
    private readonly repository: ProjectTaskRepository,
    private readonly stageRepository: StageRepository,
    private readonly projectRepository: ProjectRepository,
  ) {}

  /**
   * 幂等创建正式任务（主任务或分任务）。
   * 归属校验：stage 必须属于 URL 中的 project；parentTaskId 必须指向同一项目、
   * 同一关卡内已存在的 ProjectTask，禁止跨项目或跨关卡挂载。
   * position 在同一父级下唯一；显式 position 冲突直接 409，自动分配撞车时
   * 重新读取并重算、有界重试。
   */
  async createTask(
    projectId: string,
    stageId: string,
    input: CreateProjectTaskInput,
  ): Promise<CreateProjectTaskResult> {
    const stage = await this.stageRepository.findById(stageId);
    if (!stage) {
      throw new StageNotFoundError(stageId);
    }
    if (stage.projectId !== projectId) {
      throw new ProjectTaskScopeConflictError(projectId, stageId, input.parentTaskId ?? null);
    }

    const parentTaskId = input.parentTaskId ?? null;
    if (parentTaskId) {
      const parent = await this.repository.findById(parentTaskId);
      if (!parent) {
        throw new ProjectTaskParentNotFoundError(parentTaskId);
      }
      if (parent.projectId !== projectId || parent.stageId !== stageId) {
        throw new ProjectTaskScopeConflictError(projectId, stageId, parentTaskId);
      }
    }

    if (input.position !== undefined) {
      return this.insertTask(
        projectId,
        stageId,
        parentTaskId,
        input,
        this.buildTask(projectId, stageId, parentTaskId, input, input.position),
      );
    }

    for (let attempt = 0; attempt < AUTO_POSITION_RETRY_LIMIT; attempt++) {
      const position = await this.nextSiblingPosition(stageId, parentTaskId);
      try {
        return await this.insertTask(
          projectId,
          stageId,
          parentTaskId,
          input,
          this.buildTask(projectId, stageId, parentTaskId, input, position),
        );
      } catch (err) {
        if (!(err instanceof ProjectTaskPositionConflictError)) {
          throw err;
        }
        // 自动分配撞车：下一轮重新读取同一父级最新列表并取 max+1。
      }
    }

    const next = await this.nextSiblingPosition(stageId, parentTaskId);
    throw new ProjectTaskPositionConflictError(stageId, parentTaskId, next);
  }

  async getTask(id: string): Promise<ProjectTask> {
    const task = await this.repository.findById(id);
    if (!task) {
      throw new ProjectTaskNotFoundError(id);
    }
    return task;
  }

  /** 完整主进度树：项目 + 按 position 升序的关卡，每个关卡携带按 position 稳定排序的任务树。 */
  async getProgressTree(projectId: string): Promise<ProgressTree> {
    const project = await this.projectRepository.findById(projectId);
    if (!project) {
      throw new ProjectNotFoundError(projectId);
    }
    const stages = await this.stageRepository.listByProject(projectId);
    const tree: ProgressTreeStage[] = [];
    for (const stage of stages) {
      const tasks = await this.repository.listByStage(stage.id);
      tree.push({ ...stage, tasks: buildTaskTree(stage.id, tasks) });
    }
    return { project, stages: tree };
  }

  private async nextSiblingPosition(stageId: string, parentTaskId: string | null): Promise<number> {
    const tasks = await this.repository.listByStage(stageId);
    const siblings = tasks.filter((t) => t.parentTaskId === parentTaskId);
    return siblings.length === 0 ? 1 : Math.max(...siblings.map((t) => t.position)) + 1;
  }

  private buildTask(
    projectId: string,
    stageId: string,
    parentTaskId: string | null,
    input: CreateProjectTaskInput,
    position: number,
  ): ProjectTask {
    const now = new Date().toISOString();
    return {
      id: input.id,
      projectId,
      stageId,
      parentTaskId,
      title: input.title,
      description: input.description ?? null,
      completionCriteria: input.completionCriteria ?? null,
      status: 'not_started',
      position,
      assignedActorId: input.assignedActorId ?? null,
      version: 1,
      createdAt: now,
      updatedAt: now,
      completedAt: null,
      archivedAt: null,
    };
  }

  private async insertTask(
    projectId: string,
    stageId: string,
    parentTaskId: string | null,
    input: CreateProjectTaskInput,
    task: ProjectTask,
  ): Promise<CreateProjectTaskResult> {
    const { task: existing, created } = await this.repository.createIfAbsent(task);
    if (created) {
      return { task, created: true };
    }
    if (
      existing.projectId !== projectId ||
      existing.stageId !== stageId ||
      (existing.parentTaskId ?? null) !== parentTaskId ||
      !sameCreateSemantics(input, existing)
    ) {
      throw new ProjectTaskIdempotencyConflictError(input.id);
    }
    return { task: existing, created: false };
  }
}

/**
 * 把同一关卡的扁平任务列表组装成树，主任务与所有层级分任务按 position 稳定排序。
 * 组树前校验数据完整性：每个非空父引用必须指向同一关卡集合内存在的任务（孤儿
 * 父引用检测）、不得自引用、不得形成父子循环，并确认所有任务都从 root 可达。
 * 发现异常立即抛 ProjectTaskTreeCorruptionError——不把分任务提升为 root、不静默
 * 丢弃循环节点，避免完整主进度树悄悄改写数据含义或漏掉任务。
 */
function buildTaskTree(stageId: string, tasks: ProjectTask[]): ProjectTaskNode[] {
  const nodes = new Map<string, ProjectTaskNode>();
  for (const task of tasks) {
    nodes.set(task.id, { ...task, children: [] });
  }

  // 1) 孤儿父引用 + 自引用检测：每个非空 parentTaskId 必须指向同一关卡集合内的
  //    另一个任务，且不能指向自身。
  for (const task of tasks) {
    if (task.parentTaskId === null) {
      continue;
    }
    if (task.parentTaskId === task.id) {
      throw new ProjectTaskTreeCorruptionError(stageId, 'self_reference', task.id);
    }
    if (!nodes.has(task.parentTaskId)) {
      throw new ProjectTaskTreeCorruptionError(stageId, 'orphan_parent', task.id);
    }
  }

  // 2) 任意长度父子循环检测：从每个任务沿 parent 链上溯，路径上再次出现已访问
  //    节点即成环。自引用已在第 1 步排除，此处覆盖两节点/多节点环。
  for (const task of tasks) {
    const path = new Set<string>();
    let current: string | null = task.id;
    while (current !== null) {
      if (path.has(current)) {
        throw new ProjectTaskTreeCorruptionError(stageId, 'cycle', current);
      }
      path.add(current);
      current = nodes.get(current)!.parentTaskId;
    }
  }

  // 3) 组装父子关系。
  const roots: ProjectTaskNode[] = [];
  for (const task of tasks) {
    const node = nodes.get(task.id)!;
    if (task.parentTaskId === null) {
      roots.push(node);
    } else {
      nodes.get(task.parentTaskId)!.children.push(node);
    }
  }

  // 4) 不变量兜底：孤儿与循环已在上面排除，所有任务必然从 root 可达；此处仍校验
  //    最终访问到的节点数等于输入任务数，防止未来改动让节点静默丢失而返回不完整树。
  const visited = new Set<string>();
  const collect = (list: ProjectTaskNode[]): void => {
    for (const node of list) {
      visited.add(node.id);
      collect(node.children);
    }
  };
  collect(roots);
  if (visited.size !== tasks.length) {
    const missing = tasks.find((t) => !visited.has(t.id))!;
    throw new ProjectTaskTreeCorruptionError(stageId, 'cycle', missing.id);
  }

  // 5) 每层按 position 稳定排序。
  const sortRecursive = (list: ProjectTaskNode[]): void => {
    list.sort((a, b) => a.position - b.position);
    for (const node of list) {
      sortRecursive(node.children);
    }
  };
  sortRecursive(roots);
  return roots;
}
