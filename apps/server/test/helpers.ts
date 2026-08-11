import type {
  AuthenticatedAiActorContext,
  Project,
  ProjectStage,
  ProjectTask,
  ProjectWorkReport,
  StageUpdateRequest,
  StudyParticipant,
  StudyReport,
  StudySession,
  StudySummary,
} from '@mingwu/contracts';
import { ProjectService } from '../src/application/project/project-service.js';
import { StageService } from '../src/application/stage/stage-service.js';
import { ProjectTaskService } from '../src/application/project-task/project-task-service.js';
import { ProjectStatusService } from '../src/application/project-status/project-status-service.js';
import { StudySessionService } from '../src/application/study-session/study-session-service.js';
import { StudySessionCurrentService } from '../src/application/study-session-current/study-session-current-service.js';
import { StudySessionDetailService } from '../src/application/study-session-detail/study-session-detail-service.js';
import { StudySummaryService } from '../src/application/study-summary/study-summary-service.js';
import { StudyReportService } from '../src/application/study-report/study-report-service.js';
import { StageUpdateRequestService } from '../src/application/stage-update-request/stage-update-request-service.js';
import { ProjectWorkReportService } from '../src/application/project-work-report/project-work-report-service.js';
import { InMemoryProjectRepository } from '../src/infrastructure/repositories/in-memory-project-repository.js';
import { InMemoryStageRepository } from '../src/infrastructure/repositories/in-memory-stage-repository.js';
import { InMemoryProjectTaskRepository } from '../src/infrastructure/repositories/in-memory-project-task-repository.js';
import { InMemoryStudySessionRepository } from '../src/infrastructure/repositories/in-memory-study-session-repository.js';
import { InMemoryStudySummaryRepository } from '../src/infrastructure/repositories/in-memory-study-summary-repository.js';
import { InMemoryStudyReportRepository } from '../src/infrastructure/repositories/in-memory-study-report-repository.js';
import { InMemoryStudyParticipantRepository } from '../src/infrastructure/repositories/in-memory-study-participant-repository.js';
import { InMemoryStageUpdateRequestRepository } from '../src/infrastructure/repositories/in-memory-stage-update-request-repository.js';
import { InMemoryStageUpdateRequestApprovalRepository } from '../src/infrastructure/repositories/in-memory-stage-update-request-approval-repository.js';
import { InMemoryProjectWorkReportRepository } from '../src/infrastructure/repositories/in-memory-project-work-report-repository.js';
import { createInMemoryStore } from '../src/infrastructure/stores/in-memory-store.js';

