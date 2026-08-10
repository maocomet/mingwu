/**
 * StudyParticipant 数据契约：某 Session 中实际追加过学习报告的 AI 参与记录。
 * 一个 Session 最多允许参与的 AI 数量不做硬限制，但每个 `(studySessionId, actorId)`
 * 唯一；只有实际追加过报告的 AI 才在本批自动创建 / 更新参与记录。
 */

import { UUID_PATTERN } from './project.js';

export interface StudyParticipant {
  /** 所属 Session。 */
  studySessionId: string;
  /** 参与 Session 的 AI Actor ID（UUID，与第二关 AIActor.id 一致）；服务端从认证上下文写入。 */
  actorId: string;
  /** 首次追加学习报告的服务器时间；后续追加不改变。 */
  joinedAt: string;
  /** 最近一次追加学习报告的服务器时间；每次真正追加刷新。 */
  lastActiveAt: string;
}

/** Participant 响应契约，供未来 HTTP / MCP 读取入口使用；本批不注册任何读取路由。 */
export const studyParticipantJsonSchema = {
  type: 'object',
  required: ['studySessionId', 'actorId', 'joinedAt', 'lastActiveAt'],
  additionalProperties: false,
  properties: {
    studySessionId: { type: 'string', pattern: UUID_PATTERN },
    actorId: { type: 'string', pattern: UUID_PATTERN },
    joinedAt: { type: 'string' },
    lastActiveAt: { type: 'string' },
  },
} as const;
