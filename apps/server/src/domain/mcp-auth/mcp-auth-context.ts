import type { AuthenticatedAiActorContext } from '@mingwu/contracts';

/**
 * MCP 连接绑定后的受信只读认证上下文。
 *
 * 与第二关既定身份模型一致：
 * - AI Actor 是长期身份，MCPConnection 是稳定连接登记，MCP Session ID 只是一次临时协议会话；
 * - 认证凭据 → MCPConnection → AIActor → AuthContext，Actor 只能由服务端验证 Bearer 凭据后解析；
 * - 客户端提交的 actorId / actorCode / actorType 不可信，绝不能作为身份依据；
 * - MCP 临时 Session ID 不参与推导 Actor 身份。
 *
 * 本上下文只由 McpAuthenticator 在验证服务端凭据后构造，字段全部只读，应用服务
 * 不得改写。它只用于“安全传递与隔离”，本批不据此做任何权限决策，也不增加 whoami 工具。
 */
export interface McpAuthContext extends AuthenticatedAiActorContext {
  /** 稳定连接登记 UUID：同一 Actor 可拥有多条 MCPConnection，各有独立凭据。 */
  readonly connectionId: string;
  /** 该 Actor 使用的权限配置标识（第二关 permission_profile）。 */
  readonly permissionProfile: string;
}
