/**
 * StudySummary 数据契约，供 Windows 客户端与 VPS 服务端共用。
 * 一个 Session 最多一份正式用户学习总结，以 studySessionId 唯一，可反复修改。
 *
 * 本批不调用 AI：source=ai_assisted 只作为“内容曾由 AI 辅助”的来源标记，
 * 无论 user 还是 ai_assisted，都必须经过用户确认后才通过本接口保存。
 * AI 参与者、AI 学习报告（StudyReport）与本模型是不同模型 / 仓储，本批不建立。
 */

import { UUID_PATTERN } from './project.js';

export const SUMMARY_SOURCES = ['user', 'ai_assisted'] as const;
export type SummarySource = (typeof SUMMARY_SOURCES)[number];

/**
 * 总结正文长度上限（Unicode code point 数）。契约 schema、服务校验与测试共用同一常量，
 * 避免各处自行硬编码导致边界不一致。
 */
export const SUMMARY_CONTENT_MAX_LENGTH = 5000;

/**
 * 按 Unicode code point 计算字符串长度，与 JSON Schema `maxLength` 的语义一致。
 * JavaScript 的 `String.length` 按 UTF-16 code unit 计数，非 BMP 字符（如 emoji
 * U+1F600 通常占 2 个 code unit）会被多算；契约层校验与服务层保存必须统一按
 * code point，否则恰好 `SUMMARY_CONTENT_MAX_LENGTH` 个 emoji 会通过请求校验却在
 * 服务层被错误拒绝。
 */
export function countCodePoints(value: string): number {
  return Array.from(value).length;
}

export interface StudySummary {
  /** 服务端生成的唯一 ID；客户端不得提交或覆盖。 */
  id: string;
  /** 所属 Session；一个 Session 最多一份正式总结。 */
  studySessionId: string;
  /** 去除首尾空白后的总结正文，必须非空。 */
  content: string;
  /** user=用户自行撰写；ai_assisted=内容曾由 AI 辅助（同样必须用户已确认）。 */
  source: SummarySource;
  /** 初次保存 1；每次修改 +1。 */
  revision: number;
  /** 每次用户确认保存时由服务端写入 / 刷新；客户端不得伪造。 */
  confirmedByUserAt: string;
  createdAt: string;
  updatedAt: string;
}

export interface PutStudySummaryInput {
  /** 去除首尾空白后必须非空，且不超过 SUMMARY_CONTENT_MAX_LENGTH。 */
  content: string;
  source: SummarySource;
  /** 尚无总结时为 0（原子创建）；已有总结时必须为当前 revision（原子更新）。 */
  expectedRevision: number;
}

/**
 * PUT 请求体严格白名单：只允许 content / source / expectedRevision。
 * 全局关闭类型强制转换（coerceTypes:false），expectedRevision 必须是 JSON 整数，
 * 数字字符串不会被悄悄转换成数字；additionalProperties:false 拒绝
 * id / studySessionId / revision / confirmedByUserAt / createdAt / updatedAt / actorId
 * 等受保护或身份字段。
 */
export const studySummaryBodySchema = {
  type: 'object',
  required: ['content', 'source', 'expectedRevision'],
  additionalProperties: false,
  properties: {
    content: { type: 'string', minLength: 1, maxLength: SUMMARY_CONTENT_MAX_LENGTH },
    source: { enum: [...SUMMARY_SOURCES] },
    expectedRevision: { type: 'integer', minimum: 0 },
  },
} as const;

/** Summary 完整响应：不含任何客户端无关字段之外的泄露；status 等 Session 字段不在此模型。 */
export const studySummaryJsonSchema = {
  type: 'object',
  required: [
    'id',
    'studySessionId',
    'content',
    'source',
    'revision',
    'confirmedByUserAt',
    'createdAt',
    'updatedAt',
  ],
  additionalProperties: false,
  properties: {
    id: { type: 'string', pattern: UUID_PATTERN },
    studySessionId: { type: 'string', pattern: UUID_PATTERN },
    content: { type: 'string', minLength: 1, maxLength: SUMMARY_CONTENT_MAX_LENGTH },
    source: { enum: [...SUMMARY_SOURCES] },
    revision: { type: 'integer', minimum: 1 },
    confirmedByUserAt: { type: 'string' },
    createdAt: { type: 'string' },
    updatedAt: { type: 'string' },
  },
} as const;
