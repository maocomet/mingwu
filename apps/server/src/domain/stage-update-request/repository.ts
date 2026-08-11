import type { StageUpdateRequest } from '@mingwu/contracts';

export interface InsertIfAbsentResult {
  request: StageUpdateRequest;
  /** 本次是否真正插入；false 表示幂等命中已有申请。 */
  created: boolean;
}

/**
 * 决定写入的最小字段。仓储只接收“本次允许写入的内容”——本批为服务层校验后的
 * 规范化 note 与两个服务端采样的时间戳——绝不让调用方提交一整份申请对象。
 * 原申请核心字段（id / projectId / stageId / requesterActorId /
 * expectedStageVersion / proposedStatus / reason / createdAt）、目标 status 与
 * 新 revision 一律由仓储从已保存的 current 派生，调用方无法改写。
 */
export interface StageUpdateRequestDecisionWrite {
  /** 去除首尾空白后的决定说明（服务层已校验非空且按 code point 计数 ≤ 上限）。 */
  note: string;
  /** 服务端采样的决定时间。 */
  decidedAt: string;
  /** 服务端采样的更新（决定）时间。 */
  updatedAt: string;
}

/**
 * 仓储接口。申请只可追加，接口不提供修改、覆盖、删除或批准决定的方法。
 * 并发正确性由仓储保证，业务层不在“先查再写”的窗口里做判断：
 * - `id` 原子唯一并作为幂等键：同 id、同 Stage、同 Actor、同 expectedVersion、
 *   同 proposedStatus、同规范化 reason 重试返回已有申请（created=false，不新增）；
 * - 同 id 搭配任一语义不同抛 StageUpdateRequestIdempotencyConflictError，绝不覆盖。
 *
 * PostgreSQL 阶段（第六关）依赖 `stage_update_requests.id` 唯一约束：
 * 先 `SELECT` 判断语义，再 `INSERT ... ON CONFLICT (id) DO NOTHING`，冲突时按
 * 既有行语义做幂等 / 冲突判定，两个操作在同一事务 / 原子语句内完成。
 *
 * 跨表 TOCTOU 注意：服务层对“新 id”先读取真实 Stage、校验 `expectedStageVersion`
 * 与当前版本一致，再插入申请——该“校验 Stage 版本 + 插入申请”两步在 PostgreSQL
 * 中必须在同一事务内完成，并对 Stage 行加锁（`SELECT ... FOR UPDATE`）或对版本做
 * 条件校验，防止校验后、插入前 Stage 版本被并发推进导致基于陈旧版本的申请落账。
 * 本批内存原型由 JS 单线程原子性覆盖该缺口。
 */
export interface StageUpdateRequestRepository {
  /**
   * 原子插入：以 id 命中已有申请做幂等 / 冲突判断；新申请直接保存。
   * 返回请求使用深拷贝，调用方修改不得污染仓储。
   */
  insertIfAbsent(request: StageUpdateRequest): Promise<InsertIfAbsentResult>;
  /**
   * 原子决定（CAS）：仅当 request 存在、当前 status 为 pending 且 revision 等于
   * expectedRevision 时，从已保存的 current 派生新版本并保存；否则返回 null
   * （不写入任何数据）。派生规则固定：status = 'needs_changes'、
   * revision = current.revision + 1，只写 decision（type 固定 needs_changes）与
   * updatedAt；id / projectId / stageId / requesterActorId / expectedStageVersion /
   * proposedStatus / reason / createdAt 全部取自 current，调用方无法改写。
   * 不提供普通任意 update，杜绝覆盖已决定申请。返回的新申请使用深拷贝。
   *
   * PostgreSQL 阶段（第六关）：`UPDATE stage_update_requests SET status =
   * 'needs_changes', revision = revision + 1, updated_at = ?, decision = ? WHERE
   * id = ? AND status = 'pending' AND revision = ?` 的行数判断（或 `SELECT ...
   * FOR UPDATE` 后条件写入）保证 CAS 原子；条件 UPDATE 只 SET 决定所需列，绝不能
   * 接受或覆盖原申请核心列。两个操作在同一事务内完成。
   */
  decideIfPending(
    id: string,
    expectedRevision: number,
    decision: StageUpdateRequestDecisionWrite,
  ): Promise<StageUpdateRequest | null>;
  /** 按 id 读取申请，返回深拷贝；不存在返回 null。 */
  findById(id: string): Promise<StageUpdateRequest | null>;
  /** 按目标关卡列出全部申请，返回深拷贝。顺序不保证；稳定排序由应用服务负责。 */
  listByStage(stageId: string): Promise<StageUpdateRequest[]>;
}
