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
