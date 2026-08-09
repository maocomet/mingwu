export class StageNotFoundError extends Error {
  constructor(readonly stageId: string) {
    super(`Stage not found: ${stageId}`);
    this.name = 'StageNotFoundError';
  }
}

/**
 * 同一项目内已经存在相同 position 的关卡，而客户端要求占用的 position 不同。
 * position 唯一性属于仓储层约束（第六关由 PostgreSQL `UNIQUE (project_id, position)` 保证）。
 */
export class StagePositionConflictError extends Error {
  constructor(
    readonly projectId: string,
    readonly position: number,
  ) {
    super(`Stage position ${position} already taken in project ${projectId}`);
    this.name = 'StagePositionConflictError';
  }
}

/**
 * 同一个幂等标识（关卡 id）被再次使用，但请求内容与已存在关卡不一致。
 */
export class StageIdempotencyConflictError extends Error {
  constructor(readonly stageId: string) {
    super(`Stage id ${stageId} already exists with different content`);
    this.name = 'StageIdempotencyConflictError';
  }
}

/**
 * 乐观并发冲突：expectedVersion 与关卡当前 version 不一致。仓储级 CAS 检测到
 * 版本已被其他写操作推进时抛出，防止旧状态静默覆盖新状态。
 */
export class StageVersionConflictError extends Error {
  constructor(readonly stageId: string, readonly expectedVersion: number) {
    super(`Stage ${stageId} version conflict: expected ${expectedVersion}`);
    this.name = 'StageVersionConflictError';
  }
}
