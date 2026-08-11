/**
 * StudySessionDetail 数据契约：单次学习 Session 当前已实现的四部分只读聚合，
 * 供 MCP 只读工具 study_get_session 使用。只聚合目前真实存在的数据：
 * Session、正式总结（可为 null）、真实参与过的 AI 参与者、追加式 AI 学习报告；
 * 音乐关联、AI 显示名、报告提交状态等尚未实现的部分不在此契约内。
 */

import { studyParticipantJsonSchema } from './study-participant.js';
import { studyReportJsonSchema } from './study-report.js';
import { studySessionJsonSchema } from './study-session.js';
import { studySummaryJsonSchema } from './study-summary.js';
import type { StudyParticipant } from './study-participant.js';
import type { StudyReport } from './study-report.js';
import type { StudySession } from './study-session.js';
import type { StudySummary } from './study-summary.js';

export interface StudySessionDetail {
  /** 完整 StudySession（含服务端时间与版本字段）。 */
  session: StudySession;
  /** 用户正式总结；Session 尚无总结时为 null（正常状态，不是错误）。 */
  summary: StudySummary | null;
  /** 真实追加过报告的 AI 参与者，按 joinedAt ASC, actorId ASC 稳定排序；无参与者为空数组。 */
  participants: StudyParticipant[];
  /** AI 学习报告，按 submittedAt ASC, actorId ASC, sequenceNumber ASC 稳定排序；无报告为空数组。 */
  reports: StudyReport[];
}

/**
 * 详情接口不接受任何 query 参数：严格空对象，未知 query（含身份字段）直接 400。
 * 与历史列表的 studySessionHistoryQuerySchema 语义一致，仅本接口完全无参数。
 */
export const studySessionDetailQuerySchema = {
  type: 'object',
  additionalProperties: false,
  properties: {},
} as const;

/** StudySessionDetail 响应契约：组合各子模型 schema，summary 允许为 null。 */
export const studySessionDetailJsonSchema = {
  type: 'object',
  required: ['session', 'summary', 'participants', 'reports'],
  additionalProperties: false,
  properties: {
    session: studySessionJsonSchema,
    summary: { anyOf: [studySummaryJsonSchema, { type: 'null' }] },
    participants: { type: 'array', items: studyParticipantJsonSchema },
    reports: { type: 'array', items: studyReportJsonSchema },
  },
} as const;

/**
 * “当前正在进行的 Session”响应契约：与 study_get_session 相同的四部分聚合，
 * 或 null（当前没有 running / paused 的 Session，是正常成功结果，不是错误）。
 * 供 MCP 只读工具 study_get_current_session 使用。
 */
export const studySessionCurrentDetailJsonSchema = {
  anyOf: [studySessionDetailJsonSchema, { type: 'null' }],
} as const;
