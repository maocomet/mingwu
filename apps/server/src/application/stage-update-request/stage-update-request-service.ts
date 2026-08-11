import type {
  AuthenticatedAiActorContext,
  RequestChangesInput,
  StageUpdateRequest,
  StageUpdateRequestDecisionType,
  SubmitStageUpdateRequestInput,
} from '@mingwu/contracts';
import {
  AI_ACTOR_CODE_MAX_LENGTH,
  AI_ACTOR_TYPES,
  PROJECT_STAGE_STATUSES,
  STAGE_UPDATE_NOTE_MAX_LENGTH,
  STAGE_UPDATE_REASON_MAX_LENGTH,
  UUID_PATTERN,
  countCodePoints,
} from '@mingwu/contracts';
import { StageNotFoundError, StageVersionConflictError } from '../../domain/stage/errors.js';
import type { StageRepository } from '../../domain/stage/repository.js';
import {
  StageUpdateRequestDecisionConflictError,
  StageUpdateRequestExpectedVersionInvalidError,
  StageUpdateRequestIdempotencyConflictError,
  StageUpdateRequestIdInvalidError,
  StageUpdateRequestNoteInvalidError,
  StageUpdateRequestNotFoundError,
  StageUpdateRequestProposedStatusInvalidError,
  StageUpdateRequestReasonInvalidError,
  StageUpdateRequestRevisionInvalidError,
  StageUpdateRequesterInvalidError,
} from '../../domain/stage-update-request/errors.js';
import type { StageUpdateRequestRepository } from '../../domain/stage-update-request/repository.js';
import {
  sameStageUpdateRequestSemantics,
  type StageUpdateRequestSemantics,
} from '../../domain/stage-update-request/semantics.js';

const UUID_REGEX = new RegExp(UUID_PATTERN);

/**
 * StageUpdateRequest 申请服务。提供“提交申请 + 用户要求补充 / 拒绝决定 + 只读查询”，
 * 不提供任意修改、覆盖、删除或批准申请的方法。身份边界：
 * - 公开 input 只包含 id / stageId / expectedStageVersion / proposedStatus / reason
 *   （提交）与 expectedRevision / note（要求补充 / 拒绝）；
 * - requesterActorId 只从 AuthenticatedAiActorContext 读取，不新增可由客户端指定的
 *   身份字段；
 * - projectId 由服务端读取真实 Stage 后确定，不信任客户端提交的 projectId；
 * - 决定入口为单用户 App API 原型，不接收决定者 Actor；正式用户认证留后续安全批次。
 *
 * 申请与正式主进度隔离：
 * - 本服务只读 Stage（findById），绝不调用 Stage 更新、绝不改变 Stage 的 status /
 *   version / 时间字段；成功前后读取 Stage 必须完全相同；
 * - 仅当申请 id 尚不存在时，才读取真实 Stage 并校验 expectedStageVersion 与当前
 *   Stage.version 一致：不一致返回稳定冲突（复用 StageVersionConflictError），不
 *   创建申请，防止基于陈旧状态的申请；
 * - requestChanges / reject 只修改申请自身的 status / revision / updatedAt /
 *   decision，绝不读取或调用 Stage 更新能力。
 *
 * 身份防线：
 * - 受信上下文必须在写入前通过防守性校验：actorId 是合法 UUID、actorCode 非空且
 *   不超过受控长度、actorType 在既定三种类型内；非法上下文抛
 *   StageUpdateRequesterInvalidError（不泄露身份值），不得写入任何申请；
 * - 权限过滤（default profile + resident_ai / temporary_ai）由 MCP 层的授权策略
 *   （stage-update-policy.ts）负责，服务层不做双重授权判断，但保留输入不变量自守。
 *
 * 并发与幂等：
 * - 完成输入规范化与受信 Actor 基础校验后，先处理已存在的 request id：同语义
 *   直接返回原申请（不再要求当前 Stage 停留在申请所依据的旧版本），任一语义不同
 *   稳定抛 StageUpdateRequestIdempotencyConflictError，不被 Stage 不存在 / 版本
 *   变化等外部状态掩盖；语义比较复用领域层 sameStageUpdateRequestSemantics；
 * - 只有 id 不存在时才读取真实 Stage 校验版本，最终仍通过仓储 insertIfAbsent 原子
 *   落账，以处理“预检后另一并发请求抢先插入”的竞争：同语义 → created=false 幂等
 *   返回已有申请，异语义 → 仓储抛受控冲突，绝不覆盖；
 * - 跨表 TOCTOU：PostgreSQL 阶段“校验 Stage 当前版本 + 插入申请”须在同一事务内
 *   完成并对 Stage 加锁 / 条件验证，本内存原型由 JS 单线程原子性覆盖。
 *
 * 决定（requestChanges / reject）并发与幂等：
 * - 本批一次决定（要求补充或拒绝）即离开 pending 且不可再次决定；成功决定
 *   revision +1 到 2；
 * - 已决定后“完全相同”重试（同规范化 note 且 expectedRevision 等于决定所依据的
 *   版本 revision-1）幂等返回，不再次推进 revision / updatedAt；
 * - 已决定后不同 note / 错误 expectedRevision，或 pending 下 expectedRevision 与
 *   当前 revision 不一致，或并发决定竞争落败 → 稳定 StageUpdateRequestDecisionConflictError
 *   （409），绝不覆盖第一次决定；
 * - 原子性由仓储 decideIfPending CAS 保证，20 个同 revision 并发最多一个决定成功。
 */
