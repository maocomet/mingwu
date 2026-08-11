/**
 * ProjectWorkReport 数据契约：AI 在某项目 / 某关卡的工作过程报告（只读基础）。
 *
 * 本批只实现 Stage API 的只读列表能力（`GET /stages/:stageId/reports`），不实现
 * 报告提交入口。模型与自习室 StudyReport 相互独立：StudyReport 记录一次学习会话
 * （studySessionId / sequenceNumber / content），ProjectWorkReport 记录一个项目 /
 * 关卡的工作周期（本轮目标、完成内容、修改摘要、修改文件、测试结果、当前进度、
 * 遗留问题、下一步计划、相关素材 ID）。
 *
 * 字段信任边界（本批只读，未来写入口接入时必须遵守）：
 * - projectId / stageId：由服务端读取真实 Stage 后确定，不信任客户端提交；
 * - submittedActorId：只来自服务端认证上下文，绝不出现在公开输入契约；
 * - submittedAt：由服务端写入，客户端不得提交或伪造；
 * - stageId 为可空关联：null 表示项目级报告；本批 Stage 列表入口只返回直接关联
 *   指定关卡的报告（stageId 非空且等于请求 stageId），项目级报告不混入。
 * - relatedTaskId / relatedAiTaskId / relatedReviewId：为未来关联 ProjectTask、
 *   AI Task 与审核记录预留的可选 ID，本批不实现这些模块，保持 null。
 *
 * 本批无写入口，报告经测试装配 / seed 路径注入，生产 HTTP 不暴露任何写接口。
 */

import { UUID_PATTERN } from './project.js';

/** 单段正文（本轮目标 / 完成内容 / 修改摘要 / 测试结果 / 当前进度 / 遗留问题 / 下一步计划）长度上限（code point）。 */
export const PROJECT_WORK_REPORT_TEXT_MAX_LENGTH = 20000;
/** 修改文件列表单项长度上限。 */
export const PROJECT_WORK_REPORT_FILE_MAX_LENGTH = 500;
/** 修改文件列表项数上限。 */
export const PROJECT_WORK_REPORT_FILES_MAX_ITEMS = 200;
/** 相关素材 ID 单项长度上限（素材模块未落地，ID 暂按受控长度字符串表达）。 */
export const PROJECT_WORK_REPORT_ASSET_MAX_LENGTH = 200;
/** 相关素材 ID 项数上限。 */
export const PROJECT_WORK_REPORT_ASSETS_MAX_ITEMS = 100;

/**
 * 项目工作报告（只读基础）。
 * 内容字段全部为非空字符串（服务端生成后不可为 null），列表字段可为空数组。
 * 预留关联字段（relatedTaskId / relatedAiTaskId / relatedReviewId）本批恒为 null。
 */
export interface ProjectWorkReport {
  /** 报告全局唯一 ID（UUID）。 */
  id: string;
  /** 报告所属项目 ID（服务端从真实 Stage 读取确定）。 */
  projectId: string;
  /** 可选关卡关联：null 表示项目级报告；本批 Stage 列表入口只返回直接关联指定关卡的报告。 */
  stageId: string | null;
  /** 服务端认证上下文解析的提交 Actor ID；绝不出现在公开输入契约中。 */
  submittedActorId: string;
  /** 报告提交时间（服务端写入）。 */
  submittedAt: string;
  /** 本轮目标。 */
  roundGoal: string;
  /** 完成内容。 */
  completedContent: string;
  /** 修改摘要。 */
  changeSummary: string;
  /** 修改文件列表。 */
  changedFiles: string[];
  /** 测试结果。 */
  testResults: string;
  /** 当前进度。 */
  currentProgress: string;
  /** 遗留问题。 */
  remainingIssues: string;
  /** 下一步计划。 */
  nextSteps: string;
  /** 相关素材 ID 列表（素材模块未落地，暂为受控长度字符串数组）。 */
  relatedAssetIds: string[];
  /** 预留：未来关联 ProjectTask 的可选 ID（本批不实现，恒为 null）。 */
  relatedTaskId: string | null;
  /** 预留：未来关联 AI Task 的可选 ID（本批不实现，恒为 null）。 */
  relatedAiTaskId: string | null;
  /** 预留：未来关联审核记录的可选 ID（本批不实现，恒为 null）。 */
  relatedReviewId: string | null;
}

