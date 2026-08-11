import type { StageUpdateRequest } from '@mingwu/contracts';

/**
 * 申请幂等语义键：stageId + requesterActorId + expectedStageVersion +
 * proposedStatus + 规范化 reason。projectId 由 stageId 派生、status / createdAt
 * 由服务端决定，均不属于语义比较范围。
 */
export type StageUpdateRequestSemantics = Pick<
  StageUpdateRequest,
  'stageId' | 'requesterActorId' | 'expectedStageVersion' | 'proposedStatus' | 'reason'
>;

/**
 * 幂等语义比较的单一来源。服务层的“已存在 id 预检”与仓储 `insertIfAbsent` 的
 * 冲突判定复用同一函数，避免两处实现各自演进后漂移；仓储最终原子插入不被削弱。
 */
export function sameStageUpdateRequestSemantics(
  a: StageUpdateRequestSemantics,
  b: StageUpdateRequestSemantics,
): boolean {
  return (
    a.stageId === b.stageId &&
    a.requesterActorId === b.requesterActorId &&
    a.expectedStageVersion === b.expectedStageVersion &&
    a.proposedStatus === b.proposedStatus &&
    a.reason === b.reason
  );
}
