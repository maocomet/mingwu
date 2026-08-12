/**
 * AITask 数据契约：每个 AI 独立的私人任务树（AI 私人任务），与正式主进度任务
 * ProjectTask 相互独立（第二关报告"三十一、AITask"）。AITask 完成只代表该 AI
 * 的工作完成，绝不代表正式主任务 / 关卡完成，绝不改变 ProjectTask / Stage 正式进度。
 *
 * 信任边界（本批 task_create 写入口）：
 * - ownerActorId：只由服务端从受信认证上下文（authContext.actorId）写入，绝不出现在
 *   公开输入契约中，任何客户端提交的 ownerActorId / actor_id / actorCode 字段都被拒绝；
 * - status / progressPercent / notes / blockerType / blockerReason / position / version /
 *   createdAt / updatedAt / completedAt / archivedAt：本批创建时全部由服务端初始化，
 *   客户端不得提交（task_create 严格白名单拒绝这些字段）；
 * - projectTaskId（可选关联正式任务）：必须属于同一项目，由服务端校验；
 * - parentTaskId（可选父 AI 任务）：必须属于同一项目且同一 owner，由服务端校验；
 * - position：同一 projectId + ownerActorId + parentTaskId 范围内唯一，由服务端自动分配。
 */

import { UUID_PATTERN } from './project.js';

/** AI 私人任务状态。本批创建固定 not_started；后续批次定义其余状态迁移。 */
export const AI_TASK_STATUSES = ['not_started', 'in_progress', 'blocked', 'completed'] as const;
export type AiTaskStatus = (typeof AI_TASK_STATUSES)[number];

/** 任务标题长度上限（Unicode code point 数）。契约 schema、服务校验与测试共用。 */
export const AI_TASK_TITLE_MAX_LENGTH = 200;
/** 任务描述长度上限（Unicode code point 数）。 */
export const AI_TASK_DESCRIPTION_MAX_LENGTH = 2000;
/** 备注单项长度上限（未来"给任务增加备注"使用）。 */
export const AI_TASK_NOTE_MAX_LENGTH = 2000;
/** 备注项数上限。 */
export const AI_TASK_NOTES_MAX_ITEMS = 100;

/** AI 私人任务完整模型。 */
export interface AiTask {
  /** 任务全局唯一 ID（UUID），同时充当幂等键。 */
  id: string;
  /** 所属项目。 */
  projectId: string;
  /** 服务端从受信认证上下文写入的 Owner Actor ID（UUID，与第二关 AIActor.id 一致）。 */
  ownerActorId: string;
  /** 可选关联正式主任务；必须属于同一项目，由服务端校验。 */
  projectTaskId: string | null;
  /** 可选父 AI 任务；必须属于同一项目且同一 owner。 */
  parentTaskId: string | null;
  /** 去除首尾空白后的标题，必须非空。 */
  title: string;
  /** 去除首尾空白后的描述；可空（空字符串规范化后为 null）。 */
  description: string | null;
  /** 本批创建固定 not_started。 */
  status: AiTaskStatus;
  /** 0~100 进度；本批创建固定 0。 */
  progressPercent: number;
  /** 备注列表；本批创建固定空数组，后续"增加备注"批次追加。 */
  notes: string[];
  /** 阻塞类型；本批创建固定 null（无阻塞）。 */
  blockerType: string | null;
  /** 阻塞原因；本批创建固定 null。 */
  blockerReason: string | null;
  /** 同一 projectId + ownerActorId + parentTaskId 范围内唯一；本批由服务端自动分配。 */
  position: number;
  /** 乐观并发版本；本批创建固定 1。 */
  version: number;
  /** 创建时间（服务端写入）。 */
  createdAt: string;
  /** 最近更新时间（服务端写入）。 */
  updatedAt: string;
  /** 完成时间；本批创建固定 null。 */
  completedAt: string | null;
  /** 归档时间；本批创建固定 null。 */
  archivedAt: string | null;
}

/** 创建 AI 任务的公开输入。owner / 状态 / 进度 / 备注 / position / 时间 / version 全部不可提交。 */
export interface CreateAiTaskInput {
  /** 客户端生成的幂等键（UUID）。 */
  id: string;
  /** 所属项目。 */
  projectId: string;
  /** 可选关联正式主任务（必须属于同一项目）。 */
  projectTaskId?: string | null;
  /** 可选父 AI 任务（必须属于同一项目且同一 owner）。 */
  parentTaskId?: string | null;
  /** 去除首尾空白后必须非空，且按 Unicode code point 计数不超过 AI_TASK_TITLE_MAX_LENGTH。 */
  title: string;
  /** 可选描述；可空，按 code point 计数不超过 AI_TASK_DESCRIPTION_MAX_LENGTH。 */
  description?: string | null;
}

