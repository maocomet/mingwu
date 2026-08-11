/**
 * McpAuth 领域错误。所有错误只携带稳定分类，不回显 Bearer Token、Authorization 头、
 * token hash、actorId / connectionId 或任何秘密文字。
 */

/**
 * MCP Bearer 认证失败：缺失 / 格式错误 / 无效 / 撤销 / 过期统一归为此错误。
 * HTTP 层据此返回受控 401，不区分具体原因，日志只记稳定分类。
 */
export class McpAuthenticationError extends Error {
  constructor() {
    super('MCP bearer authentication failed');
    this.name = 'McpAuthenticationError';
  }
}

/**
 * 认证配置非法：actorId / connectionId 不是合法 UUID、actorCode 为空或超过受控长度、
 * actorType 不在既定三种类型内、permissionProfile 为空。这是服务端配置 / 内存测试
 * 实现构造凭据登记时的防御性校验，失败即内部配置错误，不写入任何受信上下文，
 * 也不回显具体的非法值。
 */
export class McpAuthConfigurationError extends Error {
  constructor() {
    super('MCP authentication configuration is invalid');
    this.name = 'McpAuthConfigurationError';
  }
}
