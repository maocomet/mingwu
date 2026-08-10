/**
 * StudyParticipant 领域错误。
 */

/**
 * 参与记录 upsert 失败：报告已成功保存但 Participant 未能写入 / 刷新。
 * 本批内存阶段策略：接口必须如实返回失败（500），不得假装全部成功；
 * 已写入的报告不会回滚，PostgreSQL 阶段必须把“分配序号 + 插入报告 + upsert
 * Participant”放进同一事务，失败整体回滚。
 */
export class StudyParticipantUpdateError extends Error {
  constructor(readonly studySessionId: string, readonly actorId: string) {
    super(`Failed to record participant ${actorId} for session ${studySessionId}`);
    this.name = 'StudyParticipantUpdateError';
  }
}
