import type { McpAuthContext } from '../domain/mcp-auth/mcp-auth-context.js';

/**
 * `project_submit_stage_update` 的最小显式授权策略（接入真实数据库权限表之前的
 * 临时策略）。授权判断集中在这一个可独立测试的小函数里，不把权限字符串散落在
 * 工具回调中；第六关用权限表替换本实现即可，工具回调无需改动。
 *
 * 规则：permissionProfile === 'default' 且 actorType 为 resident_ai 或 temporary_ai
 * 时允许提交关卡更新申请；reviewer、未知 permission profile 或缺失身份一律拒绝。
 * 拒绝结果由调用方返回稳定脱敏错误，绝不泄露内部身份、凭据、申请理由或堆栈。
 *
 * 与 study-report-policy.ts 的 canAppendStudyReport 规则一致（当前默认 profile 对
 * resident_ai / temporary_ai 开放写权限）；保留为独立小函数以便后续单独演进或按
 * 权限表替换，不破坏已验收的 study_append_report。
 */
export function canSubmitStageUpdate(context: McpAuthContext): boolean {
  if (context.permissionProfile !== 'default') {
    return false;
  }
  return context.actorType === 'resident_ai' || context.actorType === 'temporary_ai';
}
