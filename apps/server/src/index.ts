import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { ProjectService } from './application/project/project-service.js';
import { StageService } from './application/stage/stage-service.js';
import { InMemoryProjectRepository } from './infrastructure/repositories/in-memory-project-repository.js';
import { InMemoryStageRepository } from './infrastructure/repositories/in-memory-stage-repository.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const projectRepository = new InMemoryProjectRepository();
  const projectService = new ProjectService(projectRepository);
  const stageService = new StageService(new InMemoryStageRepository(), projectRepository);
  const app = buildApp({ config, projectService, stageService });

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
