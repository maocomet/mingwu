export class ProjectNotFoundError extends Error {
  constructor(readonly projectId: string) {
    super(`Project not found: ${projectId}`);
    this.name = 'ProjectNotFoundError';
  }
}

export class ProjectConflictError extends Error {
  constructor(
    readonly projectId: string,
    readonly expectedVersion: number,
    readonly currentVersion: number,
  ) {
    super(`Project version conflict: expected ${expectedVersion}, current ${currentVersion}`);
    this.name = 'ProjectConflictError';
  }
}

/**
 * 同一个幂等标识（项目 id）被再次使用，但请求内容与已存在项目不一致。
 */
export class ProjectIdempotencyConflictError extends Error {
  constructor(readonly projectId: string) {
    super(`Project id ${projectId} already exists with different content`);
    this.name = 'ProjectIdempotencyConflictError';
  }
}
