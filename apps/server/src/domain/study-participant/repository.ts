import type { StudyParticipant } from '@mingwu/contracts';

export interface UpsertParticipantResult {
  participant: StudyParticipant;
  /** 本次是否首次加入；false 表示已存在，仅刷新 lastActiveAt。 */
  joined: boolean;
}

/**
 * 仓储接口。以 (studySessionId, actorId) 唯一，并发正确性由仓储保证：
 * - 首次写入 joinedAt 与 lastActiveAt（均为服务端传入的同一时间）；
 * - 已存在只刷新 lastActiveAt，joinedAt 保留，绝不产生第二条参与记录；
 * - 不参与的 AI 不创建记录，不显示“未提交”。
 *
 * PostgreSQL 阶段（第六关）：依赖 (study_session_id, actor_id) 唯一约束，
 * `INSERT ... ON CONFLICT (study_session_id, actor_id)
 *  DO UPDATE SET last_active_at = EXCLUDED.last_active_at`。
 */
export interface StudyParticipantRepository {
  /** 原子 upsert。返回的 participant 使用深拷贝。 */
  upsert(participant: StudyParticipant): Promise<UpsertParticipantResult>;
  /**
   * 按 Session 列出参与者，返回深拷贝。顺序不保证；
   * 稳定排序（joinedAt ASC, actorId ASC）由应用服务负责。
   */
  listBySession(studySessionId: string): Promise<StudyParticipant[]>;
}
