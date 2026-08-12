import type { AiTask } from '@mingwu/contracts';

export interface CreateAiTaskIfAbsentResult {
  task: AiTask;
  created: boolean;
}

/**
 * 仓储接口。并发正确性与"同一 projectId + ownerActorId + parentTaskId 下 position 唯一"
 * 由仓储保证，业务层不在"先查再写"的窗口里做判断。PostgreSQL 实现将依赖 id 唯一约束 +
 * `UNIQUE NULLS NOT DISTINCT (project_id, owner_actor_id, parent_task_id, position)`
 * （PostgreSQL 15+）处理竞争——普通 `UNIQUE` 视 NULL 互不相等，无法约束根任务
 * （parent_task_id IS NULL）的 position 去重；也可改用根任务/子任务的部分唯一索引或
 * 可靠的表达式唯一索引。
 */
export interface AiTaskRepository {
  findById(id: string): Promise<AiTask | null>;
  /** 返回某项目 + 某 owner 下的全部任务（不排序，排序由服务层按树结构处理）。 */
  listByOwner(projectId: string, ownerActorId: string): Promise<AiTask[]>;
  /**
   * 原子插入：
   * - id 已存在 → 返回已有任务（created=false），不覆盖；
   * - id 不存在但同一父级（projectId + ownerActorId + parentTaskId）下 position 已被
   *   占用 → 抛 AiTaskPositionConflictError；
   * - 否则保存并返回 created=true。
   */
  createIfAbsent(task: AiTask): Promise<CreateAiTaskIfAbsentResult>;
}
