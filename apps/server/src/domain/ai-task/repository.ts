import type { AiTask } from '@mingwu/contracts';

export interface CreateAiTaskIfAbsentResult {
  task: AiTask;
  created: boolean;
}

/** 原子 CAS 更新任务基础内容时允许变更的字段：只有 title 与 description。 */
export interface UpdateAiTaskContentChanges {
  title?: string;
  description?: string | null;
}

/** 原子 CAS 更新的输入：id + 乐观并发版本 + 变更字段 + 服务端刷新时间。 */
export interface UpdateAiTaskContentInput {
  id: string;
  /** 调用方依据的任务当前 version；与仓储中现有 version 不一致时拒绝。 */
  expectedVersion: number;
  changes: UpdateAiTaskContentChanges;
  /** 服务端写入的 updatedAt（ISO 字符串）。 */
  updatedAt: string;
}

/** 原子 CAS 完成任务的输入：id + 乐观并发版本 + 服务端完成时间。 */
export interface CompleteTaskInput {
  id: string;
  /** 调用方依据的任务当前 version；与仓储中现有 version 不一致时拒绝。 */
  expectedVersion: number;
  /** 服务端写入的完成时间（ISO 字符串），completedAt 与 updatedAt 共用同一值。 */
  completedAt: string;
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
  /**
   * 原子 CAS 更新任务基础内容（本批只允许 title / description）。
   * - 版本检查与写入必须在同一原子边界：id 必须存在，且现有 version === expectedVersion
   *   才允许写入；任何不符抛 AiTaskVersionConflictError，绝不覆盖；
   * - 成功时只变更 changes 中的字段，version +1，updatedAt 刷新为输入值，其余字段不变；
   * - 返回更新后的完整任务（深拷贝）。
   *
   * 第六关 PostgreSQL 实现将使用 `UPDATE ... WHERE id=? AND version=?` 原子更新（受
   * `UPDATE` 行级锁保护，where 版本条件作为乐观并发判断），或等价事务；rows=0 时抛
   * AiTaskVersionConflictError，避免"先查后写"窗口下的竞态覆盖。
   */
  updateTaskContent(input: UpdateAiTaskContentInput): Promise<AiTask>;
  /**
   * 原子 CAS 完成任务：
   * - 版本检查与写入必须在同一原子边界：id 必须存在，且现有 version === expectedVersion
   *   才允许写入；任何不符抛 AiTaskVersionConflictError，绝不覆盖；
   * - 成功时原子设置 status='completed'、progressPercent=100、completedAt 与 updatedAt 为
   *   输入的服务端时间（同一值）、version +1，其余字段不变；
   * - 返回完成后的完整任务（深拷贝）。
   *
   * 第六关 PostgreSQL 实现将使用
   * `UPDATE ... SET status='completed', progress_percent=100, completed_at=?, updated_at=?,
   *  version=version+1 WHERE id=? AND version=?` 原子更新（`UPDATE` 行级锁 + where 版本
   * 条件），rows=0 时抛 AiTaskVersionConflictError。
   */
  completeTask(input: CompleteTaskInput): Promise<AiTask>;
}
