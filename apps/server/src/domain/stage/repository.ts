import type { ProjectStage } from '@mingwu/contracts';

export interface CreateStageIfAbsentResult {
  stage: ProjectStage;
  created: boolean;
}

/**
 * 仓储接口。并发正确性与 position 唯一性由仓储保证，业务层不在“先查再写”的窗口里做判断。
 * PostgreSQL 实现将依赖 id 唯一约束 + `UNIQUE (project_id, position)` 处理竞争。
 */
export interface StageRepository {
  findById(id: string): Promise<ProjectStage | null>;
  /** 按 position 升序返回某项目的全部关卡。 */
  listByProject(projectId: string): Promise<ProjectStage[]>;
  /**
   * 原子插入：
   * - id 已存在 → 返回已有关卡（created=false），不覆盖；
   * - id 不存在但 (projectId, position) 已被占用 → 抛 StagePositionConflictError；
   * - 否则保存并返回 created=true。
   */
  createIfAbsent(stage: ProjectStage): Promise<CreateStageIfAbsentResult>;
  /**
   * 原子比较并交换更新（CAS）：
   * - 关卡不存在或 version !== expectedVersion → 返回 null，不写入；
   * - version 匹配但 (projectId, position) 被同项目其他关卡占用（排除自身）→
   *   抛 StagePositionConflictError；
   * - 否则保存 updated 并返回更新后的关卡。
   * version 与 position 的检查在仓储内部同一同步块内完成，不存在"先查后写"竞争窗口；
   * 第六关 PostgreSQL 对应 `UPDATE ... WHERE id = ? AND version = ?` 配合
   * `UNIQUE (project_id, position)` 处理竞争。
   */
  updateIfVersion(updated: ProjectStage, expectedVersion: number): Promise<ProjectStage | null>;
}
