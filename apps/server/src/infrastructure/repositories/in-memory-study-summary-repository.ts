import type { StudySummary } from '@mingwu/contracts';
import type {
  CreateIfAbsentResult,
  StudySummaryRepository,
} from '../../domain/study-summary/repository.js';

/**
 * 本批接口开发用的内存仓储。以 studySessionId 为主键，Map 的同步读写保证
 * 单进程内的原子性（JS 单线程模型下同步 Map 操作不会被并发打断）。
 * 并发正确性（create-if-absent / CAS）由此保证，业务层不做“先查再写”。
 *
 * 第六关替换为 PostgreSQL 实现时：
 * - createIfAbsent 依赖 `study_session_id` 唯一约束 / `INSERT ... ON CONFLICT DO NOTHING`；
 * - updateIfRevision 依赖 `UPDATE ... WHERE study_session_id = ? AND revision = ?`
 *   的行数判断；
 * - 所有返回都使用结构化拷贝，调用方修改不得污染仓储。
 */
export class InMemoryStudySummaryRepository implements StudySummaryRepository {
  private readonly summaries = new Map<string, StudySummary>();

  async findByStudySessionId(studySessionId: string): Promise<StudySummary | null> {
    const summary = this.summaries.get(studySessionId);
    return summary ? structuredClone(summary) : null;
  }

  async createIfAbsent(summary: StudySummary): Promise<CreateIfAbsentResult> {
    const existing = this.summaries.get(summary.studySessionId);
    if (existing) {
      return { summary: structuredClone(existing), created: false };
    }
    this.summaries.set(summary.studySessionId, structuredClone(summary));
    return { summary, created: true };
  }

  async updateIfRevision(
    summary: StudySummary,
    expectedRevision: number,
  ): Promise<StudySummary | null> {
    const current = this.summaries.get(summary.studySessionId);
    if (!current || current.revision !== expectedRevision) {
      return null;
    }
    this.summaries.set(summary.studySessionId, structuredClone(summary));
    return summary;
  }
}
