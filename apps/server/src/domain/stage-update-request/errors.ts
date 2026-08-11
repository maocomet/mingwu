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
