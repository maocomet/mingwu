/**
 * AITask 领域错误。
 */

/**
 * 任务 id 不是合法 UUID。消息不回显非法值（可能夹带攻击性内容）。
 */
export class AiTaskIdInvalidError extends Error {
  constructor() {
    super('AiTask id must be a valid UUID');
    this.name = 'AiTaskIdInvalidError';
  }
}

/**
 * 标题 trim 后为空或按 Unicode code point 计数超上限。
 */
export class AiTaskTitleInvalidError extends Error {
  constructor() {
    super('AiTask title must be non-empty and within the code point limit');
    this.name = 'AiTaskTitleInvalidError';
  }
}

/**
 * 描述 trim 后按 Unicode code point 计数超上限。
 */
export class AiTaskDescriptionInvalidError extends Error {
  constructor() {
    super('AiTask description exceeds the code point limit');
    this.name = 'AiTaskDescriptionInvalidError';
  }
}

/**
 * 可选关联的正式 ProjectTask 不存在，或不属于同一项目。禁止跨项目关联正式任务。
 */
export class AiTaskProjectTaskInvalidError extends Error {
  constructor(
    readonly projectId: string,
    readonly projectTaskId: string,
  ) {
    super(`AiTask projectTask ${projectTaskId} is not a valid formal task of project ${projectId}`);
    this.name = 'AiTaskProjectTaskInvalidError';
  }
}

/**
 * 可选父 AI 任务不存在。
 */
export class AiTaskParentNotFoundError extends Error {
  constructor(readonly parentTaskId: string) {
    super(`Parent AiTask not found: ${parentTaskId}`);
    this.name = 'AiTaskParentNotFoundError';
  }
}

/**
 * 归属不一致：父 AI 任务不属于同一项目，或 owner 与当前 AuthContext 不同。
 * 禁止跨 Actor 或跨项目挂载子任务。
 */
export class AiTaskScopeConflictError extends Error {
  constructor(
    readonly projectId: string,
    readonly ownerActorId: string,
    readonly parentTaskId: string | null,
  ) {
    super(
      `AiTask scope conflict: project ${projectId}, owner ${ownerActorId}, parent ${parentTaskId}`,
    );
    this.name = 'AiTaskScopeConflictError';
  }
}

/**
 * 同一父级（projectId + ownerActorId + parentTaskId）下已经存在相同 position 的任务。
 * position 唯一性属于仓储层约束。第六关落 PostgreSQL 时：根任务 `parent_task_id IS NULL`，
 * 多个根任务共享同一父级，普通 `UNIQUE` 视 NULL 互不相等、无法约束根任务去重，应使用
 * PostgreSQL 15+ 的 `UNIQUE NULLS NOT DISTINCT (project_id, owner_actor_id,
 * parent_task_id, position)`，或对根任务与子任务分别建立部分唯一索引。
 */
export class AiTaskPositionConflictError extends Error {
  constructor(
    readonly projectId: string,
    readonly ownerActorId: string,
    readonly parentTaskId: string | null,
    readonly position: number,
  ) {
    super(
      `AiTask position ${position} already taken under project ${projectId} owner ${ownerActorId}`,
    );
    this.name = 'AiTaskPositionConflictError';
  }
}

/**
 * 同一个幂等标识（任务 id）被再次使用，但请求语义与已存在任务不一致。
 */
export class AiTaskIdempotencyConflictError extends Error {
  constructor(readonly taskId: string) {
    super(`AiTask id ${taskId} already exists with different content`);
    this.name = 'AiTaskIdempotencyConflictError';
  }
}

/**
 * 受信认证上下文非法：actorId 不是合法 UUID、actorCode 为空或超过受控长度、
 * 或 actorType 不在既定三种类型内。这是服务层对受信上下文的防守性校验，
 * 校验失败时不得写入任何任务，并抛出不泄露身份值 / 秘密的内部受控错误。
 */
export class AiTaskRequesterInvalidError extends Error {
  constructor() {
    super('Authenticated AI actor context is invalid');
    this.name = 'AiTaskRequesterInvalidError';
  }
}

/**
 * 任务不存在，或任务存在但不属于当前认证 Actor。两种情况返回同一个固定脱敏错误，
 * 调用方无法据此区分"任务缺失"与"他人任务"，避免跨 Actor 探测。消息不含任务 ID。
 */
export class AiTaskNotFoundError extends Error {
  constructor() {
    super('AiTask not found');
    this.name = 'AiTaskNotFoundError';
  }
}

/**
 * 乐观并发冲突：调用方依据的 expectedVersion 与任务当前 version 不一致（陈旧版本）。
 * 固定脱敏消息，不含任务 ID 或版本号。
 */
export class AiTaskVersionConflictError extends Error {
  constructor() {
    super('AiTask version conflict');
    this.name = 'AiTaskVersionConflictError';
  }
}

/**
 * 任务已归档，禁止修改。固定脱敏消息，不含任务 ID。
 */
export class AiTaskArchivedError extends Error {
  constructor() {
    super('AiTask is archived and cannot be modified');
    this.name = 'AiTaskArchivedError';
  }
}

/**
 * 修改请求没有提供任何实际修改字段（title 与 description 均缺失）。固定脱敏消息。
 */
export class AiTaskUpdateInvalidError extends Error {
  constructor() {
    super('AiTask update requires at least one modification field');
    this.name = 'AiTaskUpdateInvalidError';
  }
}

/**
 * 任务树数据不一致：当前 owner 作用域内出现父引用不存在、自引用、任意长度循环、
 * 父子跨项目 / 跨 owner，或最终访问节点数不等于输入节点数。只读查询不能把孤儿提升为
 * 根、不能静默丢节点，因此直接失败。这是内部受控错误：消息为固定脱敏文本，不包含任何
 * 任务 / 项目 / Actor ID；细节只由调用方（MCP 层）记入服务端日志。
 */
export class AiTaskTreeCorruptError extends Error {
  constructor() {
    super('AiTask tree data is inconsistent and cannot be read');
    this.name = 'AiTaskTreeCorruptError';
  }
}