/** 报告完整响应契约（单个报告）。additionalProperties:false，字段不允许未声明内容。 */
export const projectWorkReportJsonSchema = {
  type: 'object',
  required: [
    'id',
    'projectId',
    'stageId',
    'submittedActorId',
    'submittedAt',
    'roundGoal',
    'completedContent',
    'changeSummary',
    'changedFiles',
    'testResults',
    'currentProgress',
    'remainingIssues',
    'nextSteps',
    'relatedAssetIds',
    'relatedTaskId',
    'relatedAiTaskId',
    'relatedReviewId',
  ],
  additionalProperties: false,
  properties: {
    id: { type: 'string', pattern: UUID_PATTERN },
    projectId: { type: 'string', pattern: UUID_PATTERN },
    stageId: { type: ['string', 'null'], pattern: UUID_PATTERN },
    submittedActorId: { type: 'string', pattern: UUID_PATTERN },
    submittedAt: { type: 'string' },
    roundGoal: { type: 'string', minLength: 1, maxLength: PROJECT_WORK_REPORT_TEXT_MAX_LENGTH },
    completedContent: {
      type: 'string',
      minLength: 1,
      maxLength: PROJECT_WORK_REPORT_TEXT_MAX_LENGTH,
    },
    changeSummary: {
      type: 'string',
      minLength: 1,
      maxLength: PROJECT_WORK_REPORT_TEXT_MAX_LENGTH,
    },
    changedFiles: {
      type: 'array',
      maxItems: PROJECT_WORK_REPORT_FILES_MAX_ITEMS,
      items: { type: 'string', minLength: 1, maxLength: PROJECT_WORK_REPORT_FILE_MAX_LENGTH },
    },
    testResults: { type: 'string', minLength: 1, maxLength: PROJECT_WORK_REPORT_TEXT_MAX_LENGTH },
    currentProgress: {
      type: 'string',
      minLength: 1,
      maxLength: PROJECT_WORK_REPORT_TEXT_MAX_LENGTH,
    },
    remainingIssues: {
      type: 'string',
      minLength: 1,
      maxLength: PROJECT_WORK_REPORT_TEXT_MAX_LENGTH,
    },
    nextSteps: { type: 'string', minLength: 1, maxLength: PROJECT_WORK_REPORT_TEXT_MAX_LENGTH },
    relatedAssetIds: {
      type: 'array',
      maxItems: PROJECT_WORK_REPORT_ASSETS_MAX_ITEMS,
      items: { type: 'string', minLength: 1, maxLength: PROJECT_WORK_REPORT_ASSET_MAX_LENGTH },
    },
    relatedTaskId: { type: ['string', 'null'], pattern: UUID_PATTERN },
    relatedAiTaskId: { type: ['string', 'null'], pattern: UUID_PATTERN },
    relatedReviewId: { type: ['string', 'null'], pattern: UUID_PATTERN },
  },
} as const;

/** `GET /stages/:stageId/reports` 的路径参数：只允许 stageId（UUID）。 */
export const stageWorkReportParamsSchema = {
  type: 'object',
  required: ['stageId'],
  additionalProperties: false,
  properties: { stageId: { type: 'string', pattern: UUID_PATTERN } },
} as const;

/** 关卡报告列表响应：包装为 `{ reports: [...] }`，数组项同样不允许未声明内容。 */
export const stageWorkReportListJsonSchema = {
  type: 'object',
  required: ['reports'],
  additionalProperties: false,
  properties: {
    reports: { type: 'array', items: projectWorkReportJsonSchema },
  },
} as const;
