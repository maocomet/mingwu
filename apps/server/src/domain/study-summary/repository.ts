import type { StudySummary } from '@mingwu/contracts';

export interface CreateIfAbsentResult {
  summary: StudySummary;
  created: boolean;
}

/**
 * 仓储接口。并发正确性由仓储保证，业务层不在“先查再写”的窗口里做判断：
 * - 唯一性以 studySessionId 为准（一个 Session 最多一份正式总结）；
 * - createIfAbsent 原子插入，重试不会产生第二份 Summary；
 * - updateIfRevision 原子比较并交换，陈旧 revision 不写入。
 *
 * PostgreSQL 阶段（第六关）将分别依赖：
 * - `study_summaries.study_session_id` 唯一约束 / `INSERT ... ON CONFLICT DO NOTHING`
 *   保证创建路径原子唯一；
 * - `UPDATE ... WHERE study_session_id = ? AND revision = ?` 的行数判断
 *   保证更新路径 CAS。
 */
export interface StudySummaryRepository {
  /** 按 Session 读取正式总结；不存在返回 null。返回深拷贝，外部修改不得污染仓储。 */
  findByStudySessionId(studySessionId: string): Promise<StudySummary | null>;
  /**
   * 原子插入：studySessionId 不存在则保存，存在则返回已有 Summary（不覆盖）。
   * 返回值使用拷贝。
   */
  createIfAbsent(summary: StudySummary): Promise<CreateIfAbsentResult>;
  /**
   * 原子比较并交换：仅当当前 revision 等于 expectedRevision 时保存并返回新 Summary，
   * 否则返回 null（不写入任何数据）。返回新 Summary 使用拷贝。
   */
  updateIfRevision(summary: StudySummary, expectedRevision: number): Promise<StudySummary | null>;
}
