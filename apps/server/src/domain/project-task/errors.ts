export class ProjectTaskNotFoundError extends Error {
  constructor(readonly taskId: string) {
    super(`ProjectTask not found: ${taskId}`);
    this.name = 'ProjectTaskNotFoundError';
  }
}

export class ProjectTaskParentNotFoundError extends Error {
  constructor(readonly parentTaskId: string) {
    super(`Parent ProjectTask not found: ${parentTaskId}`);
    this.name = 'ProjectTaskParentNotFoundError';
  }
}

/**
 * 归属不一致：stage 不属于 URL 中的 project，或 parentTaskId 指向的任务不在同一
 * 项目 / 同一关卡下。禁止跨项目或跨关卡挂载。
 */
export class ProjectTaskScopeConflictError extends Error {
  constructor(
    readonly projectId: string,
    readonly stageId: string,
    readonly parentTaskId: string | null,
  ) {
    super(
      `ProjectTask scope conflict: project ${projectId}, stage ${stageId}, parent ${parentTaskId}`,
    );
    this.name = 'ProjectTaskScopeConflictError';
  }
}

/**
 * 同一父级（stage + parentTaskId）下已经存在相同 position 的任务。
 * position 唯一性属于仓储层约束。第六关落 PostgreSQL 时：根任务的 `parent_task_id IS NULL`，
 * 多个根任务共享同一父级，普通 `UNIQUE (stage_id, parent_task_id, position)` 把 NULL 视为
 * 互不相等、无法约束根任务去重；应使用 PostgreSQL 15+ 的 `UNIQUE NULLS NOT DISTINCT`，
 * 或对根任务与子任务分别建立部分唯一索引（或可靠的表达式唯一索引）。
 */
export class ProjectTaskPositionConflictError extends Error {
  constructor(
    readonly stageId: string,
    readonly parentTaskId: string | null,
    readonly position: number,
  ) {
    super(`ProjectTask position ${position} already taken under stage ${stageId}`);
    this.name = 'ProjectTaskPositionConflictError';
  }
}

/**
 * 主进度树数据完整性错误：同一关卡任务集合内出现孤儿父引用（parentTaskId 指向
 * 不存在的任务）、自引用或任意长度的父子循环。组树前必须检测并抛出该错误，
 * 禁止把分任务提升为 root 或静默丢弃循环节点；HTTP 层只返回受控错误码与通用
 * 文案，不暴露内部任务 / 关卡 id。
 */
export class ProjectTaskTreeCorruptionError extends Error {
  constructor(
    readonly stageId: string,
    readonly reason: 'orphan_parent' | 'self_reference' | 'cycle',
    readonly taskId: string,
  ) {
    super(`Progress tree data corruption in stage ${stageId}: ${reason} at task ${taskId}`);
    this.name = 'ProjectTaskTreeCorruptionError';
  }
}

/**
 * 同一个幂等标识（任务 id）被再次使用，但请求内容与已存在任务不一致。
 */
export class ProjectTaskIdempotencyConflictError extends Error {
  constructor(readonly taskId: string) {
    super(`ProjectTask id ${taskId} already exists with different content`);
    this.name = 'ProjectTaskIdempotencyConflictError';
  }
}