export class StageUpdateRequestService {
  constructor(
    private readonly repository: StageUpdateRequestRepository,
    private readonly stageRepository: StageRepository,
    /**
     * 可注入时钟（返回 ISO 字符串）。默认取当前 UTC 时间；
     * 测试传入固定时钟以稳定断言 createdAt。
     */
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}

  /**
   * 提交一条关卡状态更新申请（pending）。
   * - id 非 UUID → StageUpdateRequestIdInvalidError（400）；
   * - reason trim 后为空或按 code point 计数超上限 → StageUpdateRequestReasonInvalidError（400）；
   * - proposedStatus 不在既有合法关卡状态内 → StageUpdateRequestProposedStatusInvalidError（400）；
   * - expectedStageVersion 非正整数 → StageUpdateRequestExpectedVersionInvalidError（400）；
   * - 受信上下文非法 → StageUpdateRequesterInvalidError（内部受控错误，不写入）；
   * - id 已存在：同语义 → 幂等返回原申请；任一语义不同 →
   *   StageUpdateRequestIdempotencyConflictError（409，不读取当前 Stage，不被版本
   *   变化 / Stage 不存在等外部状态掩盖）；
   * - id 不存在时才读取真实 Stage：Stage 不存在 → StageNotFoundError（404）；
   * - expectedStageVersion 与当前版本不一致 → StageVersionConflictError（409，不创建申请）；
   * - 成功后返回完整申请对象（status=pending，revision=1，decision=null，createdAt /
   *   updatedAt 由服务端单次采样写入）。
   */
  async submit(
    authContext: AuthenticatedAiActorContext,
    input: SubmitStageUpdateRequestInput,
  ): Promise<StageUpdateRequest> {
    if (!UUID_REGEX.test(input.id)) {
      throw new StageUpdateRequestIdInvalidError(input.id);
    }
    const reason = input.reason.trim();
    if (reason === '' || countCodePoints(reason) > STAGE_UPDATE_REASON_MAX_LENGTH) {
      throw new StageUpdateRequestReasonInvalidError();
    }
    if (!(PROJECT_STAGE_STATUSES as readonly string[]).includes(input.proposedStatus)) {
      throw new StageUpdateRequestProposedStatusInvalidError();
    }
    if (!Number.isInteger(input.expectedStageVersion) || input.expectedStageVersion < 1) {
      throw new StageUpdateRequestExpectedVersionInvalidError();
    }
    this.assertValidRequesterContext(authContext);

    const semantics: StageUpdateRequestSemantics = {
      stageId: input.stageId,
      requesterActorId: authContext.actorId,
      expectedStageVersion: input.expectedStageVersion,
      proposedStatus: input.proposedStatus,
      reason,
    };

    // 幂等预检：id 已存在时不再读取 / 依赖当前 Stage 状态，先于 Stage 存在性 /
    // 版本校验处理。findById 返回深拷贝，直接返回不污染仓储。
    const existing = await this.repository.findById(input.id);
    if (existing) {
      if (sameStageUpdateRequestSemantics(semantics, existing)) {
        return existing;
      }
      throw new StageUpdateRequestIdempotencyConflictError(input.id);
    }

    // 只有 id 不存在时才读取真实 Stage，校验存在性与当前版本；读取成功前不写任何申请。
    const stage = await this.stageRepository.findById(input.stageId);
    if (!stage) {
      throw new StageNotFoundError(input.stageId);
    }
    if (stage.version !== input.expectedStageVersion) {
      throw new StageVersionConflictError(input.stageId, input.expectedStageVersion);
    }

    const now = this.now();
    const request: StageUpdateRequest = {
      id: input.id,
      projectId: stage.projectId,
      stageId: stage.id,
      requesterActorId: authContext.actorId,
      expectedStageVersion: input.expectedStageVersion,
      proposedStatus: input.proposedStatus,
      reason,
      status: 'pending',
      revision: 1,
      updatedAt: now,
      decision: null,
      createdAt: now,
    };
    // 最终仍通过仓储原子插入落账：处理“预检后另一并发请求抢先插入”的竞争，
    // 同 id 同语义 → created=false 幂等返回已有申请；异语义 → 受控冲突。
    const { request: saved } = await this.repository.insertIfAbsent(request);
    return saved;
  }

