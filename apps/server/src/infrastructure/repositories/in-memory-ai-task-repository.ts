import type { AiTask } from '@mingwu/contracts';
import type {
  AiTaskRepository,
  CreateAiTaskIfAbsentResult,
} from '../../domain/ai-task/repository.js';
import { AiTaskPositionConflictError } from '../../domain/ai-task/errors.js';

/**
 * 第三关接口开发用的内存仓储。并发原子性与"同一父级（projectId + ownerActorId +
 * parentTaskId）下 position 唯一"由 Map 的同步读写保证（方法体内在插入前没有 await，
 * 检查与写入在同一同步块内完成）。第六关替换为 PostgreSQL 实现时依赖 id 唯一约束 +
 * `UNIQUE NULLS NOT DISTINCT (project_id, owner_actor_id, parent_task_id, position)`
 * （PostgreSQL 15+）处理竞争：普通 `UNIQUE` 视 NULL 互不相等，无法约束根任务
 * （parent_task_id IS NULL）的 position 去重，需 `NULLS NOT DISTINCT`、部分唯一索引
 * 或表达式唯一索引。
 */
export class InMemoryAiTaskRepository implements AiTaskRepository {
  private readonly tasks = new Map<string, AiTask>();

  async findById(id: string): Promise<AiTask | null> {
    const task = this.tasks.get(id);
    return task ? structuredClone(task) : null;
  }

  async listByOwner(projectId: string, ownerActorId: string): Promise<AiTask[]> {
    return [...this.tasks.values()]
      .filter((t) => t.projectId === projectId && t.ownerActorId === ownerActorId)
      .map((t) => structuredClone(t));
  }

  async createIfAbsent(task: AiTask): Promise<CreateAiTaskIfAbsentResult> {
    const existing = this.tasks.get(task.id);
    if (existing) {
      return { task: structuredClone(existing), created: false };
    }
    const parentKey = task.parentTaskId ?? '__root__';
    const positionTaken = [...this.tasks.values()].some(
      (t) =>
        t.projectId === task.projectId &&
        t.ownerActorId === task.ownerActorId &&
        (t.parentTaskId ?? '__root__') === parentKey &&
        t.position === task.position,
    );
    if (positionTaken) {
      throw new AiTaskPositionConflictError(
        task.projectId,
        task.ownerActorId,
        task.parentTaskId,
        task.position,
      );
    }
    this.tasks.set(task.id, structuredClone(task));
    return { task, created: true };
  }
}
