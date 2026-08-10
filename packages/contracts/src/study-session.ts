/**
 * StudySession 数据契约，供 Windows 客户端与 VPS 服务端共用。
 * 线上字段使用 camelCase；第六关落 PostgreSQL 时再映射为 snake_case 列名。
 *
 * 本批只实现“创建后、开始前”的草稿配置：状态只能为 created，
 * startedAt / endedAt 恒为空，实际时长与暂停时长恒为 0。
 * 状态流转（running / paused / completed / cancelled / interrupted）
 * 与计时器行为留待后续批次。
 */

import { UUID_PATTERN } from './project.js';

export const STUDY_SESSION_STATUSES = [
  'created',
  'running',
  'paused',
  'completed',
  'cancelled',
  'interrupted',
] as const;
export type StudySessionStatus = (typeof STUDY_SESSION_STATUSES)[number];

export const TIMER_MODES = ['count_up', 'count_down'] as const;
export type TimerMode = (typeof TIMER_MODES)[number];

/** 学习任务正文长度上限（字符数）。 */
export const TASK_TEXT_MAX_LENGTH = 2000;
/** 倒计时设定时长的取值范围：1 秒至 24 小时。 */
export const MIN_PLANNED_DURATION_SECONDS = 1;
export const MAX_PLANNED_DURATION_SECONDS = 86400;

export interface StudySession {
  id: string;
  /** 当前学习任务；草稿阶段可为空。 */
  taskText: string | null;
  timerMode: TimerMode;
  /** 倒计时设定时长；count_up 恒为 null，count_down 允许先以空时长创建草稿。 */
  plannedDurationSeconds: number | null;
  startedAt: string | null;
  endedAt: string | null;
  actualDurationSeconds: number;
  pausedDurationSeconds: number;
  status: StudySessionStatus;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface CreateStudySessionInput {
  /** 客户端生成的 UUID，同时充当幂等键：重试相同 id 不会产生重复 Session。 */
  id: string;
  timerMode: TimerMode;
  taskText?: string | null;
  plannedDurationSeconds?: number | null;
}

export interface SetTaskInput {
  /** 本次修改基于的版本号，用于乐观并发控制。 */
  expectedVersion: number;
  /** 学习任务正文：去除首尾空白后必须非空。 */
  taskText: string;
}

export interface SetCountdownInput {
  /** 本次修改基于的版本号，用于乐观并发控制。 */
  expectedVersion: number;
  /** 倒计时设定时长（整数秒，1..86400）。 */
  plannedDurationSeconds: number;
}

export const studySessionParamsSchema = {
  type: 'object',
  required: ['id'],
  additionalProperties: false,
  properties: { id: { type: 'string', pattern: UUID_PATTERN } },
} as const;

export const createStudySessionBodySchema = {
  type: 'object',
  required: ['id', 'timerMode'],
  additionalProperties: false,
  properties: {
    id: { type: 'string', pattern: UUID_PATTERN },
    timerMode: { enum: [...TIMER_MODES] },
    taskText: { type: ['string', 'null'], maxLength: TASK_TEXT_MAX_LENGTH },
    plannedDurationSeconds: {
      type: ['integer', 'null'],
      minimum: MIN_PLANNED_DURATION_SECONDS,
      maximum: MAX_PLANNED_DURATION_SECONDS,
    },
  },
} as const;

export const setTaskBodySchema = {
  type: 'object',
  required: ['expectedVersion', 'taskText'],
  additionalProperties: false,
  properties: {
    expectedVersion: { type: 'integer', minimum: 1 },
    taskText: { type: 'string', minLength: 1, maxLength: TASK_TEXT_MAX_LENGTH },
  },
} as const;

export const setCountdownBodySchema = {
  type: 'object',
  required: ['expectedVersion', 'plannedDurationSeconds'],
  additionalProperties: false,
  properties: {
    expectedVersion: { type: 'integer', minimum: 1 },
    plannedDurationSeconds: {
      type: 'integer',
      minimum: MIN_PLANNED_DURATION_SECONDS,
      maximum: MAX_PLANNED_DURATION_SECONDS,
    },
  },
} as const;

export const studySessionJsonSchema = {
  type: 'object',
  required: [
    'id',
    'taskText',
    'timerMode',
    'plannedDurationSeconds',
    'startedAt',
    'endedAt',
    'actualDurationSeconds',
    'pausedDurationSeconds',
    'status',
    'version',
    'createdAt',
    'updatedAt',
  ],
  additionalProperties: false,
  properties: {
    id: { type: 'string', pattern: UUID_PATTERN },
    taskText: { type: ['string', 'null'], maxLength: TASK_TEXT_MAX_LENGTH },
    timerMode: { enum: [...TIMER_MODES] },
    plannedDurationSeconds: {
      type: ['integer', 'null'],
      minimum: MIN_PLANNED_DURATION_SECONDS,
      maximum: MAX_PLANNED_DURATION_SECONDS,
    },
    startedAt: { type: ['string', 'null'] },
    endedAt: { type: ['string', 'null'] },
    actualDurationSeconds: { type: 'integer', minimum: 0 },
    pausedDurationSeconds: { type: 'integer', minimum: 0 },
    status: { enum: [...STUDY_SESSION_STATUSES] },
    version: { type: 'integer', minimum: 1 },
    createdAt: { type: 'string' },
    updatedAt: { type: 'string' },
  },
} as const;
