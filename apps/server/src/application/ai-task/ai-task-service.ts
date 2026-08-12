import type {
  AiTask,
  AiTaskNode,
  AuthenticatedAiActorContext,
  CompleteAiTaskInput,
  CreateAiTaskInput,
  ListMyTaskTreeResult,
  UpdateOwnAiTaskInput,
} from '@mingwu/contracts';
import {
  AI_ACTOR_CODE_MAX_LENGTH,
  AI_ACTOR_TYPES,
  AI_TASK_DESCRIPTION_MAX_LENGTH,
  AI_TASK_TITLE_MAX_LENGTH,
  UUID_PATTERN,
  countCodePoints,
} from '@mingwu/contracts';
import { ProjectNotFoundError } from '../../domain/project/errors.js';
import type { ProjectRepository } from '../../domain/project/repository.js';
import type { ProjectTaskRepository } from '../../domain/project-task/repository.js';
import {
  AiTaskArchivedError,
  AiTaskDescriptionInvalidError,
  AiTaskIdempotencyConflictError,
  AiTaskIdInvalidError,
  AiTaskNotFoundError,
  AiTaskParentNotFoundError,
  AiTaskPositionConflictError,
  AiTaskProjectTaskInvalidError,
  AiTaskRequesterInvalidError,
  AiTaskScopeConflictError,
  AiTaskTitleInvalidError,
  AiTaskTreeCorruptError,
  AiTaskUpdateInvalidError,
  AiTaskVersionConflictError,
} from '../../domain/ai-task/errors.js';
import type {
  AiTaskRepository,
  UpdateAiTaskContentChanges,
} from '../../domain/ai-task/repository.js';

const UUID_REGEX = new RegExp(UUID_PATTERN);

/**
 * 自动分配 position 的最大重试次数。position 在同一父级（projectId + ownerActorId +
 * parentTaskId）下单调递增、必然收敛，只要并发创建数低于上限即全部成功。
 */
const AUTO_POSITION_RETRY_LIMIT = 50;

/**
 * 任务树最大深度防线。超过即视为数据不一致：防病态深层数据导致遍历过深 / 资源耗尽。
 * 正常树由 position 唯一性约束自然有限，此上限只作为读侧的兜底防线。
 */
const AI_TASK_TREE_MAX_DEPTH = 100;

/** 幂等语义：同 id + 同 project + 同 owner + 同 projectTaskId + 同 parentTaskId +
 * 同规范化标题 / 描述视为同一任务。position 由服务端自动分配，不参与比较。 */
interface CreateAiTaskSemantics {
  projectId: string;
  ownerActorId: string;
  projectTaskId: string | null;
  parentTaskId: string | null;
  title: string;
  description: string | null;
}

function sameCreateSemantics(semantics: CreateAiTaskSemantics, existing: AiTask): boolean {
  return (
    semantics.projectId === existing.projectId &&
    semantics.ownerActorId === existing.ownerActorId &&
    semantics.projectTaskId === existing.projectTaskId &&
    semantics.parentTaskId === existing.parentTaskId &&
    semantics.title === existing.title &&
    semantics.description === existing.description
  );
}

export interface CreateAiTaskResult {
  task: AiTask;
  created: boolean;
}

