/**
 * StageUpdateRequest 数据契约：AI 提交的关卡状态更新申请。
 *
 * 本批实现“AI 只能申请、不能直接修改正式主进度”的第一段闭环：AI 通过 MCP 以
 * 服务端认证身份提交申请，系统只新增一条待处理申请，绝不直接修改 ProjectStage。
 * 已实现的用户决定入口为“要求 AI 补充说明”与“拒绝更新申请”：用户只把 pending
 * 申请标记为 needs_changes / rejected 并保存决定说明，不得批准申请、不得修改正式
 * Stage。批准与批准后更新正式 Stage 留给后续用户接口批次。
 *
 * 字段信任边界：
 * - projectId / stageId：由服务端读取真实 Stage 后确定，不信任客户端提交的 projectId；
 * - requesterActorId：只来自服务端认证上下文（authContext.actorId），绝不出现在
 *   公开输入契约中；
 * - expectedStageVersion：申请所依据的 Stage 版本，提交时须与当前版本一致；
 * - reason：trim 后非空，按 Unicode code point 计数受控上限；
 * - status / revision / decision / createdAt / updatedAt：由服务端写入，客户端
 *   不得提交或伪造；
 * - decision：创建时 null；决定成功后写入固定 { type, note, decidedAt }，
 *   type ∈ needs_changes | rejected，note 为 trim 后的决定说明，decidedAt 由
 *   服务端采样；决定者 Actor 由未来用户认证批次提供，本批不接收。
 */

import { UUID_PATTERN } from './project.js';
import { PROJECT_STAGE_STATUSES, type ProjectStageStatus } from './stage.js';

/** 申请处理状态：本批创建只产生 pending；用户“要求补充”写入 needs_changes，“拒绝”写入 rejected。 */
export const STAGE_UPDATE_REQUEST_STATUSES = [
  'pending',
  'approved',
  'rejected',
  'needs_changes',
] as const;
export type StageUpdateRequestStatus = (typeof STAGE_UPDATE_REQUEST_STATUSES)[number];

/**
 * 申请理由长度上限（Unicode code point 数）。契约 schema、服务校验与 MCP 入口
 * 共用同一常量，避免各处自行硬编码导致边界不一致。
 */
export const STAGE_UPDATE_REASON_MAX_LENGTH = 2000;

/**
 * 决定说明（note）长度上限（Unicode code point 数）。契约 schema 与服务层共用
 * 同一常量，与 reason 上限一致；trim 后必须非空。
 */
export const STAGE_UPDATE_NOTE_MAX_LENGTH = 2000;

/** 已实现的用户决定类型：要求补充（needs_changes）与拒绝（rejected）。 */
export const STAGE_UPDATE_REQUEST_DECISION_TYPES = ['needs_changes', 'rejected'] as const;
export type StageUpdateRequestDecisionType = (typeof STAGE_UPDATE_REQUEST_DECISION_TYPES)[number];

/**
 * 用户决定记录。needs_changes / rejected：type 固定、note 为 trim 后的决定说明、
 * decidedAt 由服务端单次采样写入。决定者 Actor 由未来用户认证批次提供，本批不接收。
 */
export interface StageUpdateRequestDecision {
  type: StageUpdateRequestDecisionType;
  /** 去除首尾空白后的决定说明，必须非空且不超过 STAGE_UPDATE_NOTE_MAX_LENGTH。 */
  note: string;
  /** 服务端写入的决定时间；客户端不能提交。 */
  decidedAt: string;
}

export interface StageUpdateRequest {
  /** 调用方为幂等重试生成的全局唯一 UUID；只作为幂等键，不参与业务序号。 */
  id: string;
  /** 服务端从真实 Stage 读取的项目归属，客户端不得提交或伪造。 */
  projectId: string;
  /** 目标关卡 UUID。 */
  stageId: string;
  /** 服务端从受信任认证上下文写入的申请者 Actor ID（UUID）；绝不出现在公开输入契约中。 */
  requesterActorId: string;
  /** 申请所依据的 Stage 版本；提交时须与当前版本一致，防止基于陈旧状态的申请。 */
  expectedStageVersion: number;
  /** 申请变更到的合法关卡状态（既有 ProjectStageStatus）。 */
  proposedStatus: ProjectStageStatus;
  /** 去除首尾空白后的申请理由，必须非空且不超过 STAGE_UPDATE_REASON_MAX_LENGTH。 */
  reason: string;
  /** 创建时固定 pending；本批“要求补充”写入 needs_changes、“拒绝”写入 rejected。禁止伪造决定结果。 */
  status: StageUpdateRequestStatus;
  /** 创建时 1；每次成功用户决定 +1。客户端不能提交。 */
  revision: number;
  /** 创建时等于 createdAt；每次成功决定由服务端刷新。客户端不能提交。 */
  updatedAt: string;
  /** 创建时 null；本批“要求补充 / 拒绝”成功后包含 needs_changes / rejected 决定。客户端不能提交。 */
  decision: StageUpdateRequestDecision | null;
  /** 服务端写入的申请时间；客户端不能提交。 */
  createdAt: string;
}

