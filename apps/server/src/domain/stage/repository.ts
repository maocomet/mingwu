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
}