/**
 * AI 私人任务创建服务。身份边界：
 * - 公开 input 只包含 id / projectId / projectTaskId / parentTaskId / title / description；
 * - ownerActorId 只从 AuthenticatedAiActorContext 读取（MCP 授权层构造），不新增可由
 *   客户端指定的身份字段；
 * - status / progressPercent / notes / blockerType / blockerReason / position / version /
 *   时间字段全部由服务端初始化，客户端不可提交。
 *
 * 身份防线：
 * - 受信上下文必须在写入前通过防守性校验：actorId 是合法 UUID、actorCode 非空且不超过
 *   受控长度、actorType 在既定三种类型内；非法上下文抛 AiTaskRequesterInvalidError
 *   （不泄露身份值），不得写入任何任务；
 * - 是否允许创建（权限 profile + actorType）由 MCP 授权策略（ai-task-policy.ts）负责，
 *   服务层不做双重授权判断，但保留输入不变量自守。
 *
 * 归属校验：
 * - 项目必须存在；
 * - 可选 projectTaskId 必须指向同一项目内已存在的正式 ProjectTask，禁止跨项目关联；
 * - 可选父 AI 任务必须存在，且属于同一项目、同一 owner，禁止跨 Actor / 跨项目挂载。
 *
 * 并发与幂等：
 * - 幂等预检：id 已存在时按同语义直接返回既有任务 / 异语义抛受控冲突，不依赖项目、
 *   正式任务或父任务等外部状态，保证"同 ID 同语义重试返回既有任务"；
 * - 只有 id 不存在时才读取项目 / 正式任务 / 父任务做归属校验，最终仍通过仓储
 *   createIfAbsent 原子落账，处理"预检后另一并发请求抢先插入"的竞争：同语义 →
 *   created=false 幂等返回已有任务，异语义 → 受控冲突，绝不覆盖；
 * - position 在同一父级下唯一：自动分配撞车时重新读取并重算、有界重试。
 *
 * AITask 完成绝不改变 ProjectTask / Stage 正式进度：本服务只写 AITask 仓储，不调用
 * 任何正式任务 / 关卡更新能力。
 */
export class AiTaskService {
  constructor(
    private readonly repository: AiTaskRepository,
    private readonly projectRepository: ProjectRepository,
    private readonly projectTaskRepository: ProjectTaskRepository,
    /**
     * 可注入时钟（返回 ISO 字符串）。默认取当前 UTC 时间；
     * 测试传入固定时钟以稳定断言 createdAt / updatedAt。
     */
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}

  /**
   * 以服务端认证身份创建自己的 AI 私人任务。
   * - id 非 UUID → AiTaskIdInvalidError；
   * - 标题 trim 后为空或按 code point 计数超上限 → AiTaskTitleInvalidError；
   * - 描述 trim 后按 code point 计数超上限 → AiTaskDescriptionInvalidError（trim 后为空
   *   视为无描述，规范化为 null）；
   * - 受信上下文非法 → AiTaskRequesterInvalidError（内部受控错误，不写入）；
   * - id 已存在：同语义 → 幂等返回既有任务；异语义 → AiTaskIdempotencyConflictError，
   *   绝不覆盖；
   * - id 不存在时校验项目 / 正式任务 / 父任务归属；
   * - 成功后返回完整任务（status=not_started，progressPercent=0，notes=[]，无阻塞，
   *   version=1，完成 / 归档时间为空）。
   */
  async create(
    authContext: AuthenticatedAiActorContext,
    input: CreateAiTaskInput,
  ): Promise<CreateAiTaskResult> {
    if (!UUID_REGEX.test(input.id)) {
      throw new AiTaskIdInvalidError();
    }
    const title = input.title.trim();
    if (title === '' || countCodePoints(title) > AI_TASK_TITLE_MAX_LENGTH) {
      throw new AiTaskTitleInvalidError();
    }
    const rawDescription = input.description ?? null;
    const description =
      rawDescription === null ? null : rawDescription.trim() === '' ? null : rawDescription.trim();
    if (description !== null && countCodePoints(description) > AI_TASK_DESCRIPTION_MAX_LENGTH) {
      throw new AiTaskDescriptionInvalidError();
    }
    this.assertValidRequesterContext(authContext);

    const ownerActorId = authContext.actorId;
    const projectTaskId = input.projectTaskId ?? null;
    const parentTaskId = input.parentTaskId ?? null;
    const semantics: CreateAiTaskSemantics = {
      projectId: input.projectId,
      ownerActorId,
      projectTaskId,
      parentTaskId,
      title,
      description,
    };

    // 幂等预检：id 已存在时按同语义返回 / 异语义冲突，不依赖项目 / 正式任务 / 父任务
    // 等外部状态，保证"同 ID 同语义重试返回既有任务"。findById 返回深拷贝，不污染仓储。
    const existing = await this.repository.findById(input.id);
    if (existing) {
      if (sameCreateSemantics(semantics, existing)) {
        return { task: existing, created: false };
      }
      throw new AiTaskIdempotencyConflictError(input.id);
    }

    // 只有 id 不存在时才读取外部状态做归属校验。
    const project = await this.projectRepository.findById(input.projectId);
    if (!project) {
      throw new ProjectNotFoundError(input.projectId);
    }
    if (projectTaskId) {
      const formalTask = await this.projectTaskRepository.findById(projectTaskId);
      if (!formalTask || formalTask.projectId !== input.projectId) {
        throw new AiTaskProjectTaskInvalidError(input.projectId, projectTaskId);
      }
    }
    if (parentTaskId) {
      const parent = await this.repository.findById(parentTaskId);
      if (!parent) {
        throw new AiTaskParentNotFoundError(parentTaskId);
      }
      if (parent.projectId !== input.projectId || parent.ownerActorId !== ownerActorId) {
        throw new AiTaskScopeConflictError(input.projectId, ownerActorId, parentTaskId);
      }
    }

    for (let attempt = 0; attempt < AUTO_POSITION_RETRY_LIMIT; attempt++) {
      const position = await this.nextSiblingPosition(input.projectId, ownerActorId, parentTaskId);
      try {
        return await this.insertTask(
          semantics,
          this.buildTask(semantics, input, title, description, position),
        );
      } catch (err) {
        if (!(err instanceof AiTaskPositionConflictError)) {
          throw err;
        }
        // 自动分配撞车：下一轮重新读取同一父级最新列表并取 max+1。
      }
    }

    const next = await this.nextSiblingPosition(input.projectId, ownerActorId, parentTaskId);
    throw new AiTaskPositionConflictError(input.projectId, ownerActorId, parentTaskId, next);
  }