/** 共享同一组仓储，保证项目 / 关卡 / 任务 / 学习会话写入互相可见。 */
export function makeServices() {
  // Stage 普通写入与“批准更新申请”的原子路径共享同一底层状态，不产生双写数据源。
  const store = createInMemoryStore();
  const projectRepository = new InMemoryProjectRepository();
  const stageRepository = new InMemoryStageRepository(store);
  const taskRepository = new InMemoryProjectTaskRepository();
  const studySessionRepository = new InMemoryStudySessionRepository();
  const studySummaryRepository = new InMemoryStudySummaryRepository();
  const studyReportRepository = new InMemoryStudyReportRepository();
  const studyParticipantRepository = new InMemoryStudyParticipantRepository();
  const stageUpdateRequestRepository = new InMemoryStageUpdateRequestRepository(store);
  const stageUpdateRequestApprovalRepository = new InMemoryStageUpdateRequestApprovalRepository(
    store,
  );
  const projectWorkReportRepository = new InMemoryProjectWorkReportRepository(store);
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
  const studyReportService = new StudyReportService(
    studyReportRepository,
    studyParticipantRepository,
    studySessionRepository,
  );
  const studySessionDetailService = new StudySessionDetailService(
    studySessionService,
    studySummaryRepository,
    studyReportService,
  );
  const studySessionCurrentService = new StudySessionCurrentService(
    studySessionRepository,
    studySessionDetailService,
  );
  const stageUpdateRequestService = new StageUpdateRequestService(
    stageUpdateRequestRepository,
    stageUpdateRequestApprovalRepository,
    stageRepository,
  );
  const projectWorkReportService = new ProjectWorkReportService(
    projectWorkReportRepository,
    stageRepository,
  );
  return {
    store,
    projectRepository,
    stageRepository,
    taskRepository,
    studySessionRepository,
    studySummaryRepository,
    studyReportRepository,
    studyParticipantRepository,
    stageUpdateRequestRepository,
    stageUpdateRequestApprovalRepository,
    projectWorkReportRepository,
    projectService,
    stageService,
    taskService,
    projectStatusService,
    studySessionService,
    studySessionDetailService,
    studySessionCurrentService,
    studySummaryService,
    studyReportService,
    stageUpdateRequestService,
    projectWorkReportService,
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

export function makeStudyParticipant(
  overrides: Partial<StudyParticipant> = {},
): StudyParticipant {
  const now = new Date().toISOString();
  return {
    studySessionId: overrides.studySessionId ?? uuid(),
    actorId: overrides.actorId ?? uuid(),
    joinedAt: overrides.joinedAt ?? now,
    lastActiveAt: overrides.lastActiveAt ?? now,
  };
}

export function makeStudyReport(overrides: Partial<StudyReport> = {}): StudyReport {
  const now = new Date().toISOString();
  return {
    id: overrides.id ?? uuid(),
    studySessionId: overrides.studySessionId ?? uuid(),
    actorId: overrides.actorId ?? uuid(),
    sequenceNumber: overrides.sequenceNumber ?? 1,
    content: overrides.content ?? 'AI 学习报告',
    submittedAt: overrides.submittedAt ?? now,
  };
}

export function makeActorContext(
  overrides: Partial<AuthenticatedAiActorContext> = {},
): AuthenticatedAiActorContext {
  return {
    actorId: overrides.actorId ?? uuid(),
    actorCode: overrides.actorCode ?? 'ai-actor',
    actorType: overrides.actorType ?? 'resident_ai',
  };
}

export function makeStageUpdateRequest(
  overrides: Partial<StageUpdateRequest> = {},
): StageUpdateRequest {
  const now = new Date().toISOString();
  return {
    id: overrides.id ?? uuid(),
    projectId: overrides.projectId ?? uuid(),
    stageId: overrides.stageId ?? uuid(),
    requesterActorId: overrides.requesterActorId ?? uuid(),
    expectedStageVersion: overrides.expectedStageVersion ?? 1,
    proposedStatus: overrides.proposedStatus ?? 'in_progress',
    reason: overrides.reason ?? '进入下一阶段',
    status: overrides.status ?? 'pending',
    revision: overrides.revision ?? 1,
    updatedAt: overrides.updatedAt ?? now,
    decision: overrides.decision ?? null,
    createdAt: overrides.createdAt ?? now,
  };
}

export function makeProjectWorkReport(
  overrides: Partial<ProjectWorkReport> = {},
): ProjectWorkReport {
  const now = new Date().toISOString();
  return {
    id: overrides.id ?? uuid(),
    projectId: overrides.projectId ?? uuid(),
    stageId: overrides.stageId ?? uuid(),
    submittedActorId: overrides.submittedActorId ?? uuid(),
    submittedAt: overrides.submittedAt ?? now,
    roundGoal: overrides.roundGoal ?? '完成第一关',
    completedContent: overrides.completedContent ?? '完成设计稿与接口文档',
    changeSummary: overrides.changeSummary ?? '新增 Project Work Report 契约',
    changedFiles: overrides.changedFiles ?? ['packages/contracts/src/project-work-report.ts'],
    testResults: overrides.testResults ?? '专项测试全部通过',
    currentProgress: overrides.currentProgress ?? '80%',
    remainingIssues: overrides.remainingIssues ?? '等待用户验收',
    nextSteps: overrides.nextSteps ?? '进入下一关',
    relatedAssetIds: overrides.relatedAssetIds ?? [],
    relatedTaskId: overrides.relatedTaskId ?? null,
    relatedAiTaskId: overrides.relatedAiTaskId ?? null,
    relatedReviewId: overrides.relatedReviewId ?? null,
  };
}
