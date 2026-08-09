import type {
  CreateStageInput,
  ProjectStage,
} from '@mingwu/contracts';
import { ProjectNotFoundError } from '../../domain/project/errors.js';
import type { ProjectRepository } from '../../domain/project/repository.js';
import {
  StageIdempotencyConflictError,
  StageNotFoundError,
  StagePositionConflictError,
} from '../../domain/stage/errors.js';
import type { StageRepository } from '../../domain/stage/repository.js';

export interface CreateStageResult {
  stage: ProjectStage;
  created: boolean;
}

/**
 * 自动分配 position 的最大重试次数。
 * 每次重试都重新读取项目最新关卡并取 max+1，position 单调递增、必然收敛；
 * 只要并发创建数低于该上限，自动分配总能成功。第三关内存原型与单人
 * 真实使用场景的并发度远低于 50。
 */
const AUTO_POSITION_RETRY_LIMIT = 50;

/**
 * 幂等语义比较。position 只在客户端显式提供时才参与比较：
 * 自动分配 position 的幂等重试不应因重算出的位置不同而被误判为冲突。
 */
function sameCreateSemantics(input: CreateStageInput, existing: ProjectStage): boolean {
  return (
    input.name === existing.name &&
    (input.description ?? null) === existing.description &&
    (input.completionCriteria ?? null) === existing.completionCriteria &&
    (input.position === undefined || input.position === existing.position)
  );
}

export class StageService {
  constructor(
    private readonly repository: StageRepository,
    private readonly projectRepository: ProjectRepository,
  ) {}

  /**
   * 幂等创建关卡。
   * - 显式 position：position 冲突直接抛 StagePositionConflictError（409）。
   * - 自动 position：position 是服务端内部分配，与并发请求撞车时重新读取并重算、
   *   有界重试；有效请求不应因内部竞争收到"你指定的位置冲突"。
   * 相同 id + 相同语义的重复请求返回已有关卡（created=false），相同 id + 不同内容返回明确冲突。
   */
  async createStage(projectId: string, input: CreateStageInput): Promise<CreateStageResult> {
    const project = await this.projectRepository.findById(projectId);
    if (!project) {
      throw new ProjectNotFoundError(projectId);
    }

    if (input.position !== undefined) {
      return this.insertStage(projectId, input, this.buildStage(projectId, input, input.position));
    }

    for (let attempt = 0; attempt < AUTO_POSITION_RETRY_LIMIT; attempt++) {
      const stages = await this.repository.listByProject(projectId);
      const position = stages.length === 0 ? 1 : Math.max(...stages.map((s) => s.position)) + 1;
      try {
        return await this.insertStage(projectId, input, this.buildStage(projectId, input, position));
      } catch (err) {
        if (!(err instanceof StagePositionConflictError)) {
          throw err;
        }
        // 自动分配撞车：下一轮重新读取最新列表并取 max+1。
      }
    }

    // 重试耗尽：并发度超过上限，如实返回与显式 position 冲突同语义的错误。
    const stages = await this.repository.listByProject(projectId);
    const next = stages.length === 0 ? 1 : Math.max(...stages.map((s) => s.position)) + 1;
    throw new StagePositionConflictError(projectId, next);
  }

  async getStage(id: string): Promise<ProjectStage> {
    const stage = await this.repository.findById(id);
    if (!stage) {
      throw new StageNotFoundError(id);
    }
    return stage;
  }

  private buildStage(projectId: string, input: CreateStageInput, position: number): ProjectStage {
    const now = new Date().toISOString();
    return {
      id: input.id,
      projectId,
      name: input.name,
      description: input.description ?? null,
      position,
      completionCriteria: input.completionCriteria ?? null,
      status: 'not_started',
      startedAt: null,
      completedAt: null,
      version: 1,
      createdAt: now,
      updatedAt: now,
    };
  }

  private async insertStage(
    projectId: string,
    input: CreateStageInput,
    stage: ProjectStage,
  ): Promise<CreateStageResult> {
    const { stage: existing, created } = await this.repository.createIfAbsent(stage);
    if (created) {
      return { stage, created: true };
    }
    if (existing.projectId !== projectId || !sameCreateSemantics(input, existing)) {
      throw new StageIdempotencyConflictError(input.id);
    }
    return { stage: existing, created: false };
  }
}