  /** 按 id 读取任务；不存在返回 null（后续只读批次使用）。 */
  async getById(id: string): Promise<AiTask | null> {
    return this.repository.findById(id);
  }

  /**
   * 以服务端认证身份返回当前项目 + 当前 owner 的完整个人任务树（只读）。
   * - 受信上下文非法 → AiTaskRequesterInvalidError（防守性校验，不读取）；
   * - 项目不存在 → ProjectNotFoundError（受控错误）；
   * - owner 只取服务端 authContext.actorId，调用方不能指定 / 切换 Actor；只读取当前
   *   项目、当前 owner 的任务，绝不返回其他 Actor 或其他项目的数据；
   * - 合法无任务 → `{ tasks: [] }`（正常结果，不是错误）；
   * - 返回深拷贝（节点与 notes 均新建），调用方修改结果不污染仓储；
   * - 树完整性防线：仓储返回的任何任务归属（projectId / ownerActorId）越界、父引用
   *   不存在 / 自引用 / 任意长度循环 / 父子跨项目跨 owner / 访问节点数不等于输入节点
   *   数 → AiTaskTreeCorruptError（固定脱敏，不含 ID，细节只进服务端日志），绝不返回
   *   部分树；
   * - 外发节点用显式白名单投影（只复制契约字段 + 新建 notes / children），仓储对象夹带
   *   的任何运行时额外字段（connectionId / 凭据等）都会被丢弃，不进入响应。
   */
  async listMyTaskTree(
    authContext: AuthenticatedAiActorContext,
    projectId: string,
  ): Promise<ListMyTaskTreeResult> {
    this.assertValidRequesterContext(authContext);
    const project = await this.projectRepository.findById(projectId);
    if (!project) {
      throw new ProjectNotFoundError(projectId);
    }
    const tasks = await this.repository.listByOwner(projectId, authContext.actorId);
    // 读侧信任边界：仓储返回的任务对象可能来自不可信存储，逐节点复核其归属
    // （projectId / ownerActorId）是否真的属于当前作用域，任何不符统一抛
    // AiTaskTreeCorruptError（固定脱敏），绝不返回部分树。
    return { tasks: buildAiTaskTree(tasks, projectId, authContext.actorId) };
  }

