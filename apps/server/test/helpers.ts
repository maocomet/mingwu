import type {
  Project,
  ProjectStage,
  ProjectTask,
  StudySession,
  StudySummary,
} from '@mingwu/contracts';
import { ProjectService } from '../src/application/project/project-service.js';
import { StageService } from '../src/application/stage/stage-service.js';
import { ProjectTaskService } from '../src/application/project-task/project-task-service.js';
import { ProjectStatusService } from '../src/application/project-status/project-status-service.js';
import { StudySessionService } from '../src/application/study-session/study-session-service.js';
import { StudySummaryService } from '../src/application/study-summary/study-summary-service.js';
import { InMemoryProjectRepository } from '../src/infrastructure/repositories/in-memory-project-repository.js';
import { InMemoryStageRepository } from '../src/infrastructure/repositories/in-memory-stage-repository.js';
import { InMemoryProjectTaskRepository } from '../src/infrastructure/repositories/in-memory-project-task-repository.js';
import { InMemoryStudySessionRepository } from '../src/infrastructure/repositories/in-memory-study-session-repository.js';
import { InMemoryStudySummaryRepository } from '../src/infrastructure/repositories/in-memory-study-summary-repository.js';

/** 共享同一组仓储，保证项目 / 关卡 / 任务 / 学习会话写入互相可见。 */
export function makeServices() {
  const projectRepository = new InMemoryProjectRepository();
  const stageRepository = new InMemoryStageRepository();
  const taskRepository = new InMemoryProjectTaskRepository();
  const studySessionRepository = new InMemoryStudySessionRepository();
  const studySummaryRepository = new InMemoryStudySummaryRepository();
  const projectService = new ProjectService(projectRepository);
  const stageService = new StageService(stageRepository, projectRepository);
  const taskService = new ProjectTaskService(taskRepository, stageRepository, projectRepository);
  const projectStatusService = new ProjectStatusService(
    projectRepository,
    stageRepository,
    taskRepository,
  );
  const studySessionService = new StudySessionService(studySessionRepository);
  const studySummaryService = new StudySummaryService(
    studySummaryRepository,
    studySessionRepository,
  );
  return {
    projectRepository,
    stageRepository,
    taskRepository,
    studySessionRepository,
    studySummaryRepository,
    projectService,
    stageService,
    taskService,
    projectStatusService,
    studySessionService,
    studySummaryService,
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

export function makeStudySession(overrides: Partial<StudySession> = {}): StudySession {
  const now = new Date().toISOString();
  return {
    id: overrides.id ?? uuid(),
    taskText: overrides.taskText ?? null,
    timerMode: overrides.timerMode ?? 'count_down',
    plannedDurationSeconds: overrides.plannedDurationSeconds ?? null,
    startedAt: overrides.startedAt ?? null,
    pausedAt: overrides.pausedAt ?? null,
    endedAt: overrides.endedAt ?? null,
    actualDurationSeconds: overrides.actualDurationSeconds ?? 0,
    pausedDurationSeconds: overrides.pausedDurationSeconds ?? 0,
    status: overrides.status ?? 'created',
    version: overrides.version ?? 1,
    createdAt: overrides.createdAt ?? now,
    updatedAt: overrides.updatedAt ?? now,
  };
}

export function makeStudySummary(overrides: Partial<StudySummary> = {}): StudySummary {
  const now = new Date().toISOString();
  return {
    id: overrides.id ?? uuid(),
    studySessionId: overrides.studySessionId ?? uuid(),
    content: overrides.content ?? '完成今天的单词背诵',
    source: overrides.source ?? 'user',
    revision: overrides.revision ?? 1,
    confirmedByUserAt: overrides.confirmedByUserAt ?? now,
    createdAt: overrides.createdAt ?? now,
    updatedAt: overrides.updatedAt ?? now,
  };
}