export interface SubmitStageUpdateRequestInput {
  /** 调用方生成的幂等键（UUID）。 */
  id: string;
  /** 目标关卡 UUID。 */
  stageId: string;
  /** 申请所依据的 Stage 版本（正整数）。 */
  expectedStageVersion: number;
  /** 申请变更到的合法关卡状态。 */
  proposedStatus: ProjectStageStatus;
  /** 去除首尾空白后必须非空，且按 Unicode code point 计数不超过 STAGE_UPDATE_REASON_MAX_LENGTH。 */
  reason: string;
}

/**
 * 用户决定入口（要求补充 / 拒绝）的输入。本批 App API 代表单用户用户操作（正式
 * 用户认证留后续安全批次），因此不接收决定者 Actor / decidedAt / status /
 * revision / decision type 等受保护字段；实际执行的决定类型由路由对应的服务方法
 * 固定（requestChanges → needs_changes，reject → rejected）。
 */
export interface RequestChangesInput {
  /** 乐观并发期望版本：决定前请求的当前 revision（本批 pending 恒为 1）。 */
  expectedRevision: number;
  /** 去除首尾空白后必须非空，且按 Unicode code point 计数不超过 STAGE_UPDATE_NOTE_MAX_LENGTH。 */
  note: string;
}

/** 决定入口的路径参数：只允许申请 id（UUID）。 */
export const stageUpdateRequestParamsSchema = {
  type: 'object',
  required: ['id'],
  additionalProperties: false,
  properties: {
    id: { type: 'string', pattern: UUID_PATTERN },
  },
} as const;

/**
 * 用户决定请求体严格白名单（要求补充 / 拒绝共用）：只允许 expectedRevision + note。
 * additionalProperties:false 拒绝 status / decision / decidedAt / updatedAt /
 * actorId / requesterActorId / Stage 字段等；expectedRevision 必须是 JSON 整数
 * （coerceTypes:false，数字字符串不会悄悄转换），note 非空且按 code point 计
 * 不超上限。
 */
export const requestChangesBodySchema = {
  type: 'object',
  required: ['expectedRevision', 'note'],
  additionalProperties: false,
  properties: {
    expectedRevision: { type: 'integer', minimum: 1 },
    note: { type: 'string', minLength: 1, maxLength: STAGE_UPDATE_NOTE_MAX_LENGTH },
  },
} as const;

/** 申请完整响应契约，供 MCP 写工具 project_submit_stage_update 与后续读取入口使用。 */
export const stageUpdateRequestJsonSchema = {
  type: 'object',
  required: [
    'id',
    'projectId',
    'stageId',
    'requesterActorId',
    'expectedStageVersion',
    'proposedStatus',
    'reason',
    'status',
    'revision',
    'updatedAt',
    'decision',
    'createdAt',
  ],
  additionalProperties: false,
  properties: {
    id: { type: 'string', pattern: UUID_PATTERN },
    projectId: { type: 'string', pattern: UUID_PATTERN },
    stageId: { type: 'string', pattern: UUID_PATTERN },
    requesterActorId: { type: 'string', pattern: UUID_PATTERN },
    expectedStageVersion: { type: 'integer', minimum: 1 },
    proposedStatus: { enum: [...PROJECT_STAGE_STATUSES] },
    reason: { type: 'string', minLength: 1, maxLength: STAGE_UPDATE_REASON_MAX_LENGTH },
    status: { enum: [...STAGE_UPDATE_REQUEST_STATUSES] },
    revision: { type: 'integer', minimum: 1 },
    updatedAt: { type: 'string' },
    decision: {
      type: ['object', 'null'],
      required: ['type', 'note', 'decidedAt'],
      additionalProperties: false,
      properties: {
        type: { enum: [...STAGE_UPDATE_REQUEST_DECISION_TYPES] },
        note: { type: 'string', minLength: 1, maxLength: STAGE_UPDATE_NOTE_MAX_LENGTH },
        decidedAt: { type: 'string' },
      },
    },
    createdAt: { type: 'string' },
  },
} as const;
