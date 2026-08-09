/**
 * ProjectStage / 关卡数据契约，供 Windows 客户端与 VPS 服务端共用。
 * 主进度树（ProgressTree / ProgressTreeStage）定义在 project-task.ts。
 * 线上字段使用 camelCase；第六关落 PostgreSQL 时再映射为 snake_case 列名。
 */
import { UUID_PATTERN } from './project.js';

export const PROJECT_STAGE_STATUSES = [
  'locked',
  'not_started',
  'in_progress',
  'pending_review',
  'needs_changes',
  'blocked',
  'completed',
] as const;
export type ProjectStageStatus = (typeof PROJECT_STAGE_STATUSES)[number];

export interface ProjectStage {
  id: string;
  projectId: string;
  name: string;
  description: string | null;
  /** 关卡顺序，同一项目内唯一。 */
  position: number;
  completionCriteria: string | null;
  status: ProjectStageStatus;
  startedAt: string | null;
  completedAt: string | null;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface CreateStageInput {
  /** 客户端生成的 UUID，同时充当幂等键。 */
  id: string;
  name: string;
  description?: string | null;
  /** 可选；不提供时由服务端按同项目最大 position + 1 自动分配。 */
  position?: number;
  completionCriteria?: string | null;
}

/**
 * 修改关卡基础信息：必须携带 expectedVersion 且至少提供一个可修改字段。
 * 只允许修改 name / description / completionCriteria / position；
 * projectId、status、startedAt、completedAt、version、createdAt 一律不允许经此修改。
 */
export interface UpdateStageInput {
  expectedVersion: number;
  name?: string;
  description?: string | null;
  completionCriteria?: string | null;
  position?: number;
}

/** 设置关卡状态：只允许 status 与 expectedVersion，禁止携带任何身份字段。 */
export interface SetStageStatusInput {
  status: ProjectStageStatus;
  expectedVersion: number;
}

export const projectIdParamsSchema = {
  type: 'object',
  required: ['projectId'],
  additionalProperties: false,
  properties: { projectId: { type: 'string', pattern: UUID_PATTERN } },
} as const;

export const stageParamsSchema = {
  type: 'object',
  required: ['id'],
  additionalProperties: false,
  properties: { id: { type: 'string', pattern: UUID_PATTERN } },
} as const;

export const createStageBodySchema = {
  type: 'object',
  required: ['id', 'name'],
  additionalProperties: false,
  properties: {
    id: { type: 'string', pattern: UUID_PATTERN },
    name: { type: 'string', minLength: 1, maxLength: 200 },
    description: { type: ['string', 'null'], maxLength: 2000 },
    position: { type: 'integer', minimum: 1 },
    completionCriteria: { type: ['string', 'null'], maxLength: 5000 },
  },
} as const;

export const updateStageBodySchema = {
  type: 'object',
  required: ['expectedVersion'],
  additionalProperties: false,
  // 至少提供一个可修改字段，空修改体（仅 expectedVersion）返回 400。
  anyOf: [
    { required: ['name'] },
    { required: ['description'] },
    { required: ['completionCriteria'] },
    { required: ['position'] },
  ],
  properties: {
    expectedVersion: { type: 'integer', minimum: 1 },
    name: { type: 'string', minLength: 1, maxLength: 200 },
    description: { type: ['string', 'null'], maxLength: 2000 },
    completionCriteria: { type: ['string', 'null'], maxLength: 5000 },
    position: { type: 'integer', minimum: 1 },
  },
} as const;

export const setStageStatusBodySchema = {
  type: 'object',
  required: ['status', 'expectedVersion'],
  additionalProperties: false,
  properties: {
    status: { enum: [...PROJECT_STAGE_STATUSES] },
    expectedVersion: { type: 'integer', minimum: 1 },
  },
} as const;

export const stageJsonSchema = {
  type: 'object',
  required: ['id', 'projectId', 'name', 'position', 'status', 'version', 'createdAt', 'updatedAt'],
  additionalProperties: false,
  properties: {
    id: { type: 'string', pattern: UUID_PATTERN },
    projectId: { type: 'string', pattern: UUID_PATTERN },
    name: { type: 'string' },
    description: { type: ['string', 'null'] },
    position: { type: 'integer', minimum: 1 },
    completionCriteria: { type: ['string', 'null'] },
    status: { enum: [...PROJECT_STAGE_STATUSES] },
    startedAt: { type: ['string', 'null'] },
    completedAt: { type: ['string', 'null'] },
    version: { type: 'integer', minimum: 1 },
    createdAt: { type: 'string' },
    updatedAt: { type: 'string' },
  },
} as const;
