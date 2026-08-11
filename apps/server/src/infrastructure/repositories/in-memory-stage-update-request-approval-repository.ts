import type { ProjectStage, StageUpdateRequest } from '@mingwu/contracts';
import { PROJECT_STAGE_STATUSES } from '@mingwu/contracts';
import type {
  StageUpdateRequestApprovalParams,
  StageUpdateRequestApprovalRepository,
} from '../../domain/stage-update-request/approval-repository.js';
import {
  StageUpdateRequestDecisionConflictError,
  StageUpdateRequestNotFoundError,
  StageUpdateRequestProposedStatusInvalidError,
  StageUpdateRequestStageOwnershipConflictError,
} from '../../domain/stage-update-request/errors.js';
import { StageNotFoundError, StageVersionConflictError } from '../../domain/stage/errors.js';
import { deriveStageStatusTransition } from '../../domain/stage/status-transition.js';
import {
  createInMemoryStore,
  type InMemoryStore,
} from '../stores/in-memory-store.js';

/**
 * 批准更新申请的原子仓储操作（Unit of Work）。与 request-changes / reject 共用同一
 * 申请 Map、与 StageRepository 普通写入共用同一 Stage Map（共享 InMemoryStore），
 * 因此不存在复制第二份 Map 或双写数据源。JS 单线程模型下，方法体从“读取”到
 * “两处写入完成”不跨 await，构成单个原子临界区：任一前置校验不满足时抛受控领域
 * 错误且两侧都不写入，绝不留下“申请已批准但 Stage 未更新”或“Stage 已更新但申请
 * 仍 pending”的半完成状态。
 *
 * 校验顺序（全部通过才提交，任一失败整体拒绝）：
 * - 申请存在（404）、处于 pending 且 revision === expectedRevision（409 决定冲突）；
 * - 真实 Stage 存在（404）、projectId 与申请归属一致（409 归属冲突）；
 * - 当前 Stage.version === 申请 expectedStageVersion（409 版本冲突，防止基于陈旧
 *   状态的申请静默覆盖较新关卡）；
 * - proposedStatus 是受控合法关卡状态（409 非法状态，防止伪造状态落账）。
 *
 * 派生规则固定：申请目标 status 固定写为 approved（即使调用方传入任意 type 也只写
 * 字面量 approved）、revision 固定 current.revision + 1、只写 decision 与 updatedAt，
 * 核心字段与 createdAt 一律来自 current；Stage 按 proposedStatus 经领域纯函数
 * deriveStageStatusTransition 派生，目标状态与当前相同则 version / updatedAt 不推进。
 *
 * 提交 / 回滚边界：两次写入都在提交前先保存 request 与 Stage 两侧完整旧快照（即本方法
 * 顶部读取的 current / stage），并处于同一个 try / rollback 边界内。任一侧写入抛错——
 * 包括“先真实落账、随后抛错 / 返回失败”的不确定提交——都恢复两侧旧快照（回滚走可信
 * 底层路径 `Map.prototype.set.call`，绕过可能被故障注入覆盖的实例 `.set`），再重新抛出
 * 原始错误；不存在“申请已批准但 Stage 未更新”或“Stage 已更新但申请仍 pending”的半完成
 * 状态。第六关 PostgreSQL 迁移要求：两条写入处于同一数据库事务，任一条件不满足整体回滚。
 */
export class InMemoryStageUpdateRequestApprovalRepository
  implements StageUpdateRequestApprovalRepository
{
  private readonly stages: Map<string, ProjectStage>;
  private readonly stageUpdateRequests: Map<string, StageUpdateRequest>;

  constructor(store: InMemoryStore = createInMemoryStore()) {
    this.stages = store.stages;
    this.stageUpdateRequests = store.stageUpdateRequests;
  }

  async approveIfPending(
    params: StageUpdateRequestApprovalParams,
  ): Promise<{ request: StageUpdateRequest; stage: ProjectStage }> {
    const current = this.stageUpdateRequests.get(params.requestId);
    if (!current) {
      throw new StageUpdateRequestNotFoundError(params.requestId);
    }
    if (current.status !== 'pending' || current.revision !== params.expectedRevision) {
      throw new StageUpdateRequestDecisionConflictError(params.requestId);
    }

    const stage = this.stages.get(current.stageId);
    if (!stage) {
      throw new StageNotFoundError(current.stageId);
    }
    if (stage.projectId !== current.projectId) {
      throw new StageUpdateRequestStageOwnershipConflictError(params.requestId);
    }
    if (stage.version !== current.expectedStageVersion) {
      throw new StageVersionConflictError(current.stageId, current.expectedStageVersion);
    }
    if (!PROJECT_STAGE_STATUSES.includes(current.proposedStatus)) {
      throw new StageUpdateRequestProposedStatusInvalidError();
    }

    // 先计算两个新对象，全部校验通过后再一次性提交。
    const updatedRequest: StageUpdateRequest = {
      ...current,
      status: 'approved',
      revision: current.revision + 1,
      updatedAt: params.decision.updatedAt,
      decision: {
        type: 'approved',
        note: params.decision.note,
        decidedAt: params.decision.decidedAt,
      },
    };
    const { stage: updatedStage } = deriveStageStatusTransition(
      stage,
      current.proposedStatus,
      params.now,
    );

    // 一次性提交两侧（同一同步块）。`current` / `stage` 是本次提交前读取的完整旧快照
    // （本方法内无 await，读取后到提交前不存在并发改动），作为回滚基准。
    // 两次写入都纳入同一个 try / rollback 边界：任一侧写入抛错——包括“先真实落账、
    // 随后抛错”的不确定提交——都必须把 request 与 Stage 两侧都恢复到旧快照，再重新
    // 抛出原始错误，绝不吞错，也不允许“申请已批准但 Stage 未更新”或“Stage 已更新但
    // 申请仍 pending”的半完成状态。故障注入可能覆盖实例 `.set`（先写后抛），因此回滚
    // 使用可信底层路径 `Map.prototype.set.call(...)` 绕过被污染的实例方法，确保能恢复。
    try {
      this.stageUpdateRequests.set(params.requestId, structuredClone(updatedRequest));
      this.stages.set(stage.id, structuredClone(updatedStage));
    } catch (err) {
      Map.prototype.set.call(
        this.stageUpdateRequests,
        params.requestId,
        structuredClone(current),
      );
      Map.prototype.set.call(this.stages, stage.id, structuredClone(stage));
      throw err;
    }

    return {
      request: structuredClone(updatedRequest),
      stage: structuredClone(updatedStage),
    };
  }
}
