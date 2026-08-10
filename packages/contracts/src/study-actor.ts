/**
 * AI Actor 身份契约。本文件只定义“受信任认证上下文”的形状与类型范围，
 * 不是认证实现：本批不创建任何接受 actorId / actorCode / author / createdBy
 * 的 HTTP 或 MCP 写入口，真实 OAuth / MCP Actor 认证尚未接入。
 *
 * 与第二关既定 AIActor 模型对齐：AIActor.id 是 UUID，actor_code 是
 * xiaomiao / xiaoke 这类不可变人类代号，actor_type 是 resident_ai |
 * temporary_ai | reviewer 三种正式类型。权限是否允许提交报告由未来
 * permission profile / 授权层决定，本批不擅自用 actorType 代替权限系统。
 */

/** 第二关既定的三种正式 AI Actor 类型。 */
export const AI_ACTOR_TYPES = ['resident_ai', 'temporary_ai', 'reviewer'] as const;
export type AiActorType = (typeof AI_ACTOR_TYPES)[number];

/** actorCode（人类可读代号）的非空受控长度上限，服务层防守性校验使用。 */
export const AI_ACTOR_CODE_MAX_LENGTH = 64;

/**
 * 服务端凭据解析后的最小只读 AI 身份上下文。
 *
 * 信任边界：
 * - 此对象只能由未来认证中间件 / MCP 授权层在验证服务端凭据后构造，并传给
 *   应用服务；绝不接受客户端请求体提交的 actorId / actorCode / author / createdBy；
 * - MCP 临时 Session ID 不能充当 Actor 身份；
 * - 测试可以构造本上下文驱动服务逻辑，但这不等于真实认证已经完成，代码注释
 *   必须保持这一声明；
 * - 字段全部声明为只读：应用服务不得改写受信上下文，身份只能由认证层确定。
 */
export interface AuthenticatedAiActorContext {
  /** 认证中间件写入的稳定唯一 Actor ID（UUID）；作为 StudyReport.actorId 的唯一来源。 */
  readonly actorId: string;
  /** 人类可读代号（如 xiaomiao / xiaoke），用于日志与展示，不是身份依据。 */
  readonly actorCode: string;
  /** 第二关既定三种正式类型之一。 */
  readonly actorType: AiActorType;
}