/**
 * 创建 AI 任务输入严格白名单（本批不注册 HTTP 路由，仅供 MCP 严格 schema 对齐与
 * 契约测试参考）。additionalProperties:false 拒绝 ownerActorId / actorId / actorCode /
 * status / progressPercent / notes / blockerType / blockerReason / position / version /
 * createdAt / updatedAt / completedAt / archivedAt 等身份、状态或受保护字段——owner 只能
 * 由服务端认证上下文注入，其余由服务端初始化。
 *
 * 长度边界诚实且单一：普通 JSON Schema 无法执行 trim，因此本 schema 只负责类型、
 * UUID 与字段白名单；title 必须“trim 后非空且按 Unicode code point 计数不超过
 * AI_TASK_TITLE_MAX_LENGTH”、description 同理不超过 AI_TASK_DESCRIPTION_MAX_LENGTH，
 * 这两条由共享服务校验 / MCP Zod refine 统一执行（它们都先 trim 再按 code point 计数），
 * 本 schema 不设置 minLength / maxLength，避免对带首尾空白的合法输入产生先于服务的错误拒绝。
 */
export const createAiTaskInputSchema = {
  type: 'object',
  required: ['id', 'projectId', 'title'],
  additionalProperties: false,
  properties: {
    id: { type: 'string', pattern: UUID_PATTERN },
    projectId: { type: 'string', pattern: UUID_PATTERN },
    projectTaskId: { type: ['string', 'null'], pattern: UUID_PATTERN },
    parentTaskId: { type: ['string', 'null'], pattern: UUID_PATTERN },
    title: { type: 'string' },
    description: { type: ['string', 'null'] },
  },
} as const;

/**
 * 修改自己 AI 任务标题 / 描述 的公开输入。owner / 归属 / 状态 / 进度 / 备注 / 阻塞 /
 * position / version / 时间全部不可提交，owner 只能由服务端认证上下文注入。
 * - expectedVersion：必填，整数且 >= 1，乐观并发依据，必须与任务当前 version 一致；
 * - title / description：均为可选，但至少提供一个实际修改字段（description 可用 null
 *   或空白清空，规范化为 null）；
 * - 沿用创建时 trim + Unicode code point 上限语义（服务与 MCP refine 执行）。
 */
export interface UpdateOwnAiTaskInput {
  /** 要修改的任务 UUID。 */
  taskId: string;
  /** 调用方依据的任务当前 version（乐观并发，整数且 >= 1）。 */
  expectedVersion: number;
  /** 可选新标题（trim 后必须非空，且按 Unicode code point 计数不超过 AI_TASK_TITLE_MAX_LENGTH）。 */
  title?: string;
  /** 可选新描述；可空，空白清空规范化为 null，按 code point 计数不超过 AI_TASK_DESCRIPTION_MAX_LENGTH。 */
  description?: string | null;
}

/**
 * 修改自己 AI 任务输入的严格白名单。additionalProperties:false 拒绝 ownerActorId /
 * actorId / actorCode / status / progressPercent / notes / blockerType / blockerReason /
 * position / version / createdAt / updatedAt / completedAt / archivedAt 等身份、状态或受
 * 保护字段；expectedVersion 必须是 >= 1 的整数。anyOf 强制 title / description 至少提供
 * 一个。长度边界诚实且单一：本 schema 只负责类型、UUID 与字段白名单，title / description
 * 的 trim + code point 上限由共享服务校验 / MCP Zod refine 统一执行，本 schema 不设置
 * minLength / maxLength，避免对带首尾空白的合法输入产生先于服务的错误拒绝。
 */
export const updateOwnAiTaskInputSchema = {
  type: 'object',
  required: ['taskId', 'expectedVersion'],
  additionalProperties: false,
  properties: {
    taskId: { type: 'string', pattern: UUID_PATTERN },
    expectedVersion: { type: 'integer', minimum: 1 },
    title: { type: 'string' },
    description: { type: ['string', 'null'] },
  },
  anyOf: [{ required: ['title'] }, { required: ['description'] }],
} as const;

/**
 * 完成自己 AI 任务的公开输入。owner / 归属 / 状态 / 进度 / 备注 / 阻塞 / position /
 * version / 时间全部不可提交，owner 只能由服务端认证上下文注入。
 * - taskId：要完成的任务 UUID；
 * - expectedVersion：必填，整数且 >= 1，乐观并发依据，必须与任务当前 version 一致。
 */
export interface CompleteAiTaskInput {
  /** 要完成的任务 UUID。 */
  taskId: string;
  /** 调用方依据的任务当前 version（乐观并发，整数且 >= 1）。 */
  expectedVersion: number;
}

