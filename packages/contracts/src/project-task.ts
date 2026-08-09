/**
 * ProjectTask / 正式主进度任务数据契约，供 Windows 客户端与 VPS 服务端共用。
 * 对应第二关报告"二十八、ProjectTask（补充模型）"：保存关卡下的正式主任务和分任务，
 * 与 AI 私人任务（AITask）相互独立。
 * 线上字段使用 camelCase；第六关落 PostgreSQL 时再映射为 snake_case 列名。
 */
import { UUID_PATTERN, projectJsonSchema, type Project } from './project.js';
import { stageJsonSchema, type ProjectStage } from './stage.js';

export const PROJECT_TASK_STATUSES = [
  'not_started',
  'in_progress',
  'pending_review',
  'needs_changes',
  'blocked',
  'completed',
] as const;
export type ProjectTaskStatus = (typeof PROJECT_TASK_STATUSES)[number];

export interface ProjectTask {
  id: string;
  projectId: string;
  stageId: string;
  /** 分任务的父任务；主任务为 null。parent 必须与任务同项目、同关卡。 */
  parentTaskId: string | null;
  title: string;
  description: string | null;
  completionCriteria: string | null;
  status: ProjectTaskStatus;
  /** 同一父级（stage + parentTaskId）下唯一，主任务与分任务各自按此排序。 */
  position: number;
  /** 可选负责 AI；真实身份与权限由服务端 AuthContext 解析（第六关）。 */
  assignedActorId: string | null;
  version: number;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
  archivedAt: string | null;
}

export interface CreateProjectTaskInput {
  /** 客户端生成的 UUID，同时充当幂等键。 */
  id: string;
  /** 可选；提供时创建分任务，必须指向同一项目、同一关卡内的 ProjectTask。 */
  parentTaskId?: string | null;
  title: string;
  description?: string | null;
  completionCriteria?: string | null;
  /** 可选；不提供时由服务端按同一父级最大 position + 1 自动分配。 */
  position?: number;
  assignedActorId?: string | null;
}

/** 任务树节点：任务自身资料 + 按 position 排序的子任务。 */
export interface ProjectTaskNode extends ProjectTask {
  children: ProjectTaskNode[];
}

/** 主进度树中的关卡：自身资料 + 该关卡下的任务／分任务树。 */
export interface ProgressTreeStage extends ProjectStage {
  tasks: ProjectTaskNode[];
}

/** 完整主进度树：项目 + 按 position 升序的关卡，每个关卡携带任务树。 */
export interface ProgressTree {
  project: Project;
  stages: ProgressTreeStage[];
}

export const taskParamsSchema = {
  type: 'object',
  required: ['id'],
  additionalProperties: false,
  properties: { id: { type: 'string', pattern: UUID_PATTERN } },
} as const;

export const stageTaskParamsSchema = {
  type: 'object',
  required: ['projectId', 'stageId'],
  additionalProperties: false,
  properties: {
    projectId: { type: 'string', pattern: UUID_PATTERN },
    stageId: { type: 'string', pattern: UUID_PATTERN },
  },
} as const;

export const createProjectTaskBodySchema = {
  type: 'object',
  required: ['id', 'title'],
  additionalProperties: false,
  properties: {
    id: { type: 'string', pattern: UUID_PATTERN },
    parentTaskId: { type: ['string', 'null'], pattern: UUID_PATTERN },
    title: { type: 'string', minLength: 1, maxLength: 200 },
    description: { type: ['string', 'null'], maxLength: 2000 },
    completionCriteria: { type: ['string', 'null'], maxLength: 5000 },
    position: { type: 'integer', minimum: 1 },
    assignedActorId: { type: ['string', 'null'], maxLength: 64 },
  },
} as const;

export const projectTaskJsonSchema = {
  type: 'object',
  required: [
    'id',
    'projectId',
    'stageId',
    'title',
    'status',
    'position',
    'version',
    'createdAt',
    'updatedAt',
  ],
  additionalProperties: false,
  properties: {
    id: { type: 'string', pattern: UUID_PATTERN },
    projectId: { type: 'string', pattern: UUID_PATTERN },
    stageId: { type: 'string', pattern: UUID_PATTERN },
    parentTaskId: { type: ['string', 'null'], pattern: UUID_PATTERN },
    title: { type: 'string' },
    description: { type: ['string', 'null'] },
    completionCriteria: { type: ['string', 'null'] },
    status: { enum: [...PROJECT_TASK_STATUSES] },
    position: { type: 'integer', minimum: 1 },
    assignedActorId: { type: ['string', 'null'] },
    version: { type: 'integer', minimum: 1 },
    createdAt: { type: 'string' },
    updatedAt: { type: 'string' },
    completedAt: { type: ['string', 'null'] },
    archivedAt: { type: ['string', 'null'] },
  },
} as const;

/** 递归任务树节点：children 通过 $id 自引用实现递归。 */
export const projectTaskNodeJsonSchema = {
  $id: 'projectTaskNode',
  type: 'object',
  required: [
    'id',
    'projectId',
    'stageId',
    'title',
    'status',
    'position',
    'version',
    'createdAt',
    'updatedAt',
    'children',
  ],
  additionalProperties: false,
  properties: {
    ...projectTaskJsonSchema.properties,
    children: { type: 'array', items: { $ref: 'projectTaskNode#' } },
  },
} as const;

/** 主进度树中的关卡：stage 全部字段 + tasks 树。 */
export const progressTreeStageJsonSchema = {
  type: 'object',
  required: [...(stageJsonSchema.required as readonly string[]), 'tasks'],
  additionalProperties: false,
  properties: {
    ...stageJsonSchema.properties,
    tasks: { type: 'array', items: projectTaskNodeJsonSchema },
  },
} as const;

export const progressTreeJsonSchema = {
  type: 'object',
  required: ['project', 'stages'],
  additionalProperties: false,
  properties: {
    project: projectJsonSchema,
    stages: { type: 'array', items: progressTreeStageJsonSchema },
  },
} as const;
