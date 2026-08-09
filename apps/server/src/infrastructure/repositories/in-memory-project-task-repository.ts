import type { ProjectTask } from '@mingwu/contracts';
import type {
  CreateProjectTaskIfAbsentResult,
  ProjectTaskRepository,
} from '../../domain/project-task/repository.js';
import { ProjectTaskPositionConflictError } from '../../domain/project-task/errors.js';

/**
 * 第三关接口开发用的内存仓储。并发原子性与"同一父级下 position 唯一"由 Map 的
 * 同步读写保证（方法体内在插入前没有 await，检查与写入在同一同步块内完成）。
 * 第六关替换为 PostgreSQL 实现时依赖 id 唯一约束 +
 * `UNIQUE NULLS NOT DISTINCT (stage_id, parent_task_id, position)`（PostgreSQL 15+）
 * 处理竞争：普通 `UNIQUE` 视 NULL 互不相等，无法约束根任务（parent_task_id IS NULL）
 * 的 position 去重，需 `NULLS NOT DISTINCT`、部分唯一索引或表达式唯一索引。
 */
export class InMemoryProjectTaskRepository implements ProjectTaskRepository {
  private readonly tasks = new Map<string, ProjectTask>();

  async findById(id: string): Promise<ProjectTask | null> {
    const task = this.tasks.get(id);
    return task ? structuredClone(task) : null;
  }

  async listByStage(stageId: string): Promise<ProjectTask[]> {
    return [...this.tasks.values()]
      .filter((t) => t.stageId === stageId)
      .map((t) => structuredClone(t));
  }

  async createIfAbsent(task: ProjectTask): Promise<CreateProjectTaskIfAbsentResult> {
    const existing = this.tasks.get(task.id);
    if (existing) {
      return { task: structuredClone(existing), created: false };
    }
    const parentKey = task.parentTaskId ?? '__root__';
    const positionTaken = [...this.tasks.values()].some(
      (t) =>
        t.stageId === task.stageId && (t.parentTaskId ?? '__root__') === parentKey && t.position === task.position,
    );
    if (positionTaken) {
      throw new ProjectTaskPositionConflictError(task.stageId, task.parentTaskId, task.position);
    }
    this.tasks.set(task.id, structuredClone(task));
    return { task, created: true };
  }
}