  /**
   * 用户“要求 AI 补充说明”：把 pending 申请标记为 needs_changes 并保存决定说明。
   * 校验、稳定幂等与冲突语义见 {@link StageUpdateRequestService.applyDecision}。
   */
  async requestChanges(id: string, input: RequestChangesInput): Promise<StageUpdateRequest> {
    return this.applyDecision(id, input, 'needs_changes');
  }

  /**
   * 用户“拒绝更新申请”：把 pending 申请标记为 rejected 并保存拒绝说明。
   * 校验、稳定幂等与冲突语义见 {@link StageUpdateRequestService.applyDecision}。
   */
  async reject(id: string, input: RequestChangesInput): Promise<StageUpdateRequest> {
    return this.applyDecision(id, input, 'rejected');
  }

  /**
   * 共享决定流程（要求补充 / 拒绝）：校验输入，pending 申请经仓储原子 CAS 离开
   * pending 并写入一次决定。
   * - expectedRevision 非正整数 → StageUpdateRequestRevisionInvalidError（400）；
   * - note trim 后为空或按 code point 计数超上限 → StageUpdateRequestNoteInvalidError（400）；
   * - 申请不存在 → StageUpdateRequestNotFoundError（404）；
   * - 已决定：只有“完全相同”的重试幂等返回原申请（decision.type 匹配 + 同规范化
   *   note + expectedRevision 等于决定所依据的版本 revision-1），不再次推进 revision /
   *   updatedAt；其余（不同 note / 错误 expectedRevision / 已 needs_changes 后
   *   reject / 已 rejected 后 requestChanges）→ StageUpdateRequestDecisionConflictError
   *   （409），绝不覆盖第一次决定；
   * - 仍 pending：expectedRevision 必须等于当前 revision，否则 409；通过后走仓储
   *   原子 decideIfPending（CAS），并发决定竞争落败 → 409；
   * - 只把最小决定命令（type + 规范化 note + 服务端采样时间）交给仓储，目标 status /
   *   revision +1 与核心字段派生全部由仓储从已保存的 current 完成；不读取 / 修改正式 Stage。
   */
  private async applyDecision(
    id: string,
    input: RequestChangesInput,
    type: StageUpdateRequestDecisionType,
  ): Promise<StageUpdateRequest> {
    if (!Number.isInteger(input.expectedRevision) || input.expectedRevision < 1) {
      throw new StageUpdateRequestRevisionInvalidError();
    }
    const note = input.note.trim();
    if (note === '' || countCodePoints(note) > STAGE_UPDATE_NOTE_MAX_LENGTH) {
      throw new StageUpdateRequestNoteInvalidError();
    }

    const existing = await this.repository.findById(id);
    if (!existing) {
      throw new StageUpdateRequestNotFoundError(id);
    }

    // 已决定：只有“完全相同”的重试幂等返回，其余冲突，绝不覆盖第一次决定。
    if (existing.status !== 'pending') {
      if (
        existing.decision &&
        existing.decision.type === type &&
        existing.decision.note === note &&
        input.expectedRevision === existing.revision - 1
      ) {
        return existing;
      }
      throw new StageUpdateRequestDecisionConflictError(id);
    }

    // 仍 pending：expectedRevision 必须等于当前 revision，随后原子 CAS 决定。
    if (input.expectedRevision !== existing.revision) {
      throw new StageUpdateRequestDecisionConflictError(id);
    }
    const now = this.now();
    const saved = await this.repository.decideIfPending(id, input.expectedRevision, {
      type,
      note,
      decidedAt: now,
      updatedAt: now,
    });
    if (!saved) {
      throw new StageUpdateRequestDecisionConflictError(id);
    }
    return saved;
  }

  /** 按 id 读取申请；不存在返回 null。 */
  async getById(id: string): Promise<StageUpdateRequest | null> {
    return this.repository.findById(id);
  }

  /** 按目标关卡列出全部申请（测试与后续用户接口批次使用）。 */
  async listByStage(stageId: string): Promise<StageUpdateRequest[]> {
    return this.repository.listByStage(stageId);
  }

  /**
   * 对受信上下文做写入前防守性校验（第二关 AIActor 模型对齐）。校验失败抛
   * StageUpdateRequesterInvalidError，消息不泄露 actorId / actorCode 等身份值。
   */
  private assertValidRequesterContext(authContext: AuthenticatedAiActorContext): void {
    const valid =
      UUID_REGEX.test(authContext.actorId) &&
      authContext.actorCode.trim() !== '' &&
      authContext.actorCode.length <= AI_ACTOR_CODE_MAX_LENGTH &&
      (AI_ACTOR_TYPES as readonly string[]).includes(authContext.actorType);
    if (!valid) {
      throw new StageUpdateRequesterInvalidError();
    }
  }
}
