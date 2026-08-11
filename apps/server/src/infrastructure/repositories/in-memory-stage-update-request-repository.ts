import type { StageUpdateRequest } from '@mingwu/contracts';
import { StageUpdateRequestIdempotencyConflictError } from '../../domain/stage-update-request/errors.js';
import type {
  InsertIfAbsentResult,
  StageUpdateRequestRepository,
} from '../../domain/stage-update-request/repository.js';
import { sameStageUpdateRequestSemantics } from '../../domain/stage-update-request/semantics.js';

/**
 * 本批接口开发用的内存仓储。JS 单线程模型下，同步 Map 读写构成单个原子临界区，
 * “按 id 查重 + 语义比较 + 插入”不会被打断，同 id 并发提交最多产生一条申请。
 * 业务层不做“先查再写”。
 *
 * 幂等语义：同 id + 同 Stage + 同 Actor + 同 expectedVersion + 同 proposedStatus +
 * 同规范化 reason → 幂等返回已有申请（created=false，不新增）；任一语义不同 →
 * 受控冲突，绝不覆盖。createdAt 不属于语义比较范围，幂等命中返回原申请的 createdAt。
 * 语义比较复用领域层 `sameStageUpdateRequestSemantics`，与服务层预检保持单一来源。
 *
 * 第六关替换为 PostgreSQL 实现时依赖 `stage_update_requests.id` 唯一约束，幂等 /
 * 冲突判断与插入在同一事务内完成；服务层“新 id 读取并校验 Stage 当前版本 +
 * insertIfAbsent”也要在**同一事务**中完成并锁定 / 条件验证 Stage 版本，防止跨表
 * TOCTOU（校验时版本为 v1、插入时已变成 v2 的场景）。本内存原型由单线程原子性
 * 覆盖，不留待数据库阶段才修复的并发缺口。
 */
export class InMemoryStageUpdateRequestRepository implements StageUpdateRequestRepository {
  private readonly byId = new Map<string, StageUpdateRequest>();

  async insertIfAbsent(request: StageUpdateRequest): Promise<InsertIfAbsentResult> {
    const existing = this.byId.get(request.id);
    if (existing) {
      if (sameStageUpdateRequestSemantics(request, existing)) {
        return { request: structuredClone(existing), created: false };
      }
      throw new StageUpdateRequestIdempotencyConflictError(request.id);
    }
    this.byId.set(request.id, structuredClone(request));
    return { request: structuredClone(request), created: true };
  }

  async findById(id: string): Promise<StageUpdateRequest | null> {
    const request = this.byId.get(id);
    return request ? structuredClone(request) : null;
  }

  async listByStage(stageId: string): Promise<StageUpdateRequest[]> {
    const requests: StageUpdateRequest[] = [];
    for (const request of this.byId.values()) {
      if (request.stageId === stageId) {
        requests.push(structuredClone(request));
      }
    }
    return requests;
  }
}
