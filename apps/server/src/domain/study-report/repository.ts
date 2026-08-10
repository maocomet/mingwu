import type { StudyReport } from '@mingwu/contracts';

export interface AppendReportResult {
  report: StudyReport;
  /** 本次是否真正插入；false 表示幂等命中已有报告。 */
  created: boolean;
}

/**
 * 仓储接口。报告只可追加，接口不提供修改、覆盖或删除正式报告的方法。
 * 并发正确性由仓储保证，业务层不在“先查再写”的窗口里做判断：
 * - `(studySessionId, actorId, sequenceNumber)` 原子唯一；
 * - `id` 全局唯一并作为幂等键：同 id、同 Session、同 Actor、同规范化正文重试
 *   返回已有报告（不新增、不推进序号）；同 id 搭配不同语义抛受控冲突。
 *
 * PostgreSQL 阶段（第六关）：
 * - 序号分配必须与报告插入同一事务 / 同一原子语句，例如先 `SELECT MAX(...)` 或
 *   用序列，再 `INSERT ... ON CONFLICT (study_session_id, actor_id, sequence_number)
 *   DO NOTHING`，冲突时重试；
 * - 幂等判断依赖 `study_reports.id` 唯一约束。
 */
export interface StudyReportRepository {
  /**
   * 原子追加：为 (studySessionId, actorId) 分配下一个 sequenceNumber 并插入，
   * 或以 id 命中已有报告做幂等 / 冲突判断。入参不含 sequenceNumber（由仓储分配）。
   * 返回报告使用深拷贝。
   */
  appendReport(report: Omit<StudyReport, 'sequenceNumber'>): Promise<AppendReportResult>;
  /**
   * 按 Session 列出全部报告，返回深拷贝。顺序不保证；
   * 稳定排序（submittedAt ASC, actorId ASC, sequenceNumber ASC）由应用服务负责。
   */
  listBySession(studySessionId: string): Promise<StudyReport[]>;
}
