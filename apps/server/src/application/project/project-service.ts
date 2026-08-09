import type { CreateProjectInput, Project, UpdateProjectInput } from '@mingwu/contracts';
import {
  ProjectConflictError,
  ProjectIdempotencyConflictError,
  ProjectNotFoundError,
} from '../../domain/project/errors.js';
import type { ProjectRepository } from '../../domain/project/repository.js';

export interface CreateProjectResult {
  project: Project;
  created: boolean;
}

/** 参与幂等语义比较的业务字段。 */
function sameCreateSemantics(input: CreateProjectInput, existing: Project): boolean {
  return (
    input.name === existing.name &&
    (input.description ?? null) === existing.description &&
    (input.goal ?? null) === existing.goal &&
    (input.scope ?? null) === existing.scope &&
    (input.currentVersion ?? null) === existing.currentVersion &&
    (input.currentVersionGoal ?? null) === existing.currentVersionGoal &&
    (input.coreFeatures ?? null) === existing.coreFeatures &&
    (input.outOfScope ?? null) === existing.outOfScope &&
    (input.importantPrinciples ?? null) === existing.importantPrinciples &&
    existing.status === 'active'
  );
}

export class ProjectService {
  constructor(private readonly repository: ProjectRepository) {}

  /**
   * 幂等创建：客户端在发送前生成 UUID。并发与重试正确性由仓储级 createIfAbsent 保证——
   * 只有一次写入成功；相同 id + 相同语义的重复请求返回已有项目（created=false），
   * 相同 id + 不同内容则返回明确冲突（409），不会假装重试成功。
   */
  async createProject(input: CreateProjectInput): Promise<CreateProjectResult> {
    const now = new Date().toISOString();
    const project: Project = {
      id: input.id,
      name: input.name,
      description: input.description ?? null,
      goal: input.goal ?? null,
      scope: input.scope ?? null,
      currentVersion: input.currentVersion ?? null,
      currentVersionGoal: input.currentVersionGoal ?? null,
      coreFeatures: input.coreFeatures ?? null,
      outOfScope: input.outOfScope ?? null,
      importantPrinciples: input.importantPrinciples ?? null,
      status: 'active',
      version: 1,
      createdAt: now,
      updatedAt: now,
      archivedAt: null,
    };
    const { project: existing, created } = await this.repository.createIfAbsent(project);
    if (created) {
      return { project, created: true };
    }
    if (!sameCreateSemantics(input, existing)) {
      throw new ProjectIdempotencyConflictError(input.id);
    }
    return { project: existing, created: false };
  }

  async getProject(id: string): Promise<Project> {
    const project = await this.repository.findById(id);
    if (!project) {
      throw new ProjectNotFoundError(id);
    }
    return project;
  }

  /**
   * 乐观并发修改：仓储级 updateIfVersion 做比较并交换，同一 expectedVersion 同时
   * 只能有一个请求成功。版本冲突时重新读取最新版本以准确返回 409。
   */
  async updateProject(id: string, input: UpdateProjectInput): Promise<Project> {
    const current = await this.repository.findById(id);
    if (!current) {
      throw new ProjectNotFoundError(id);
    }
    const now = new Date().toISOString();
    const isBecomingArchived = input.status === 'archived' && current.status !== 'archived';
    const isLeavingArchived =
      current.status === 'archived' && input.status !== undefined && input.status !== 'archived';
    const updated: Project = {
      ...current,
      name: input.name ?? current.name,
      description: input.description !== undefined ? input.description : current.description,
      goal: input.goal !== undefined ? input.goal : current.goal,
      scope: input.scope !== undefined ? input.scope : current.scope,
      currentVersion:
        input.currentVersion !== undefined ? input.currentVersion : current.currentVersion,
      currentVersionGoal:
        input.currentVersionGoal !== undefined ? input.currentVersionGoal : current.currentVersionGoal,
      coreFeatures: input.coreFeatures !== undefined ? input.coreFeatures : current.coreFeatures,
      outOfScope: input.outOfScope !== undefined ? input.outOfScope : current.outOfScope,
      importantPrinciples:
        input.importantPrinciples !== undefined
          ? input.importantPrinciples
          : current.importantPrinciples,
      status: input.status ?? current.status,
      version: current.version + 1,
      updatedAt: now,
      archivedAt: isBecomingArchived ? now : isLeavingArchived ? null : current.archivedAt,
    };
    const saved = await this.repository.updateIfVersion(updated, input.expectedVersion);
    if (!saved) {
      const latest = await this.repository.findById(id);
      throw new ProjectConflictError(
        id,
        input.expectedVersion,
        latest ? latest.version : current.version,
      );
    }
    return saved;
  }
}
