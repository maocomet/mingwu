import type { StudySessionDetail } from '@mingwu/contracts';
import type { StudySessionService } from '../study-session/study-session-service.js';
import type { StudySummaryRepository } from '../../domain/study-summary/repository.js';
import type { StudyReportService } from '../study-report/study-report-service.js';

/**
 * StudySessionDetail 只读聚合服务：把当前已实现的 Session / Summary /
 * Participant / Report 四部分数据聚合成一份响应，供 MCP 只读工具 study_get_session
 * 使用。只读边界：
 * - 只调用现有应用服务的只读方法与领域仓储的只读查询，不复制业务算法、
 *   不回调自身 HTTP 接口、不产生任何写入；
 * - Session 是否存在以 StudySessionService.getById 为准：未知 Session 抛
 *   StudySessionNotFoundError（由 MCP 层转成受控 isError），绝不聚合“幽灵”数据；
 * - Summary 可为 null（尚无总结是正常状态）；participants / reports 可为空数组；
 * - 参与人 / 报告的稳定排序语义复用 StudyReportService 既有的
 *   listParticipants（joinedAt ASC, actorId ASC）与
 *   listReports（submittedAt ASC, actorId ASC, sequenceNumber ASC）。
 */
export class StudySessionDetailService {
  constructor(
    private readonly sessionService: StudySessionService,
    private readonly summaryRepository: StudySummaryRepository,
    private readonly reportService: StudyReportService,
  ) {}

  async getDetail(studySessionId: string): Promise<StudySessionDetail> {
    const session = await this.sessionService.getById(studySessionId);
    const summary = await this.summaryRepository.findByStudySessionId(studySessionId);
    const [participants, reports] = await Promise.all([
      this.reportService.listParticipants(studySessionId),
      this.reportService.listReports(studySessionId),
    ]);
    return { session, summary, participants, reports };
  }
}
