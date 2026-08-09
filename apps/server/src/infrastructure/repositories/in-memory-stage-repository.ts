import type { ProjectStage } from '@mingwu/contracts';
import type {
  CreateStageIfAbsentResult,
  StageRepository,
} from '../../domain/stage/repository.js';
import { StagePositionConflictError } from '../../domain/stage/errors.js';

/**
 * 第三关接口开发用的内存仓储。并发原子性与 position 唯一性由 Map 的同步读写保证
 * （方法体内在插入前没有 await，检查与写入在同一同步块内完成）。
 * 第六关替换为 PostgreSQL 实现时依赖 id 唯一约束 + `UNIQUE (project_id, position)`。
 */
export class InMemoryStageRepository implements StageRepository {
  private readonly stages = new Map<string, ProjectStage>();

  async findById(id: string): Promise<ProjectStage | null> {
    const stage = this.stages.get(id);
    return stage ? structuredClone(stage) : null;
  }

  async listByProject(projectId: string): Promise<ProjectStage[]> {
    return [...this.stages.values()]
      .filter((s) => s.projectId === projectId)
      .sort((a, b) => a.position - b.position)
      .map((s) => structuredClone(s));
  }

  async createIfAbsent(stage: ProjectStage): Promise<CreateStageIfAbsentResult> {
    const existing = this.stages.get(stage.id);
    if (existing) {
      return { stage: structuredClone(existing), created: false };
    }
    const positionTaken = [...this.stages.values()].some(
      (s) => s.projectId === stage.projectId && s.position === stage.position,
    );
    if (positionTaken) {
      throw new StagePositionConflictError(stage.projectId, stage.position);
    }
    this.stages.set(stage.id, structuredClone(stage));
    return { stage, created: true };
  }
}
