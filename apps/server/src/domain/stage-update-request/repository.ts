import type { StageUpdateRequest } from '@mingwu/contracts';

export interface InsertIfAbsentResult {
  request: StageUpdateRequest;
  /** 本次是否真正插入；false 表示幂等命中已有申请。 */
  created: boolean;
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
  /** 按 id 读取申请，返回深拷贝；不存在返回 null。 */
  findById(id: string): Promise<StageUpdateRequest | null>;
  /** 按目标关卡列出全部申请，返回深拷贝。顺序不保证；稳定排序由应用服务负责。 */
  listByStage(stageId: string): Promise<StageUpdateRequest[]>;
}