  /**
   * 以服务端认证身份修改自己任务的标题 / 描述（只读链路之外的纵向写能力，本批仅支持
   * title / description）。
   * - 受信上下文非法 → AiTaskRequesterInvalidError（防守性校验，不读取不写入）；
   * - taskId 不是合法 UUID → AiTaskIdInvalidError；
   * - title / description 至少提供一个实际修改字段，否则 → AiTaskUpdateInvalidError；
   * - title 沿用创建时 trim + code point 上限语义，非法 → AiTaskTitleInvalidError；
   *   description 可 null / 空白清空（规范化为 null），超上限 → AiTaskDescriptionInvalidError；
   * - 任务不存在与任务属于其他 Actor 返回同一个 AiTaskNotFoundError（固定脱敏，
   *   调用方无法区分"缺失"与"他人任务"，禁止跨 Actor 探测 / 修改）；
   * - 已归档任务拒绝 → AiTaskArchivedError；
   * - expectedVersion 与任务当前 version 不一致（陈旧版本）→ AiTaskVersionConflictError，
   *   不覆盖任何新内容；
   * - 规范化后与现有内容完全相同 → no-op：返回当前任务，不推进 version / updatedAt；
   * - 有实际变化时经仓储原子 CAS（版本检查 + 写入同一原子边界）落账，成功 version +1、
   *   updatedAt 刷新，其余字段不变；
   * - 返回完整白名单投影 AiTask（只含契约 18 个字段），仓储夹带的 runtime 额外字段不得外发；
   * - 绝不改变 ProjectTask / Stage 或任何正式项目进度。
   */
  async updateOwnTask(
    authContext: AuthenticatedAiActorContext,
    input: UpdateOwnAiTaskInput,
  ): Promise<AiTask> {
    this.assertValidRequesterContext(authContext);
    if (!UUID_REGEX.test(input.taskId)) {
      throw new AiTaskIdInvalidError();
    }

    // 规范化 + 校验修改字段（与创建共享同一 trim + code point 上限语义）。
    let title: string | undefined;
    if (input.title !== undefined) {
      const trimmed = input.title.trim();
      if (trimmed === '' || countCodePoints(trimmed) > AI_TASK_TITLE_MAX_LENGTH) {
        throw new AiTaskTitleInvalidError();
      }
      title = trimmed;
    }
    // 未提供（undefined=不改）、显式清空（null）与字符串三种状态都要区分。
    let description: string | null | undefined;
    if (input.description !== undefined) {
      const trimmed =
        input.description === null
          ? null
          : input.description.trim() === ''
            ? null
            : input.description.trim();
      if (trimmed !== null && countCodePoints(trimmed) > AI_TASK_DESCRIPTION_MAX_LENGTH) {
        throw new AiTaskDescriptionInvalidError();
      }
      description = trimmed;
    }
    if (title === undefined && description === undefined) {
      throw new AiTaskUpdateInvalidError();
    }

    const existing = await this.repository.findById(input.taskId);
    // 不存在与属于其他 Actor 使用同一个受控未找到错误：不能向调用方泄露任务是否由他人持有。
    if (existing === null || existing.ownerActorId !== authContext.actorId) {
      throw new AiTaskNotFoundError();
    }
    if (existing.archivedAt !== null) {
      throw new AiTaskArchivedError();
    }
    if (input.expectedVersion !== existing.version) {
      throw new AiTaskVersionConflictError();
    }

    // 规范化后与现有内容完全相同 → no-op：不推进 version / updatedAt，返回当前任务。
    const titleChanged = title !== undefined && title !== existing.title;
    const descriptionChanged =
      description !== undefined && description !== existing.description;
    if (!titleChanged && !descriptionChanged) {
      return toTask(existing);
    }

    // 有实际变化：仓储原子 CAS（版本检查 + 写入同一原子边界），成功 version +1。
    // 只放真正变化的字段：不能把未提供的字段折叠成 undefined 写进 changes，否则对象展开
    // `{...existing, ...changes}` 会把既有字段覆盖成 undefined。
    const changes: UpdateAiTaskContentChanges = {};
    if (titleChanged) {
      changes.title = title;
    }
    if (descriptionChanged) {
      changes.description = description;
    }
    const updated = await this.repository.updateTaskContent({
      id: input.taskId,
      expectedVersion: input.expectedVersion,
      changes,
      updatedAt: this.now(),
    });
    return toTask(updated);
  }

