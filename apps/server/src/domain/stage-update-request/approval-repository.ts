import type { ProjectStage, StageUpdateRequest } from '@mingwu/contracts';

/**
 * 批准决定的最小写入字段（受控内部决定命令）。与 decideIfPending 的决定写入保持
 * 同一最小边界：只接收本次允许写入的内容——固定 type、服务层校验后的规范化 note
 * 与两个服务端采样的时间戳——绝不让调用方提交一整份申请对象或目标 status /
 * 新 revision / Stage 字段。
 */
export interface StageUpdateRequestApprovalWrite {
  /** 本入口固定为 approved；仓储按它派生申请目标 status（approved）。 */
  type: 'approved';
  /** 去除首尾空白后的批准说明（服务层已校验非空且按 code point 计数 ≤ 上限）。 */
  note: string;
  /** 服务端采样的决定时间。 */
  decidedAt: string;
  /** 服务端采样的更新（批准）时间。 */
  updatedAt: string;
}

export interface StageUpdateRequestApprovalParams {
  /** 目标申请 id（幂等键）。 */
  requestId: string;
  /** 乐观并发期望版本：批准前请求的当前 revision（本批 pending 恒为 1）。 */
  expectedRevision: number;
  decision: StageUpdateRequestApprovalWrite;
  /** 服务端单次采样的现在时间；批准决定与 Stage 时间字段派生共用同一时刻。 */
  now: string;
}

/**
 * 批准申请的原子仓储操作（Unit of Work）。在同一个临界区内同时校验申请与正式
 * Stage，全部通过后一次性提交两侧：
 * - 校验：申请存在且 pending 且 revision === expectedRevision；真实 Stage 存在且
 *   projectId 与申请归属一致；当前 Stage.version === 申请 expectedStageVersion；
 *   proposedStatus 是受控合法关卡状态；
 * - 提交：申请写为 approved、revision 恰好 +1、只写 decision / updatedAt（核心字段
 *   与 createdAt 来自 current）；Stage 按 proposedStatus 与领域纯函数
 *   deriveStageStatusTransition 派生，目标状态相同时 version / updatedAt 不推进；
 * - 任一前置不满足抛受控领域错误（申请不存在 404、决定 / 版本 / 归属冲突 409、
 *   非法状态 409），request 与 Stage 两侧都不写入，绝不留下“申请已批准但 Stage
 *   未更新”或“Stage 已更新但申请仍 pending”的半完成状态。
 *
 * 内存实现与 StageRepository 普通写入、request-changes / reject 共享同一底层状态
 * （同一 InMemoryStore 的两张 Map）与互斥边界（JS 单线程同步临界区）；第六关
 * PostgreSQL 迁移要求：锁定 / 条件更新 request 与 Stage 的两条写入处于同一数据库
 * 事务，任何一条条件不满足则整体回滚，不得把跨表原子性留给调用方。
 */
export interface StageUpdateRequestApprovalRepository {
  approveIfPending(params: StageUpdateRequestApprovalParams): Promise<{
    request: StageUpdateRequest;
    stage: ProjectStage;
  }>;
}
