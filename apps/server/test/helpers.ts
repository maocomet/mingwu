import type { Project, ProjectStage, ProjectTask } from '@mingwu/contracts';
import { ProjectService } from '../src/application/project/project-service.js';
import { StageService } from '../src/application/stage/stage-service.js';
import { ProjectTaskService } from '../src/application/project-task/project-task-service.js';
import { ProjectStatusService } from '../src/application/project-status/project-status-service.js';
import { InMemoryProjectRepository } from '../src/infrastructure/repositories/in-memory-project-repository.js';
import { InMemoryStageRepository } from '../src/infrastructure/repositories/in-memory-stage-repository.js';
import { InMemoryProjectTaskRepository } from '../src/infrastructure/repositories/in-memory-project-task-repository.js';

/** 共享同一组仓储，保证项目 / 关卡 / 任务写入互相可见。 */
export function makeServices() {
  const projectRepository = new InMemoryProjectRepository();
  const stageRepository = new InMemoryStageRepository();
  const taskRepository = new InMemoryProjectTaskRepository();
  const projectService = new ProjectService(projectRepository);
  const stageService = new StageService(stageRepository, projectRepository);
  const taskService = new ProjectTaskService(taskRepository, stageRepository, projectRepository);
  const projectStatusService = new ProjectStatusService(
    projectRepository,
    stageRepository,
    taskRepository,
  );
  return {
    projectRepository,
    stageRepository,
    taskRepository,
    projectService,
    stageService,
    taskService,
    projectStatusService,
  };
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

export function makeTask(overrides: Partial<ProjectTask> = {}): ProjectTask {
  const now = new Date().toISOString();
  return {
    id: overrides.id ?? uuid(),
    projectId: overrides.projectId ?? uuid(),
    stageId: overrides.stageId ?? uuid(),
    parentTaskId: overrides.parentTaskId ?? null,
    title: overrides.title ?? 'Test Task',
    description: overrides.description ?? null,
    completionCriteria: overrides.completionCriteria ?? null,
    status: overrides.status ?? 'not_started',
    position: overrides.position ?? 1,
    assignedActorId: overrides.assignedActorId ?? null,
    version: overrides.version ?? 1,
    createdAt: overrides.createdAt ?? now,
    updatedAt: overrides.updatedAt ?? now,
    completedAt: overrides.completedAt ?? null,
    archivedAt: overrides.archivedAt ?? null,
  };
}