  /**
   * 完成自己的 AI 私人任务（幂等，可安全重试）。
   *
   * 权限与隔离（跨 AI 不可探测）：
   * - 只允许已认证 Actor 完成自己的任务；身份由 authContext 解析，绝不信任客户端输入；
   * - 不存在与外 Actor 的任务返回同一个 AiTaskNotFoundError，外部无法通过完成入口探测
   *   其他 AI 的任务存在性；
   * - 已归档任务拒绝完成（AiTaskArchivedError）。
   *
   * 并发与幂等：
   * - expectedVersion 与任务当前 version 不一致 → AiTaskVersionConflictError（陈旧版本先
   *   于"已完成的 no-op"判定，保证陈旧客户端总是得到冲突而非静默成功）；
   * - 首次完成落账：版本一致且尚未完成 → 仓储原子 CAS，成功设置 status='completed'、
   *   progressPercent=100、completedAt 与 updatedAt 为同一服务端时间、version +1；
   * - 已完成任务 + expectedVersion 一致 → no-op：直接返回当前任务，不推进版本 / 时间，
   *   重复调用安全且不会产生重复副作用。
   *
   * 边界：本方法只写 AiTask 状态，绝不调用 ProjectTask / Stage / StageUpdateRequest
   * 服务，不产生阶段更新申请或审计记录，完成不改变正式任务、关卡或地图进度（独立证明）。
   */
  async completeOwnTask(
    authContext: AuthenticatedAiActorContext,
    input: CompleteAiTaskInput,
  ): Promise<AiTask> {
    this.assertValidRequesterContext(authContext);
    if (!UUID_REGEX.test(input.taskId)) {
      throw new AiTaskIdInvalidError();
    }
    const existing = await this.repository.findById(input.taskId);
    if (existing === null || existing.ownerActorId !== authContext.actorId) {
      throw new AiTaskNotFoundError();
    }
    if (existing.archivedAt !== null) {
      throw new AiTaskArchivedError();
    }
    // 陈旧版本：无论任务是否已完成，版本不一致一律先冲突，客户端刷新后重试。
    if (input.expectedVersion !== existing.version) {
      throw new AiTaskVersionConflictError();
    }
    // 已完成任务 + 版本一致 → no-op：返回当前任务，不推进版本 / 时间，重复调用安全。
    if (existing.status === 'completed') {
      return toTask(existing);
    }
    // 首次完成：仓储原子 CAS（版本检查 + 写入同一原子边界），completedAt 与 updatedAt
    // 使用同一服务端时间，版本 +1。
    const completedAt = this.now();
    const updated = await this.repository.completeTask({
      id: input.taskId,
      expectedVersion: input.expectedVersion,
      completedAt,
    });
    return toTask(updated);
  }

  private async nextSiblingPosition(
    projectId: string,
    ownerActorId: string,
    parentTaskId: string | null,
  ): Promise<number> {
    const tasks = await this.repository.listByOwner(projectId, ownerActorId);
    const siblings = tasks.filter((t) => (t.parentTaskId ?? null) === parentTaskId);
    return siblings.length === 0 ? 1 : Math.max(...siblings.map((t) => t.position)) + 1;
  }

  private buildTask(
    semantics: CreateAiTaskSemantics,
    input: CreateAiTaskInput,
    title: string,
    description: string | null,
    position: number,
  ): AiTask {
    const now = this.now();
    return {
      id: input.id,
      projectId: semantics.projectId,
      ownerActorId: semantics.ownerActorId,
      projectTaskId: semantics.projectTaskId,
      parentTaskId: semantics.parentTaskId,
      title,
      description,
      status: 'not_started',
      progressPercent: 0,
      notes: [],
      blockerType: null,
      blockerReason: null,
      position,
      version: 1,
      createdAt: now,
      updatedAt: now,
      completedAt: null,
      archivedAt: null,
    };
  }

