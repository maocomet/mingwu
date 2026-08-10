/**
 * StudyReport 数据契约：追加式 AI 学习报告。报告只能追加，不得修改、覆盖或删除；
 * 不同 AI 各自拥有独立序号序列，互不覆盖。本批只建立领域 / 存储基础，不注册
 * 任何 HTTP / MCP 写入口，`actorId` 只由服务端从受信任认证上下文写入。
 */

import { UUID_PATTERN } from './project.js';

/**
 * 报告正文长度上限（Unicode code point 数）。契约 schema、服务校验与测试共用
 * 同一常量；与 StudySummary 独立，不共享 Summary 的上限常量。
 */
export const STUDY_REPORT_CONTENT_MAX_LENGTH = 5000;

export interface StudyReport {
  /** 调用方为幂等重试生成的全局唯一 UUID；不参与序号分配，只作为幂等键。 */
  id: string;
  /** 所属 Session。 */
  studySessionId: string;
  /** 服务端从受信任认证上下文写入的 Actor ID（UUID，与第二关 AIActor.id 一致）；绝不出现在公开输入契约中。 */
  actorId: string;
  /** 同一 Actor 在同一 Session 内从 1 开始连续递增；不同 Actor 独立序列。 */
  sequenceNumber: number;
  /** 去除首尾空白后的报告正文，必须非空。 */
  content: string;
  /** 服务端写入的追加时间；客户端不能提交。 */
  submittedAt: string;
}

export interface AppendStudyReportInput {
  /** 调用方生成的幂等键（UUID）。 */
  id: string;
  /** 所属 Session。 */
  studySessionId: string;
  /** 去除首尾空白后必须非空，且按 Unicode code point 计数不超过 STUDY_REPORT_CONTENT_MAX_LENGTH。 */
  content: string;
}

/**
 * 追加报告请求体严格白名单：只允许 id / studySessionId / content。
 * 全局关闭类型强制转换（coerceTypes:false）；additionalProperties:false 拒绝
 * actorId / actorCode / author / createdBy / sequenceNumber / submittedAt / actorType
 * 等身份、序号或受保护字段——身份只能由服务端认证上下文注入。
 */
export const appendStudyReportInputSchema = {
  type: 'object',
  required: ['id', 'studySessionId', 'content'],
  additionalProperties: false,
  properties: {
    id: { type: 'string', pattern: UUID_PATTERN },
    studySessionId: { type: 'string', pattern: UUID_PATTERN },
    content: { type: 'string', minLength: 1, maxLength: STUDY_REPORT_CONTENT_MAX_LENGTH },
  },
} as const;

/** 报告完整响应契约，供未来 HTTP / MCP 读取入口使用；本批不注册任何读取路由。 */
export const studyReportJsonSchema = {
  type: 'object',
  required: ['id', 'studySessionId', 'actorId', 'sequenceNumber', 'content', 'submittedAt'],
  additionalProperties: false,
  properties: {
    id: { type: 'string', pattern: UUID_PATTERN },
    studySessionId: { type: 'string', pattern: UUID_PATTERN },
    actorId: { type: 'string', pattern: UUID_PATTERN },
    sequenceNumber: { type: 'integer', minimum: 1 },
    content: { type: 'string', minLength: 1, maxLength: STUDY_REPORT_CONTENT_MAX_LENGTH },
    submittedAt: { type: 'string' },
  },
} as const;
