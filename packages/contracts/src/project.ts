/**
 * Project 数据契约，供 Windows 客户端与 VPS 服务端共用。
 * 线上字段使用 camelCase；第六关落 PostgreSQL 时再映射为 snake_case 列名。
 */

export const PROJECT_STATUSES = ['active', 'paused', 'completed', 'archived'] as const;
export type ProjectStatus = (typeof PROJECT_STATUSES)[number];

export const UUID_PATTERN =
  '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';

export interface Project {
  id: string;
  name: string;
  description: string | null;
  goal: string | null;
  scope: string | null;
  currentVersion: string | null;
  currentVersionGoal: string | null;
  coreFeatures: string | null;
  outOfScope: string | null;
  importantPrinciples: string | null;
  status: ProjectStatus;
  version: number;
  createdAt: string;
  updatedAt: string;
  archivedAt: string | null;
}

export interface CreateProjectInput {
  /** 客户端生成的 UUID，同时充当幂等键：重试相同 id 不会产生重复项目。 */
  id: string;
  name: string;
  description?: string | null;
  goal?: string | null;
  scope?: string | null;
  currentVersion?: string | null;
  currentVersionGoal?: string | null;
  coreFeatures?: string | null;
  outOfScope?: string | null;
  importantPrinciples?: string | null;
}

export interface UpdateProjectInput {
  /** 本次修改基于的版本号，用于乐观并发控制。 */
  expectedVersion: number;
  name?: string;
  description?: string | null;
  goal?: string | null;
  scope?: string | null;
  currentVersion?: string | null;
  currentVersionGoal?: string | null;
  coreFeatures?: string | null;
  outOfScope?: string | null;
  importantPrinciples?: string | null;
  status?: ProjectStatus;
}

const nullableText = (maxLength: number) => ({
  type: ['string', 'null'],
  maxLength,
});

const nullableTextField = {
  description: nullableText(2000),
  goal: nullableText(2000),
  scope: nullableText(2000),
  currentVersion: nullableText(100),
  currentVersionGoal: nullableText(2000),
  coreFeatures: nullableText(5000),
  outOfScope: nullableText(5000),
  importantPrinciples: nullableText(5000),
};

export const projectParamsSchema = {
  type: 'object',
  required: ['id'],
  additionalProperties: false,
  properties: { id: { type: 'string', pattern: UUID_PATTERN } },
} as const;

export const createProjectBodySchema = {
  type: 'object',
  required: ['id', 'name'],
  additionalProperties: false,
  properties: {
    id: { type: 'string', pattern: UUID_PATTERN },
    name: { type: 'string', minLength: 1, maxLength: 200 },
    ...nullableTextField,
  },
} as const;

export const updateProjectBodySchema = {
  type: 'object',
  required: ['expectedVersion'],
  additionalProperties: false,
  properties: {
    expectedVersion: { type: 'integer', minimum: 1 },
    name: { type: 'string', minLength: 1, maxLength: 200 },
    status: { enum: [...PROJECT_STATUSES] },
    ...nullableTextField,
  },
} as const;

export const projectJsonSchema = {
  type: 'object',
  required: ['id', 'name', 'status', 'version', 'createdAt', 'updatedAt'],
  additionalProperties: false,
  properties: {
    id: { type: 'string', pattern: UUID_PATTERN },
    name: { type: 'string' },
    ...nullableTextField,
    status: { enum: [...PROJECT_STATUSES] },
    version: { type: 'integer', minimum: 1 },
    createdAt: { type: 'string' },
    updatedAt: { type: 'string' },
    archivedAt: { type: ['string', 'null'] },
  },
} as const;
