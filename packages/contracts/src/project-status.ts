/**
 * GET /api/v1/projects/:projectId/status 的只读聚合响应契约。
 * 状态从共享的 Project / ProjectStage / ProjectTask 仓储实时计算，不保存第二套
 * 进度快照；所有 byStatus 始终包含完整枚举键（计数为 0 也返回），避免客户端
 * 自行猜测缺失字段。
 */
import type { ProjectStatus } from './project.js';
import { UUID_PATTERN, PROJECT_STATUSES } from './project.js';
import type { ProjectStageStatus } from './stage.js';
import { PROJECT_STAGE_STATUSES } from './stage.js';
import type { ProjectTaskStatus } from './project-task.js';
import { PROJECT_TASK_STATUSES } from './project-task.js';

/** 响应中的 project 摘要，只暴露 id / name / status / version。 */
export interface ProjectStatusProject {
  id: string;
  name: string;
  status: ProjectStatus;
  version: number;
}

/**
 * 当前应关注的关卡；没有符合选择规则的关卡时为 null。
 * 选择优先级：先取 position 最小且状态为 in_progress / pending_review /
 * needs_changes / blocked 的关卡；没有则取 position 最小的 not_started；
 * 再没有则取 position 最小的 locked；全部 completed 或没有关卡时返回 null。
 */
export interface ProjectCurrentStage {
  id: string;
  name: string;
  position: number;
  status: ProjectStageStatus;
  version: number;
}

/** 关卡汇总：total / completed / 七种状态计数。 */
export interface ProjectStageSummary {
  total: number;
  completed: number;
  byStatus: Record<ProjectStageStatus, number>;
}

/** 任务汇总：total / completed / 六种状态计数，含主任务与分任务。 */
export interface ProjectTaskSummary {
  total: number;
  completed: number;
  byStatus: Record<ProjectTaskStatus, number>;
}

/** activeTasks 中的扁平任务摘要，主任务与分任务都以扁平条目出现。 */
export interface ProjectActiveTask {
  id: string;
  stageId: string;
  parentTaskId: string | null;
  title: string;
  status: ProjectTaskStatus;
  position: number;
  assignedActorId: string | null;
}

export interface ProjectCurrentStatus {
  project: ProjectStatusProject;
  currentStage: ProjectCurrentStage | null;
  stageSummary: ProjectStageSummary;
  taskSummary: ProjectTaskSummary;
  overallProgressPercent: number;
  activeTasks: ProjectActiveTask[];
}

const projectStatusProjectJsonSchema = {
  type: 'object',
  required: ['id', 'name', 'status', 'version'],
  additionalProperties: false,
  properties: {
    id: { type: 'string', pattern: UUID_PATTERN },
    name: { type: 'string' },
    status: { enum: [...PROJECT_STATUSES] },
    version: { type: 'integer', minimum: 1 },
  },
} as const;

export const projectCurrentStageJsonSchema = {
  type: 'object',
  required: ['id', 'name', 'position', 'status', 'version'],
  additionalProperties: false,
  properties: {
    id: { type: 'string', pattern: UUID_PATTERN },
    name: { type: 'string' },
    position: { type: 'integer', minimum: 1 },
    status: { enum: [...PROJECT_STAGE_STATUSES] },
    version: { type: 'integer', minimum: 1 },
  },
} as const;

/** 关卡 byStatus：七种键必须全部存在，即使计数为 0。 */
const stageStatusCountJsonSchema = {
  type: 'object',
  required: [...PROJECT_STAGE_STATUSES],
  additionalProperties: false,
  properties: {
    locked: { type: 'integer', minimum: 0 },
    not_started: { type: 'integer', minimum: 0 },
    in_progress: { type: 'integer', minimum: 0 },
    pending_review: { type: 'integer', minimum: 0 },
    needs_changes: { type: 'integer', minimum: 0 },
    blocked: { type: 'integer', minimum: 0 },
    completed: { type: 'integer', minimum: 0 },
  },
} as const;

/** 任务 byStatus：六种键必须全部存在，即使计数为 0。 */
const taskStatusCountJsonSchema = {
  type: 'object',
  required: [...PROJECT_TASK_STATUSES],
  additionalProperties: false,
  properties: {
    not_started: { type: 'integer', minimum: 0 },
    in_progress: { type: 'integer', minimum: 0 },
    pending_review: { type: 'integer', minimum: 0 },
    needs_changes: { type: 'integer', minimum: 0 },
    blocked: { type: 'integer', minimum: 0 },
    completed: { type: 'integer', minimum: 0 },
  },
} as const;

export const projectStageSummaryJsonSchema = {
  type: 'object',
  required: ['total', 'completed', 'byStatus'],
  additionalProperties: false,
  properties: {
    total: { type: 'integer', minimum: 0 },
    completed: { type: 'integer', minimum: 0 },
    byStatus: stageStatusCountJsonSchema,
  },
} as const;

export const projectTaskSummaryJsonSchema = {
  type: 'object',
  required: ['total', 'completed', 'byStatus'],
  additionalProperties: false,
  properties: {
    total: { type: 'integer', minimum: 0 },
    completed: { type: 'integer', minimum: 0 },
    byStatus: taskStatusCountJsonSchema,
  },
} as const;

const projectActiveTaskJsonSchema = {
  type: 'object',
  required: ['id', 'stageId', 'parentTaskId', 'title', 'status', 'position', 'assignedActorId'],
  additionalProperties: false,
  properties: {
    id: { type: 'string', pattern: UUID_PATTERN },
    stageId: { type: 'string', pattern: UUID_PATTERN },
    parentTaskId: { type: ['string', 'null'], pattern: UUID_PATTERN },
    title: { type: 'string' },
    status: { enum: [...PROJECT_TASK_STATUSES] },
    position: { type: 'integer', minimum: 1 },
    assignedActorId: { type: ['string', 'null'] },
  },
} as const;

export const projectStatusJsonSchema = {
  type: 'object',
  required: [
    'project',
    'currentStage',
    'stageSummary',
    'taskSummary',
    'overallProgressPercent',
    'activeTasks',
  ],
  additionalProperties: false,
  properties: {
    project: projectStatusProjectJsonSchema,
    currentStage: {
      type: ['object', 'null'],
      required: ['id', 'name', 'position', 'status', 'version'],
      additionalProperties: false,
      properties: projectCurrentStageJsonSchema.properties,
    },
    stageSummary: projectStageSummaryJsonSchema,
    taskSummary: projectTaskSummaryJsonSchema,
    overallProgressPercent: { type: 'integer', minimum: 0, maximum: 100 },
    activeTasks: { type: 'array', items: projectActiveTaskJsonSchema },
  },
} as const;
