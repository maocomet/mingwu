import type { ProjectStage, ProjectWorkReport, StageUpdateRequest } from '@mingwu/contracts';

/**
 * 内存仓储共享的底层状态：所有聚合的内存实现读写同一份 Map，形成唯一状态源。
 * StageRepository 的普通写入、StageUpdateRequest 的决定（request-changes / reject /
 * approve）都共享同一互斥边界——JS 单线程下，方法体内“读取 + 校验 + 写入”不跨
 * await 的同步块构成原子临界区，不存在复制第二份 Map 或双写数据源。
 * projectWorkReports 目前只读（本批无写入口），预留同一 Map 供未来报告提交模块
 * 与 Stage 列表共享同一状态源。
 * 第六关替换为 PostgreSQL 时对应同一数据库实例（跨表原子性由同一事务保证）。
 */
export interface InMemoryStore {
  stages: Map<string, ProjectStage>;
  stageUpdateRequests: Map<string, StageUpdateRequest>;
  projectWorkReports: Map<string, ProjectWorkReport>;
}

export function createInMemoryStore(): InMemoryStore {
  return {
    stages: new Map(),
    stageUpdateRequests: new Map(),
    projectWorkReports: new Map(),
  };
}