/**
 * 完成自己 AI 任务输入的严格白名单。additionalProperties:false 拒绝 ownerActorId /
 * actorId / actorCode / status / progressPercent / notes / blockerType / blockerReason /
 * position / version / createdAt / updatedAt / completedAt / archivedAt 等身份、状态或受
 * 保护字段；expectedVersion 必须是 >= 1 的整数。完成只影响自己任务的状态与时间，绝不
 * 直接推进 ProjectTask / Stage / 地图进度（由服务层保证且独立证明）。
 */
export const completeAiTaskInputSchema = {
  type: 'object',
  required: ['taskId', 'expectedVersion'],
  additionalProperties: false,
  properties: {
    taskId: { type: 'string', pattern: UUID_PATTERN },
    expectedVersion: { type: 'integer', minimum: 1 },
  },
} as const;

/** AI 任务完整响应契约。additionalProperties:false，字段不允许未声明内容。
 * required 必须与 TypeScript `AiTask` 接口的全部字段一一对应：值可空（null 合法）
 * 与字段缺失（校验失败）严格区分，工具返回的完整 AiTask 不允许缺少任何一个字段。 */
export const aiTaskJsonSchema = {
  type: 'object',
  required: [
    'id',
    'projectId',
    'ownerActorId',
    'projectTaskId',
    'parentTaskId',
    'title',
    'description',
    'status',
    'progressPercent',
    'notes',
    'blockerType',
    'blockerReason',
    'position',
    'version',
    'createdAt',
    'updatedAt',
    'completedAt',
    'archivedAt',
  ],
  additionalProperties: false,
  properties: {
    id: { type: 'string', pattern: UUID_PATTERN },
    projectId: { type: 'string', pattern: UUID_PATTERN },
    ownerActorId: { type: 'string', pattern: UUID_PATTERN },
    projectTaskId: { type: ['string', 'null'], pattern: UUID_PATTERN },
    parentTaskId: { type: ['string', 'null'], pattern: UUID_PATTERN },
    title: { type: 'string', minLength: 1, maxLength: AI_TASK_TITLE_MAX_LENGTH },
    description: { type: ['string', 'null'], maxLength: AI_TASK_DESCRIPTION_MAX_LENGTH },
    status: { enum: [...AI_TASK_STATUSES] },
    progressPercent: { type: 'integer', minimum: 0, maximum: 100 },
    notes: {
      type: 'array',
      maxItems: AI_TASK_NOTES_MAX_ITEMS,
      items: { type: 'string', maxLength: AI_TASK_NOTE_MAX_LENGTH },
    },
    blockerType: { type: ['string', 'null'] },
    blockerReason: { type: ['string', 'null'] },
    position: { type: 'integer', minimum: 1 },
    version: { type: 'integer', minimum: 1 },
    createdAt: { type: 'string' },
    updatedAt: { type: 'string' },
    completedAt: { type: ['string', 'null'] },
    archivedAt: { type: ['string', 'null'] },
  },
} as const;

/** AI 私人任务树节点：完整 AiTask 字段 + 直接子节点列表。 */
export interface AiTaskNode extends AiTask {
  /**
   * 直接子节点。每层按 position ASC、相同 position 按 id ASC 稳定排序（服务层保证，
   * JSON Schema 无法表达排序，只约束结构）；叶子节点为空数组。
   */
  children: AiTaskNode[];
}

/** 查询自己任务树的响应：tasks 为根节点数组，递归包含完整子树。 */
export interface ListMyTaskTreeResult {
  tasks: AiTaskNode[];
}

/**
 * 任务树节点定义（内嵌在 aiTaskTreeResponseJsonSchema.$defs.aiTaskNode，通过
 * `$ref: '#/$defs/aiTaskNode'` JSON 指针自引用实现任意深度递归）。required 覆盖完整
 * AiTask 的 18 个字段与 children 共 19 个字段；additionalProperties:false 拒绝任何
 * 未声明内容（含身份字段）。排序由服务层保证，本 schema 只约束结构与类型。
 */
const aiTaskNodeDefinition = {
  type: 'object',
  required: [...aiTaskJsonSchema.required, 'children'],
  additionalProperties: false,
  properties: {
    ...aiTaskJsonSchema.properties,
    children: {
      type: 'array',
      items: { $ref: '#/$defs/aiTaskNode' },
    },
  },
} as const;

/**
 * 查询自己任务树（MCP task_list_my_tasks）的完整响应契约。additionalProperties:false
 * 拒绝身份 / session / 凭据等任何未声明内容；tasks 数组项是严格递归的 AiTaskNode。
 */
export const aiTaskTreeResponseJsonSchema = {
  type: 'object',
  required: ['tasks'],
  additionalProperties: false,
  properties: {
    tasks: {
      type: 'array',
      items: { $ref: '#/$defs/aiTaskNode' },
    },
  },
  $defs: {
    aiTaskNode: aiTaskNodeDefinition,
  },
} as const;
