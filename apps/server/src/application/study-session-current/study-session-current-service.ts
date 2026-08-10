import type { StudySession, StudySessionDetail } from '@mingwu/contracts';
import { StudySessionTimeCorruptionError } from '../../domain/study-session/errors.js';
import type { StudySessionRepository } from '../../domain/study-session/repository.js';
import type { StudySessionDetailService } from '../study-session-detail/study-session-detail-service.js';

/**
 * 当前进行中 Session（running / paused）的只读查询服务，供 MCP 只读工具
 * study_get_current_session 使用。语义与边界：
 * - 只有 running / paused 属于“当前进行中”；created 只是未开始草稿，终态
 *   Session 也不属于当前；
 * - 没有进行中的 Session 时返回 null，这是正常成功结果，不是 404；
 * - v0.1 未禁止同时存在多条 running / paused：出现多条时按
 *   startedAt DESC → updatedAt DESC → id DESC 选择最近开始 / 最近更新的那一条，
 *   规则写死在此处且不依赖 Map 插入顺序或随机 UUID；
 * - running / paused 候选必须拥有可解析的 startedAt：脏数据不得被静默跳过或选中，
 *   直接抛受控内部错误（MCP 层转成通用“内部错误”，日志只记错误分类，不回显内部值）；
 * - 选中后复用 StudySessionDetailService.getDetail 返回与 study_get_session 相同的
 *   四部分聚合，不复制 Summary / Participant / Report 逻辑。
 */
export class StudySessionCurrentService {
  constructor(
    private readonly repository: StudySessionRepository,
    private readonly detailService: StudySessionDetailService,
  ) {}

  async getCurrentDetail(): Promise<StudySessionDetail | null> {
    const active = await this.repository.listInProgress();
    if (active.length === 0) {
      return null;
    }
    // startedAt 与 updatedAt 都必须拥有可解析的合法时刻：二者都参与正式选择，
    // 脏数据不得被静默跳过、按字典序兜底或选中，直接抛受控内部错误。
    // 排序用 Date.parse 得到的 epoch 毫秒比较真实时刻：带时区 offset / 不同精度的
    // 合法时间字符串，字典序不等于真实时间序（如 10:00+02:00 实际早于 09:00Z）。
    const candidates: { id: string; startedAtMs: number; updatedAtMs: number }[] = [];
    for (const session of active) {
      if (session.startedAt === null || Number.isNaN(Date.parse(session.startedAt))) {
        throw new StudySessionTimeCorruptionError(session.id);
      }
      const updatedAtMs = Date.parse(session.updatedAt);
      if (Number.isNaN(updatedAtMs)) {
        throw new StudySessionTimeCorruptionError(session.id);
      }
      candidates.push({
        id: session.id,
        startedAtMs: Date.parse(session.startedAt),
        updatedAtMs,
      });
    }
    candidates.sort(compareCurrentByNewestFirst);
    const selected = candidates[0]!;
    return this.detailService.getDetail(selected.id);
  }
}

/**
 * 当前 Session 稳定选择排序：startedAt DESC → updatedAt DESC → id DESC。
 * 时间用 epoch 毫秒比较真实时刻；只有两个时间代表同一真实时刻时才进入下一级比较，
 * 最终以 id DESC 稳定兜底。
 */
function compareCurrentByNewestFirst(
  a: { id: string; startedAtMs: number; updatedAtMs: number },
  b: { id: string; startedAtMs: number; updatedAtMs: number },
): number {
  if (a.startedAtMs !== b.startedAtMs) {
    return a.startedAtMs < b.startedAtMs ? 1 : -1;
  }
  if (a.updatedAtMs !== b.updatedAtMs) {
    return a.updatedAtMs < b.updatedAtMs ? 1 : -1;
  }
  if (a.id !== b.id) {
    return a.id < b.id ? 1 : -1;
  }
  return 0;
}
