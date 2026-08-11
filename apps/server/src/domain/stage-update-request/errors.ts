/**
 * StageUpdateRequest 领域错误。所有错误消息不回显申请理由、身份值或受保护字段，
 * 避免把用户 / 客户端内容反弹给调用方。Stage 不存在的 404 复用 StageNotFoundError，
 * 版本陈旧冲突复用 StageVersionConflictError（stage/errors.ts）。
 */

/**
 * 申请幂等键 id 不是 UUID（schema 已先行拦截，此处为服务层自守输入不变量，
 * 直接调用服务绕过 MCP 入口也不得传入非法 id）。
 */
export class StageUpdateRequestIdInvalidError extends Error {
  constructor(readonly requestId: string) {
    super(`Stage update request id is invalid: ${requestId}`);
    this.name = 'StageUpdateRequestIdInvalidError';
  }
}

/**
 * 申请理由不合法：去除首尾空白后为空，或按 Unicode code point 计数超过
 * STAGE_UPDATE_REASON_MAX_LENGTH（与 JSON Schema maxLength 语义一致）。
 * 消息不回显原始理由，避免把客户端内容反弹给调用方。
 */
export class StageUpdateRequestReasonInvalidError extends Error {
  constructor() {
    super('Stage update request reason is invalid');
    this.name = 'StageUpdateRequestReasonInvalidError';
  }
}

/**
 * 目标状态不合法：proposedStatus 不在既有合法关卡状态内（schema 已先行拦截，
 * 此处为服务层自守输入不变量）。
 */
export class StageUpdateRequestProposedStatusInvalidError extends Error {
  constructor() {
    super('Stage update request proposed status is invalid');
    this.name = 'StageUpdateRequestProposedStatusInvalidError';
  }
}

/**
 * 申请所依据的关卡版本不合法：不是正整数（schema 已先行拦截，此处为服务层自守
 * 输入不变量）。
 */
export class StageUpdateRequestExpectedVersionInvalidError extends Error {
  constructor() {
    super('Stage update request expected version is invalid');
    this.name = 'StageUpdateRequestExpectedVersionInvalidError';
  }
}

/**
 * 幂等键冲突：id 已存在但与本次请求的 (stageId, requesterActorId,
 * expectedStageVersion, proposedStatus, reason) 语义不同。返回稳定 409，绝不覆盖
 * 已有申请；同 id 同语义的重试应幂等返回已有申请。
 */
export class StageUpdateRequestIdempotencyConflictError extends Error {
  constructor(readonly requestId: string) {
    super(`Stage update request ${requestId} already exists with different semantics`);
    this.name = 'StageUpdateRequestIdempotencyConflictError';
  }
}

/**
 * 申请者受信认证上下文非法：actorId 不是合法 UUID、actorCode 为空或超过受控长度、
 * 或 actorType 不在既定三种类型内。这是服务层对受信上下文的防守性校验，校验失败
 * 时不得写入任何申请，并抛出不泄露身份值 / 秘密的内部受控错误。
 */
export class StageUpdateRequesterInvalidError extends Error {
  constructor() {
    super('Stage update requester context is invalid');
    this.name = 'StageUpdateRequesterInvalidError';
  }
}

/** 决定入口的目标申请不存在（404）。消息只含申请 id，不回显决定说明或申请内容。 */
export class StageUpdateRequestNotFoundError extends Error {
  constructor(readonly requestId: string) {
    super(`Stage update request not found: ${requestId}`);
    this.name = 'StageUpdateRequestNotFoundError';
  }
}

/**
 * 决定入口的 expectedRevision 不合法：不是正整数（schema 已先行拦截，此处为服务层
 * 自守输入不变量）。
 */
export class StageUpdateRequestRevisionInvalidError extends Error {
  constructor() {
    super('Stage update request decision revision is invalid');
    this.name = 'StageUpdateRequestRevisionInvalidError';
  }
}

/**
 * 决定说明（note）不合法：去除首尾空白后为空，或按 Unicode code point 计数超过
 * STAGE_UPDATE_NOTE_MAX_LENGTH（与 JSON Schema maxLength 语义一致）。消息不回显
 * 原始 note，避免把客户端内容反弹给调用方。
 */
export class StageUpdateRequestNoteInvalidError extends Error {
  constructor() {
    super('Stage update request decision note is invalid');
    this.name = 'StageUpdateRequestNoteInvalidError';
  }
}

/**
 * 决定冲突（409）：申请不存在于 pending 状态、expectedRevision 与当前 revision
 * 不一致、或已决定后重试语义不同（note 不同 / expectedRevision 错误 / 并发决定
 * 竞争落败）。绝不覆盖第一次决定；错误消息不回显 note、原申请 reason 或决定内容。
 */
export class StageUpdateRequestDecisionConflictError extends Error {
  constructor(readonly requestId: string) {
    super(`Stage update request ${requestId} decision conflict`);
    this.name = 'StageUpdateRequestDecisionConflictError';
  }
}

/**
 * 批准时的关卡归属冲突（409）：申请记录的 stageId / projectId 与真实 Stage 不一致
 * （脏数据或申请所依据的 Stage 已被替换）。批准必须同时更新申请与正式 Stage，归属
 * 不一致时整体拒绝，两侧都不写入；消息不回显申请内容或 Stage 值。
 */
export class StageUpdateRequestStageOwnershipConflictError extends Error {
  constructor(readonly requestId: string) {
    super(`Stage update request ${requestId} stage ownership conflict`);
    this.name = 'StageUpdateRequestStageOwnershipConflictError';
  }
}
