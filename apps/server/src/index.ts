import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { ProjectService } from './application/project/project-service.js';
import { StageService } from './application/stage/stage-service.js';
import { ProjectTaskService } from './application/project-task/project-task-service.js';
import { ProjectStatusService } from './application/project-status/project-status-service.js';
import { StudySessionService } from './application/study-session/study-session-service.js';
import { StudySessionCurrentService } from './application/study-session-current/study-session-current-service.js';
import { StudySessionDetailService } from './application/study-session-detail/study-session-detail-service.js';
import { StudySummaryService } from './application/study-summary/study-summary-service.js';
import { StudyReportService } from './application/study-report/study-report-service.js';
import { InMemoryProjectRepository } from './infrastructure/repositories/in-memory-project-repository.js';
import { InMemoryStageRepository } from './infrastructure/repositories/in-memory-stage-repository.js';
import { InMemoryProjectTaskRepository } from './infrastructure/repositories/in-memory-project-task-repository.js';
import { InMemoryStudySessionRepository } from './infrastructure/repositories/in-memory-study-session-repository.js';
import { InMemoryStudySummaryRepository } from './infrastructure/repositories/in-memory-study-summary-repository.js';
import { InMemoryStudyReportRepository } from './infrastructure/repositories/in-memory-study-report-repository.js';
import { InMemoryStudyParticipantRepository } from './infrastructure/repositories/in-memory-study-participant-repository.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const projectRepository = new InMemoryProjectRepository();
  const stageRepository = new InMemoryStageRepository();
  const taskRepository = new InMemoryProjectTaskRepository();
  const studySessionRepository = new InMemoryStudySessionRepository();
  const studySummaryRepository = new InMemoryStudySummaryRepository();
  const studyReportRepository = new InMemoryStudyReportRepository();
  const studyParticipantRepository = new InMemoryStudyParticipantRepository();
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
  const app = buildApp({
    config,
    projectService,
    stageService,
    taskService,
    projectStatusService,
    studySessionService,
    studySessionDetailService,
    studySessionCurrentService,
    studySummaryService,
    studyReportService,
  });

  const shutdown = async (signal: string): Promise<void> => {
    app.log.info({ signal }, 'shutting down');
    await app.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  await app.listen({ host: config.host, port: config.port });
  app.log.info(`mingwu server listening on http://${config.host}:${config.port}`);
}

main().catch((err) => {
  console.error('failed to start server', err);
  process.exit(1);
});
