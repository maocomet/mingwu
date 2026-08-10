/**
 * StudyActor 领域错误。
 */

/**
 * 受信认证上下文非法：actorId 不是合法 UUID、actorCode 为空或超过受控长度、
 * 或 actorType 不在既定三种类型内。这是服务层对受信上下文的防守性校验，
 * 校验失败时不得写入任何报告或 Participant，并抛出不泄露身份值 / 秘密的
 * 内部受控错误（消息不回显 actorId / actorCode）。
 */
export class StudyActorContextInvalidError extends Error {
  constructor() {
    super('Authenticated AI actor context is invalid');
    this.name = 'StudyActorContextInvalidError';
  }
}
