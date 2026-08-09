import type { Project } from '@mingwu/contracts';
import type {
  CreateIfAbsentResult,
  ProjectRepository,
} from '../../domain/project/repository.js';

/**
 * 第三关接口开发用的内存仓储。并发原子性由 Map 的同步读写保证。
 * 第六关替换为 PostgreSQL 实现时：
 * - createIfAbsent 依赖 id 唯一约束 / `INSERT ... ON CONFLICT DO NOTHING`；
 * - updateIfVersion 依赖 `UPDATE ... WHERE version = expectedVersion` 的行数判断。
 */
export class InMemoryProjectRepository implements ProjectRepository {
  private readonly projects = new Map<string, Project>();

  async findById(id: string): Promise<Project | null> {
    const project = this.projects.get(id);
    return project ? structuredClone(project) : null;
  }

  async createIfAbsent(project: Project): Promise<CreateIfAbsentResult> {
    const existing = this.projects.get(project.id);
    if (existing) {
      return { project: structuredClone(existing), created: false };
    }
    this.projects.set(project.id, structuredClone(project));
    return { project, created: true };
  }

  async updateIfVersion(project: Project, expectedVersion: number): Promise<Project | null> {
    const current = this.projects.get(project.id);
    if (!current || current.version !== expectedVersion) {
      return null;
    }
    this.projects.set(project.id, structuredClone(project));
    return project;
  }
}
