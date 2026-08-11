import {
  AI_ACTOR_CODE_MAX_LENGTH,
  AI_ACTOR_TYPES,
} from '@mingwu/contracts';
import type { McpAuthContext } from './mcp-auth-context.js';
import { McpAuthConfigurationError, McpAuthenticationError } from './errors.js';

/**
 * 可替换的 MCP 认证边界。领域 / MCP 层只依赖本接口，不绑定未来 OAuth 库：
 * - 输入不含 scheme 的 Bearer token，返回受信任的只读 MCP AuthContext；
 * - 认证失败（无效 / 撤销 / 过期 / 配置缺失）抛 McpAuthenticationError，HTTP 层统一
 *   返回受控 401，不泄露具体原因；
 * - 实现必须不可逆保存凭据（如 SHA-256 摘要），不保存明文 Token；
 * - 身份只能由服务端凭据解析，绝不信任客户端提交的 actorId / actorCode / actorType。
 */
export interface McpAuthenticator {
  /** 解析 Bearer token 为受信只读 AuthContext；认证失败抛 McpAuthenticationError。 */
  authenticate(bearerToken: string): Promise<McpAuthContext>;
}

/** 严格 UUID 锚定（8-4-4-4-12，十六进制，大小写不敏感）。 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** permissionProfile（第二关 permission_profile 权限配置标识）的受控长度上限。 */
export const MCP_AUTH_PERMISSION_PROFILE_MAX_LENGTH = 64;

/**
 * 对受信 AuthContext 做防御性验证：UUID 与枚举 / 长度都防守性检查。
 * 任一项非法即抛内部配置错误（不泄露具体非法值）；合法上下文才是受信身份，
 * 绝不能信任客户端提交的身份字段。路由在认证成功后必须调用本函数，并在绑定前
 * 复制 / 冻结成 session 私有只读对象，避免外部认证器实现随后修改同一对象。
 */
export function assertValidMcpAuthContext(context: McpAuthContext): void {
  if (!UUID_RE.test(context.actorId) || !UUID_RE.test(context.connectionId)) {
    throw new McpAuthConfigurationError();
  }
  if (
    context.actorCode.trim().length === 0 ||
    context.actorCode.length > AI_ACTOR_CODE_MAX_LENGTH
  ) {
    throw new McpAuthConfigurationError();
  }
  if (!AI_ACTOR_TYPES.includes(context.actorType)) {
    throw new McpAuthConfigurationError();
  }
  if (
    context.permissionProfile.trim().length === 0 ||
    context.permissionProfile.length > MCP_AUTH_PERMISSION_PROFILE_MAX_LENGTH
  ) {
    throw new McpAuthConfigurationError();
  }
}
