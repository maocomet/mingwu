import type { McpAuthContext } from '../domain/mcp-auth/mcp-auth-context.js';

/**
 * `study_append_report` 的最小显式授权策略（接入真实数据库权限表之前的临时策略）。
 * 授权判断集中在这一个可独立测试的小函数里，不把权限字符串散落在工具回调中；
 * 第六关用权限表替换本实现即可，工具回调无需改动。
 *
 * 规则：permissionProfile === 'default' 且 actorType 为 resident_ai 或 temporary_ai
 * 时允许追加学习报告；reviewer、未知 permission profile 或缺失身份一律拒绝。
 * 拒绝结果由调用方返回稳定脱敏错误，绝不泄露内部身份、凭据、报告正文或堆栈。
 */
export function canAppendStudyReport(context: McpAuthContext): boolean {
  if (context.permissionProfile !== 'default') {
    return false;
  }
  return context.actorType === 'resident_ai' || context.actorType === 'temporary_ai';
}
