import type { StudySession } from '@mingwu/contracts';

export interface CreateIfAbsentResult {
  studySession: StudySession;
  created: boolean;
}

/**
 * 仓储接口。并发正确性由仓储保证，业务层不在“先查再写”的窗口里做判断。
 * PostgreSQL 实现将分别依赖唯一约束与 `UPDATE ... WHERE version = ?` 竞争处理。
 */
export interface StudySessionRepository {
  findById(id: string): Promise<StudySession | null>;
  /** 原子插入：id 不存在则保存，存在则返回已有 Session，不做覆盖。 */
  createIfAbsent(session: StudySession): Promise<CreateIfAbsentResult>;
  /**
   * 原子比较并交换：仅当当前版本等于 expectedVersion 时保存并返回新 Session，
   * 否则返回 null（不写入任何数据）。
   */
  updateIfVersion(session: StudySession, expectedVersion: number): Promise<StudySession | null>;
  /**
   * 列出全部终态 Session（completed / cancelled / interrupted），返回深拷贝，
   * 顺序不保证。稳定排序与 keyset 分页由应用服务负责；PostgreSQL 阶段应改为
   * 数据库端 keyset pagination（`WHERE ... AND (endedAt < ? OR (endedAt = ? AND id < ?))
   * ORDER BY endedAt DESC, id DESC LIMIT n`），而不是全表载入后排序。
   */
  listTerminal(): Promise<StudySession[]>;
}
