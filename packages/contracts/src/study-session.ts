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

/**
 * 历史列表只允许的终态状态。与全量状态枚举是子集关系，用于把历史响应契约
 * 收紧为 `completed | cancelled | interrupted`，运行时只出终态由服务层保证。
 */
export const HISTORY_TERMINAL_STATUSES = ['completed', 'cancelled', 'interrupted'] as const;
export type HistoryTerminalStatus = (typeof HISTORY_TERMINAL_STATUSES)[number];

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
  /** 当前这次暂停的开始时间；运行中 / 恢复后为 null，暂停时写入。 */
  pausedAt: string | null;
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

export interface StartStudySessionInput {
  /** 本次开始基于的版本号，用于乐观并发控制。 */
  expectedVersion: number;
}

export interface PauseStudySessionInput {
  /** 本次暂停基于的版本号，用于乐观并发控制。 */
  expectedVersion: number;
}

export interface ResumeStudySessionInput {
  /** 本次恢复基于的版本号，用于乐观并发控制。 */
  expectedVersion: number;
}

export interface EndStudySessionInput {
  /** 本次结束基于的版本号，用于乐观并发控制。 */
  expectedVersion: number;
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

export const startStudySessionBodySchema = {
  type: 'object',
  required: ['expectedVersion'],
  additionalProperties: false,
  properties: {
    expectedVersion: { type: 'integer', minimum: 1 },
  },
} as const;

export const pauseStudySessionBodySchema = {
  type: 'object',
  required: ['expectedVersion'],
  additionalProperties: false,
  properties: {
    expectedVersion: { type: 'integer', minimum: 1 },
  },
} as const;

export const resumeStudySessionBodySchema = {
  type: 'object',
  required: ['expectedVersion'],
  additionalProperties: false,
  properties: {
    expectedVersion: { type: 'integer', minimum: 1 },
  },
} as const;

export const endStudySessionBodySchema = {
  type: 'object',
  required: ['expectedVersion'],
  additionalProperties: false,
  properties: {
    expectedVersion: { type: 'integer', minimum: 1 },
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
    'pausedAt',
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
    pausedAt: { type: ['string', 'null'] },
    endedAt: { type: ['string', 'null'] },
    actualDurationSeconds: { type: 'integer', minimum: 0 },
    pausedDurationSeconds: { type: 'integer', minimum: 0 },
    status: { enum: [...STUDY_SESSION_STATUSES] },
    version: { type: 'integer', minimum: 1 },
    createdAt: { type: 'string' },
    updatedAt: { type: 'string' },
  },
} as const;

/**
 * 历史条目：终态 Session 在历史列表中的投影（不含 AI / 总结等本批未建立字段）。
 * status 收紧为终态子集、endedAt 收紧为非空字符串：历史以 endedAt 稳定分页，
 * 契约层面不允许非终态或缺失结束时间的条目进入响应。
 */
export interface StudySessionHistoryItem {
  id: string;
  taskText: string | null;
  timerMode: TimerMode;
  status: HistoryTerminalStatus;
  startedAt: string | null;
  endedAt: string;
  actualDurationSeconds: number;
  plannedDurationSeconds: number | null;
  createdAt: string;
}

/** 历史分页响应。nextCursor 为不透明 URL-safe 游标；无更多数据时为 null。 */
export interface StudySessionHistoryPage {
  items: StudySessionHistoryItem[];
  nextCursor: string | null;
}

export const studySessionHistoryItemJsonSchema = {
  type: 'object',
  required: [
    'id',
    'taskText',
    'timerMode',
    'status',
    'startedAt',
    'endedAt',
    'actualDurationSeconds',
    'plannedDurationSeconds',
    'createdAt',
  ],
  additionalProperties: false,
  properties: {
    id: { type: 'string', pattern: UUID_PATTERN },
    taskText: { type: ['string', 'null'], maxLength: TASK_TEXT_MAX_LENGTH },
    timerMode: { enum: [...TIMER_MODES] },
    status: { enum: [...HISTORY_TERMINAL_STATUSES] },
    startedAt: { type: ['string', 'null'] },
    endedAt: { type: 'string' },
    actualDurationSeconds: { type: 'integer', minimum: 0 },
    plannedDurationSeconds: {
      type: ['integer', 'null'],
      minimum: MIN_PLANNED_DURATION_SECONDS,
      maximum: MAX_PLANNED_DURATION_SECONDS,
    },
    createdAt: { type: 'string' },
  },
} as const;

export const studySessionHistoryPageJsonSchema = {
  type: 'object',
  required: ['items', 'nextCursor'],
  additionalProperties: false,
  properties: {
    items: { type: 'array', items: studySessionHistoryItemJsonSchema },
    nextCursor: { type: ['string', 'null'] },
  },
} as const;

/**
 * 历史列表 query 契约。HTTP query 天然是字符串且全局关闭类型强制转换，
 * limit 用数字字符串格式校验（pattern），范围 1..100 由应用层显式转换时检查；
 * 不得为了便利重新开启全局 coerceTypes。
 */
export const studySessionHistoryQuerySchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    limit: { type: 'string', pattern: '^[1-9][0-9]*$' },
    cursor: { type: 'string', minLength: 1 },
  },
} as const;
