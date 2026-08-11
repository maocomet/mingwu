import type {
  StageUpdateRequest,
  StageUpdateRequestStatus,
} from '@mingwu/contracts';
import { StageUpdateRequestIdempotencyConflictError } from '../../domain/stage-update-request/errors.js';
import type {
  InsertIfAbsentResult,
  StageUpdateRequestDecisionWrite,
  StageUpdateRequestRejectLikeDecisionType,
  StageUpdateRequestRepository,
} from '../../domain/stage-update-request/repository.js';
import { sameStageUpdateRequestSemantics } from '../../domain/stage-update-request/semantics.js';
import {
  createInMemoryStore,
  type InMemoryStore,
} from '../stores/in-memory-store.js';

/**
 * 决定类型 → 申请状态的穷尽白名单。新增决定类型必须在仓储显式声明对应的目标状态，
 * 否则编译期（default 收窄为 never）或运行时（非法 type 走到 default 抛错）都会
 * 拒绝落账——调用方无法通过任意 type / status 覆盖已保存申请。
 */
function statusForDecision(
  type: StageUpdateRequestRejectLikeDecisionType,
): StageUpdateRequestStatus {
  switch (type) {
    case 'needs_changes':
      return 'needs_changes';
    case 'rejected':
      return 'rejected';
    default:
      return assertNever(type);
  }
}

function assertNever(value: never): never {
  throw new Error('unsupported stage update request decision type');
}

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
  private readonly byId: Map<string, StageUpdateRequest>;

  /**
   * 默认自建独立 store 便于仓储单元测试；真实装配（makeServices / index.ts）必须
   * 传入与 Stage 仓储及批准仓储共享的同一 InMemoryStore，保证 request-changes /
   * reject / approve 与 Stage 普通写入共享同一底层状态，不产生双写数据源。
   */
  constructor(private readonly store: InMemoryStore = createInMemoryStore()) {
    this.byId = this.store.stageUpdateRequests;
  }

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

  /**
   * 原子决定：同步 Map 检查 + 写入构成单个临界区，仅当存在且 pending 且
   * revision === expectedRevision 才落盘；任一前置不满足返回 null，不写任何数据。
   * 不提供普通 update，已决定申请绝不被覆盖。
   *
   * 派生规则固定：从已保存的 current 构造新版本，目标 status 由 decision.type 经
   * 穷尽白名单派生（needs_changes → needs_changes，rejected → rejected；非法 type
   * 抛错不落账）、revision 固定 current.revision + 1，只写 decision 与 updatedAt；
   * 原申请核心字段、createdAt 一律来自 current，调用方即使传入任意 decision 字段
   * 也无法改写它们（接口本身不接收这些字段）。
   */
  async decideIfPending(
    id: string,
    expectedRevision: number,
    decision: StageUpdateRequestDecisionWrite,
  ): Promise<StageUpdateRequest | null> {
    const current = this.byId.get(id);
    if (!current || current.status !== 'pending' || current.revision !== expectedRevision) {
      return null;
    }
    const updated: StageUpdateRequest = {
      ...current,
      status: statusForDecision(decision.type),
      revision: current.revision + 1,
      updatedAt: decision.updatedAt,
      decision: {
        type: decision.type,
        note: decision.note,
        decidedAt: decision.decidedAt,
      },
    };
    this.byId.set(id, structuredClone(updated));
    return structuredClone(updated);
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
