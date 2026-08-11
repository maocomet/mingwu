import type { ProjectStage, ProjectStageStatus } from '@mingwu/contracts';

export interface StageStatusTransition {
  /** 迁移后的关卡（目标状态与当前相同时为原对象，version / updatedAt 不推进）。 */
  stage: ProjectStage;
  /** 状态是否实际改变；false 表示目标状态与当前相同，version / updatedAt 不推进。 */
  changed: boolean;
}

/**
 * 关卡状态迁移的单一纯函数来源：StageService.setStageStatus 与“批准更新申请”
 * 的原子路径共用同一派生规则，避免批准路径复制后漂移。规则：
 * - 首次进入 in_progress：startedAt 为空则写入 now；
 * - 进入 completed：确保 startedAt 非空并写 completedAt；
 * - 从 completed 离开：清空 completedAt，startedAt 保留（旧状态由未来 AuditLog /
 *   项目历史保存）；
 * - 状态实际改变时 version + 1、刷新 updatedAt；目标状态与当前相同则原样返回、
 *   不推进版本。纯函数不写存储，副作用由调用方负责。
 */
export function deriveStageStatusTransition(
  current: ProjectStage,
  targetStatus: ProjectStageStatus,
  now: string,
): StageStatusTransition {
  if (current.status === targetStatus) {
    return { stage: current, changed: false };
  }

  let startedAt = current.startedAt;
  let completedAt = current.completedAt;

  if (targetStatus === 'in_progress' && startedAt === null) {
    startedAt = now;
  }
  if (targetStatus === 'completed') {
    if (startedAt === null) {
      startedAt = now;
    }
    completedAt = now;
  }
  if (current.status === 'completed') {
    completedAt = null;
  }

  return {
    stage: {
      ...current,
      status: targetStatus,
      startedAt,
      completedAt,
      version: current.version + 1,
      updatedAt: now,
    },
    changed: true,
  };
}
