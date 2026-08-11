/**
 * StageUpdateRequest 数据契约：AI 提交的关卡状态更新申请。
 *
 * 本批实现“AI 只能申请、不能直接修改正式主进度”的第一段闭环：AI 通过 MCP 以
 * 服务端认证身份提交申请，系统只新增一条待处理申请，绝不直接修改 ProjectStage。
 * 批准、拒绝、要求补充留给后续用户接口批次，本批不实现决定字段。
 *
 * 字段信任边界：
 * - projectId / stageId：由服务端读取真实 Stage 后确定，不信任客户端提交的 projectId；
 * - requesterActorId：只来自服务端认证上下文（authContext.actorId），绝不出现在
 *   公开输入契约中；
 * - expectedStageVersion：申请所依据的 Stage 版本，提交时须与当前版本一致；
 * - reason：trim 后非空，按 Unicode code point 计数受控上限；
 * - status：本批创建时固定 pending，为后续 approved / rejected / needs_changes 预留。
 */

import { UUID_PATTERN } from './project.js';
import { PROJECT_STAGE_STATUSES, type ProjectStageStatus } from './stage.js';

/** 申请处理状态：本批只产生 pending；后续批次按用户决定写入其余三种。 */
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
  /** 本批创建时固定 pending；后续按用户决定写入。禁止伪造决定结果。 */
  status: StageUpdateRequestStatus;
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
    createdAt: { type: 'string' },
  },
} as const;
