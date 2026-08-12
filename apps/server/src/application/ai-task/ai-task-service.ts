import type {
  AiTask,
  AuthenticatedAiActorContext,
  CreateAiTaskInput,
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
  AiTaskDescriptionInvalidError,
  AiTaskIdempotencyConflictError,
  AiTaskIdInvalidError,
  AiTaskParentNotFoundError,
  AiTaskPositionConflictError,
  AiTaskProjectTaskInvalidError,
  AiTaskRequesterInvalidError,
  AiTaskScopeConflictError,
  AiTaskTitleInvalidError,
} from '../../domain/ai-task/errors.js';
import type { AiTaskRepository } from '../../domain/ai-task/repository.js';

const UUID_REGEX = new RegExp(UUID_PATTERN);

/**
 * 自动分配 position 的最大重试次数。position 在同一父级（projectId + ownerActorId +
 * parentTaskId）下单调递增、必然收敛，只要并发创建数低于上限即全部成功。
 */
const AUTO_POSITION_RETRY_LIMIT = 50;

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
