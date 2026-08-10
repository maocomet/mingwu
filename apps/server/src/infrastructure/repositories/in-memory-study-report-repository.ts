import type { StudyReport } from '@mingwu/contracts';
import { StudyReportIdempotencyConflictError } from '../../domain/study-report/errors.js';
import type {
  AppendReportResult,
  StudyReportRepository,
} from '../../domain/study-report/repository.js';

/**
 * 本批接口开发用的内存仓储。JS 单线程模型下，同步 Map 读写构成单个原子临界区，
 * “分配下一个 sequenceNumber + 插入报告”不会被打断，20 个同 Actor 不同 id 并发
 * 追加按到达顺序执行，得到唯一、连续的 1..20。业务层不做“先查再写”。
 *
 * 第六关替换为 PostgreSQL 实现时：
 * - 序号分配与插入必须同一事务 / 同一原子语句：先按 (study_session_id, actor_id)
 *   取当前最大序号 + 1（或用序列），再 `INSERT ... ON CONFLICT
 *   (study_session_id, actor_id, sequence_number) DO NOTHING`，冲突时重试；
 * - 幂等判断依赖 `study_reports.id` 唯一约束；
 * - 所有返回都使用结构化拷贝，调用方修改不得污染仓储。
 */
export class InMemoryStudyReportRepository implements StudyReportRepository {
  /** 全局报告 id → 完整报告（含 sequenceNumber），用于幂等命中与按 Session 查询。 */
  private readonly byId = new Map<string, StudyReport>();
  /** studySessionId → actorId → 该 Actor 在当前 Session 的下一个待分配序号。 */
  private readonly nextSequences = new Map<string, Map<string, number>>();

  async appendReport(report: Omit<StudyReport, 'sequenceNumber'>): Promise<AppendReportResult> {
    const existing = this.byId.get(report.id);
    if (existing) {
      // 同 id、同 Session、同 Actor、同规范化正文 → 幂等重试，返回已有报告、不推进序号。
      if (
        existing.studySessionId === report.studySessionId &&
        existing.actorId === report.actorId &&
        existing.content === report.content
      ) {
        return { report: structuredClone(existing), created: false };
      }
      // 同 id 搭配不同语义 → 受控冲突，绝不覆盖。
      throw new StudyReportIdempotencyConflictError(report.id);
    }
    const next = (this.nextSequences.get(report.studySessionId)?.get(report.actorId) ?? 0) + 1;
    let perSession = this.nextSequences.get(report.studySessionId);
    if (!perSession) {
      perSession = new Map<string, number>();
      this.nextSequences.set(report.studySessionId, perSession);
    }
    perSession.set(report.actorId, next);
    const full: StudyReport = { ...report, sequenceNumber: next };
    this.byId.set(full.id, structuredClone(full));
    return { report: structuredClone(full), created: true };
  }

  async listBySession(studySessionId: string): Promise<StudyReport[]> {
    const reports: StudyReport[] = [];
    for (const report of this.byId.values()) {
      if (report.studySessionId === studySessionId) {
        reports.push(structuredClone(report));
      }
    }
    return reports;
  }
}