  private async insertTask(
    semantics: CreateAiTaskSemantics,
    task: AiTask,
  ): Promise<CreateAiTaskResult> {
    const { task: existing, created } = await this.repository.createIfAbsent(task);
    if (created) {
      return { task, created: true };
    }
    // 幂等预检后仍可能撞上"另一并发请求抢先插入同一 id"：同语义幂等返回，异语义冲突。
    if (!sameCreateSemantics(semantics, existing)) {
      throw new AiTaskIdempotencyConflictError(task.id);
    }
    return { task: existing, created: false };
  }

  /**
   * 对受信上下文做写入前防守性校验（第二关 AIActor 模型对齐）。校验失败抛
   * AiTaskRequesterInvalidError，消息不泄露 actorId / actorCode 等身份值。
   */
  private assertValidRequesterContext(authContext: AuthenticatedAiActorContext): void {
    const valid =
      UUID_REGEX.test(authContext.actorId) &&
      authContext.actorCode.trim() !== '' &&
      authContext.actorCode.length <= AI_ACTOR_CODE_MAX_LENGTH &&
      (AI_ACTOR_TYPES as readonly string[]).includes(authContext.actorType);
    if (!valid) {
      throw new AiTaskRequesterInvalidError();
    }
  }
}

/**
 * 对同一父级的一层兄弟节点做稳定排序：position ASC，相同 position 按 id ASC。
 * 导出为纯函数以便对"相同 position 按 id"兜底分支做确定性单测——正常数据模型下
 * position 在同一父级唯一，该分支只在异常 / 未来数据中出现，但契约要求仍然明确。
 */
