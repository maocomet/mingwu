import type { StudyParticipant } from '@mingwu/contracts';
import type {
  StudyParticipantRepository,
  UpsertParticipantResult,
} from '../../domain/study-participant/repository.js';

/**
 * 本批接口开发用的内存仓储。以 (studySessionId, actorId) 为主键，JS 单线程模型下
 * 同步 Map 读写保证 upsert 原子性：首次写入 joinedAt，后续只刷新 lastActiveAt，
 * 绝不产生第二条参与记录。
 *
 * lastActiveAt 单调语义：已存在的参与记录只能被“较晚”的时间刷新，较早的
 * 传入时间（如旧报告幂等重试）不得使其倒退。
 *
 * 第六关替换为 PostgreSQL 实现时依赖 (study_session_id, actor_id) 唯一约束：
 * `INSERT ... ON CONFLICT (study_session_id, actor_id)
 *  DO UPDATE SET last_active_at =
 *    GREATEST(study_participants.last_active_at, EXCLUDED.last_active_at)`。
 * 所有返回使用结构化拷贝，调用方修改不得污染仓储。
 */
export class InMemoryStudyParticipantRepository implements StudyParticipantRepository {
  /** studySessionId → actorId → 参与记录。 */
  private readonly bySession = new Map<string, Map<string, StudyParticipant>>();

  async upsert(participant: StudyParticipant): Promise<UpsertParticipantResult> {
    const perSession = this.bySession.get(participant.studySessionId);
    if (!perSession) {
      const fresh = new Map<string, StudyParticipant>();
      fresh.set(participant.actorId, structuredClone(participant));
      this.bySession.set(participant.studySessionId, fresh);
      return { participant: structuredClone(participant), joined: true };
    }
    const existing = perSession.get(participant.actorId);
    if (!existing) {
      perSession.set(participant.actorId, structuredClone(participant));
      return { participant: structuredClone(participant), joined: true };
    }
    // 已存在：joinedAt 保留（...existing），lastActiveAt 只取现值与传入时间的
    // 较晚者——幂等重试 / 旧报告重试不得让时间倒退。
    const refreshed: StudyParticipant = {
      ...existing,
      lastActiveAt:
        existing.lastActiveAt >= participant.lastActiveAt
          ? existing.lastActiveAt
          : participant.lastActiveAt,
    };
    perSession.set(participant.actorId, structuredClone(refreshed));
    return { participant: structuredClone(refreshed), joined: false };
  }

  async listBySession(studySessionId: string): Promise<StudyParticipant[]> {
    const perSession = this.bySession.get(studySessionId);
    if (!perSession) {
      return [];
    }
    return Array.from(perSession.values(), (p) => structuredClone(p));
  }
}
