import type { Project, ProjectStage } from '@mingwu/contracts';
import { ProjectService } from '../src/application/project/project-service.js';
import { StageService } from '../src/application/stage/stage-service.js';
import { InMemoryProjectRepository } from '../src/infrastructure/repositories/in-memory-project-repository.js';
import { InMemoryStageRepository } from '../src/infrastructure/repositories/in-memory-stage-repository.js';

/** 共享同一个 InMemoryProjectRepository，保证项目与关卡写入互相可见。 */
export function makeServices() {
  const projectRepository = new InMemoryProjectRepository();
  const projectService = new ProjectService(projectRepository);
  const stageService = new StageService(new InMemoryStageRepository(), projectRepository);
  return { projectRepository, projectService, stageService };
}

export function uuid(): string {
  return crypto.randomUUID();
}

export function makeProject(overrides: Partial<Project> = {}): Project {
  const now = new Date().toISOString();
  return {
    id: overrides.id ?? uuid(),
    name: overrides.name ?? 'Test Project',
    description: overrides.description ?? null,
    goal: overrides.goal ?? null,
    scope: overrides.scope ?? null,
    currentVersion: overrides.currentVersion ?? null,
    currentVersionGoal: overrides.currentVersionGoal ?? null,
    coreFeatures: overrides.coreFeatures ?? null,
    outOfScope: overrides.outOfScope ?? null,
    importantPrinciples: overrides.importantPrinciples ?? null,
    status: overrides.status ?? 'active',
    version: overrides.version ?? 1,
    createdAt: overrides.createdAt ?? now,
    updatedAt: overrides.updatedAt ?? now,
    archivedAt: overrides.archivedAt ?? null,
  };
}

export function makeStage(overrides: Partial<ProjectStage> = {}): ProjectStage {
  const now = new Date().toISOString();
  return {
    id: overrides.id ?? uuid(),
    projectId: overrides.projectId ?? uuid(),
    name: overrides.name ?? 'Test Stage',
    description: overrides.description ?? null,
    position: overrides.position ?? 1,
    completionCriteria: overrides.completionCriteria ?? null,
    status: overrides.status ?? 'not_started',
    startedAt: overrides.startedAt ?? null,
    completedAt: overrides.completedAt ?? null,
    version: overrides.version ?? 1,
    createdAt: overrides.createdAt ?? now,
    updatedAt: overrides.updatedAt ?? now,
  };
}