export function sortAiTaskSiblingLevel(level: AiTaskNode[]): AiTaskNode[] {
  return level.sort(
    (a, b) => a.position - b.position || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
}

/**
 * 显式白名单投影（完整 AiTask）：只复制 AiTask 契约声明的 18 个既定字段，并新建 notes
 * 数组。绝不能使用对象展开——仓储对象可能夹带运行时额外字段（connectionId /
 * permissionProfile / token 等），对象展开会把它们原样带进 MCP 响应。此函数保证外发
 * 对象只含契约字段，任何未知字段被丢弃；notes 是新建引用（深拷贝），不共享仓储引用。
 */
function toTask(task: AiTask): AiTask {
  return {
    id: task.id,
    projectId: task.projectId,
    ownerActorId: task.ownerActorId,
    projectTaskId: task.projectTaskId,
    parentTaskId: task.parentTaskId,
    title: task.title,
    description: task.description,
    status: task.status,
    progressPercent: task.progressPercent,
    notes: [...task.notes],
    blockerType: task.blockerType,
    blockerReason: task.blockerReason,
    position: task.position,
    version: task.version,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    completedAt: task.completedAt,
    archivedAt: task.archivedAt,
  };
}

/**
 * 显式白名单投影（AiTaskNode）：完整 AiTask 白名单 + 新建 children 空数组。与 toTask
 * 同源，绝不含对象展开，仓储夹带的任何运行时额外字段在此被丢弃。
 */
function toTaskNode(task: AiTask): AiTaskNode {
  return { ...toTask(task), children: [] };
}

/**
 * 把某项目 + 某 owner 的全部任务组装成完整任务树（纯函数，不触仓储）。
 * projectId / ownerActorId 是读侧信任边界的基准作用域。
 *
 * 信任边界防线（任一命中即抛 AiTaskTreeCorruptError，消息固定脱敏）：
 * - 仓储返回的任何任务 projectId 或 ownerActorId 与当前作用域不符（越界数据）——
 *   绝不能返回部分树 / 跨项目 / 跨 Actor 数据，统一按数据不一致处理；
 * - 父引用不存在：parentTaskId 指向作用域外的任务（孤儿）或任意不存在 ID；
 * - 自引用：parentTaskId === id；
 * - 任意长度循环：沿父链向上出现重复节点；
 * - 深度超过 AI_TASK_TREE_MAX_DEPTH 或最终访问节点数 !== 输入节点数。
 * 绝不能把孤儿提升为根、绝不能静默丢节点。
 *
 * 外发投影：节点用显式白名单构造（toTaskNode），只复制 AiTask 契约的 18 个既定字段
 * 并新建 notes / children，绝不使用对象展开——对象展开会把仓储对象夹带的运行时额外
 * 字段（connectionId / permissionProfile / 凭据等）原样带进响应。
 *
 * 排序：每层 children / 根数组按 position ASC、相同 position 按 id ASC 稳定排序。
 * 返回深拷贝：节点对象与 notes 数组全部新建，调用方修改不污染传入任务。
 */
function buildAiTaskTree(tasks: AiTask[], projectId: string, ownerActorId: string): AiTaskNode[] {
  if (tasks.length === 0) {
    return [];
  }
  const byId = new Map<string, AiTask>();
  for (const task of tasks) byId.set(task.id, task);

  // 读侧信任边界：逐节点复核归属。仓储返回的每个任务必须属于当前项目 + 当前 owner，
  // 任何不符（即使只有一条越界根任务）统一抛 AiTaskTreeCorruptError，绝不返回部分树。
  for (const task of tasks) {
    if (task.projectId !== projectId || task.ownerActorId !== ownerActorId) {
      throw new AiTaskTreeCorruptError();
    }
  }

  // 父引用必须落在当前作用域内；自引用与指向作用域外 / 不存在的父引用都视为不一致。
  for (const task of tasks) {
    if (task.parentTaskId === null) continue;
    if (task.parentTaskId === task.id) throw new AiTaskTreeCorruptError();
    if (!byId.has(task.parentTaskId)) throw new AiTaskTreeCorruptError();
  }

  // 环检测：从每个节点沿父链向上，当前路径上重复即存在任意长度循环。
  const reachesRoot = new Set<string>();
  for (const task of tasks) {
    const path = new Set<string>();
    let cursor: string | null = task.id;
    while (cursor !== null) {
      if (reachesRoot.has(cursor)) break;
      if (path.has(cursor)) throw new AiTaskTreeCorruptError();
      path.add(cursor);
      cursor = byId.get(cursor)!.parentTaskId;
    }
    for (const id of path) reachesRoot.add(id);
  }

  // 组装：每个任务经显式白名单投影新建节点（只复制契约字段 + 新建 notes / children），
  // 按父引用分组挂接；无父的为根。禁止对象展开：夹带的运行时额外字段必须被丢弃。
  const nodes = new Map<string, AiTaskNode>();
  const roots: AiTaskNode[] = [];
  for (const task of tasks) nodes.set(task.id, toTaskNode(task));
  for (const task of tasks) {
    const node = nodes.get(task.id)!;
    if (task.parentTaskId === null) {
      roots.push(node);
    } else {
      nodes.get(task.parentTaskId)!.children.push(node);
    }
  }

  // 每层稳定排序：position ASC，相同 position 按 id ASC（sortAiTaskSiblingLevel 是
  // 导出纯函数，可对"相同 position 按 id"兜底分支做确定性单测）。
  sortAiTaskSiblingLevel(roots);
  for (const node of nodes.values()) sortAiTaskSiblingLevel(node.children);

  // 遍历防线：深度超限或最终访问节点数不等于输入节点数 → 数据不一致。
  let visited = 0;
  const stack: Array<{ node: AiTaskNode; depth: number }> = roots.map((n) => ({
    node: n,
    depth: 1,
  }));
  while (stack.length > 0) {
    const { node, depth } = stack.pop()!;
    visited += 1;
    if (depth > AI_TASK_TREE_MAX_DEPTH) throw new AiTaskTreeCorruptError();
    for (const child of node.children) stack.push({ node: child, depth: depth + 1 });
  }
  if (visited !== tasks.length) throw new AiTaskTreeCorruptError();

  return roots;
}
