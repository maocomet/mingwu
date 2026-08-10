import type { StudySession } from '@mingwu/contracts';
import type {
  CreateIfAbsentResult,
  StudySessionRepository,
} from '../../domain/study-session/repository.js';

/**
 * 本批接口开发用的内存仓储。并发原子性由 Map 的同步读写保证。
 * 第六关替换为 PostgreSQL 实现时：
 * - createIfAbsent 依赖 id 唯一约束 / `INSERT ... ON CONFLICT DO NOTHING`；
 * - updateIfVersion 依赖 `UPDATE ... WHERE version = expectedVersion` 的行数判断。
 */
export class InMemoryStudySessionRepository implements StudySessionRepository {
  private readonly sessions = new Map<string, StudySession>();

  async findById(id: string): Promise<StudySession | null> {
    const session = this.sessions.get(id);
    return session ? structuredClone(session) : null;
  }

  async createIfAbsent(session: StudySession): Promise<CreateIfAbsentResult> {
    const existing = this.sessions.get(session.id);
    if (existing) {
      return { studySession: structuredClone(existing), created: false };
    }
    this.sessions.set(session.id, structuredClone(session));
    return { studySession: session, created: true };
  }

  async updateIfVersion(session: StudySession, expectedVersion: number): Promise<StudySession | null> {
    const current = this.sessions.get(session.id);
    if (!current || current.version !== expectedVersion) {
      return null;
    }
    this.sessions.set(session.id, structuredClone(session));
    return session;
  }

  async listTerminal(): Promise<StudySession[]> {
    return [...this.sessions.values()]
      .filter(
        (s) => s.status === 'completed' || s.status === 'cancelled' || s.status === 'interrupted',
      )
      .map((s) => structuredClone(s));
  }
}
