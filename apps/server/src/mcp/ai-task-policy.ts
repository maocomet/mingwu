import type { McpAuthContext } from '../domain/mcp-auth/mcp-auth-context.js';

/**
 * `task_create` 的最小显式授权策略（接入真实数据库权限表之前的临时策略）。
 * 授权判断集中在这一个可独立测试的小函数里，不把权限字符串散落在工具回调中；
 * 第六关用权限表替换本实现即可，工具回调无需改动。
 *
 * 规则（fail-closed）：只有 permissionProfile === 'default' 且 actorType 为
 * resident_ai 的连接可以创建长期 AI 私人任务；temporary_ai、reviewer、未知
 * permission profile 或缺失身份一律拒绝。与 study-report / stage-update 策略不同：
 * AI 私人任务是长期身份才能拥有的工作，临时 AI 只读 / 有限写入，不创建长期任务。
 * 拒绝结果由调用方返回稳定脱敏错误，绝不泄露内部身份、凭据、任务内容或堆栈。
 */
export function canCreateAiTask(context: McpAuthContext): boolean {
  if (context.permissionProfile !== 'default') {
    return false;
  }
  return context.actorType === 'resident_ai';
}
