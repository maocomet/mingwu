import type {
  CreateStudySessionInput,
  EndStudySessionInput,
  PauseStudySessionInput,
  PutStudySummaryInput,
  ResumeStudySessionInput,
  SetCountdownInput,
  SetTaskInput,
  StartStudySessionInput,
} from '@mingwu/contracts';
import {
  createStudySessionBodySchema,
  endStudySessionBodySchema,
  pauseStudySessionBodySchema,
  resumeStudySessionBodySchema,
  setCountdownBodySchema,
  setTaskBodySchema,
  startStudySessionBodySchema,
  studySessionDetailJsonSchema,
  studySessionDetailQuerySchema,
  studySessionHistoryPageJsonSchema,
  studySessionHistoryQuerySchema,
  studySessionJsonSchema,
  studySessionParamsSchema,
  studySummaryBodySchema,
  studySummaryJsonSchema,
} from '@mingwu/contracts';
import type { FastifyPluginAsync } from 'fastify';
import { StudySessionHistoryLimitInvalidError } from '../../domain/study-session/errors.js';
import type { StudySessionService } from '../../application/study-session/study-session-service.js';
import type { StudySessionDetailService } from '../../application/study-session-detail/study-session-detail-service.js';
import type { StudySummaryService } from '../../application/study-summary/study-summary-service.js';

const HISTORY_PAGE_DEFAULT_LIMIT = 20;
const HISTORY_PAGE_MAX_LIMIT = 100;

/**
 * 解析并校验历史列表 limit：HTTP query 是字符串且全局关闭类型强制转换，
 * 缺省 20；显式传入时必须是 1..100 的整数（数字字符串），否则抛受控
 * StudySessionHistoryLimitInvalidError（app.ts 映射为 400），不回显非法值。
 */
function parseHistoryLimit(raw: string | undefined): number {
  if (raw === undefined) {
    return HISTORY_PAGE_DEFAULT_LIMIT;
  }
  const limit = Number(raw);
  if (!Number.isInteger(limit) || limit < 1 || limit > HISTORY_PAGE_MAX_LIMIT) {
    throw new StudySessionHistoryLimitInvalidError();
  }
  return limit;
}

export const studySessionRoutes: FastifyPluginAsync<{
  studySessionService: StudySessionService;
  studySessionDetailService: StudySessionDetailService;
  studySummaryService: StudySummaryService;
}> = async (app, opts) => {
  const { studySessionService, studySessionDetailService, studySummaryService } = opts;

  // 幂等创建：id 由客户端生成并充当幂等键。重试相同 id + 相同内容返回已有 Session（200），
  // 相同 id + 不同内容返回稳定 409，不会因重试产生重复 Session。
  app.post(
    '/study-sessions',
    {
      schema: {
        body: createStudySessionBodySchema,
        response: { 201: studySessionJsonSchema, 200: studySessionJsonSchema },
      },
    },
    async (request, reply) => {
      const input = request.body as CreateStudySessionInput;
      const { studySession, created } = await studySessionService.createStudySession(input);
      return reply.status(created ? 201 : 200).send(studySession);
    },
  );

  // 设置学习任务（草稿配置）：只允许 status=created 的 Session。
  app.patch(
    '/study-sessions/:id/task',
    {
      schema: {
        params: studySessionParamsSchema,
        body: setTaskBodySchema,
        response: { 200: studySessionJsonSchema },
      },
    },
    async (request) => {
      const { id } = request.params as { id: string };
      const input = request.body as SetTaskInput;
      return studySessionService.setTask(id, input);
    },
  );

  // 设置倒计时时长（草稿配置）：只允许 count_down 模式且 status=created 的 Session。
  app.patch(
    '/study-sessions/:id/countdown',
    {
      schema: {
        params: studySessionParamsSchema,
        body: setCountdownBodySchema,
        response: { 200: studySessionJsonSchema },
      },
    },
    async (request) => {
      const { id } = request.params as { id: string };
      const input = request.body as SetCountdownInput;
      return studySessionService.setCountdown(id, input);
    },
  );

  // 历史列表：只返回终态 Session（completed，预留 cancelled / interrupted）的稳定分页，
  // endedAt DESC, id DESC。只读接口，不接受任何身份字段，不新增 actorId 入口。
  // query 中 limit / cursor 均为字符串：limit 缺省 20、范围 1..100，cursor 为不透明
  // URL-safe 游标；非法 limit / cursor 返回受控 400，不回显原始游标。静态路径注册在
  // `/:id` 之前（find-my-way 静态路由本就有更高优先级，此处显式保持顺序）。
  app.get(
    '/study-sessions/history',
    {
      schema: {
        querystring: studySessionHistoryQuerySchema,
        response: { 200: studySessionHistoryPageJsonSchema },
      },
    },
    async (request) => {
      const query = request.query as { limit?: string; cursor?: string };
      return studySessionService.listHistory({
        limit: parseHistoryLimit(query.limit),
        cursor: query.cursor ?? null,
      });
    },
  );

  // 读取 Session 当前核心状态（只读）。用于启动后刷新与客户端计算显示时间；
  // 本批不返回用户总结 / AI 参与者 / AI 报告或音乐信息。
  app.get(
    '/study-sessions/:id',
    {
      schema: {
        params: studySessionParamsSchema,
        response: { 200: studySessionJsonSchema },
      },
    },
    async (request) => {
      const { id } = request.params as { id: string };
      return studySessionService.getById(id);
    },
  );

  // 单次 Study Session 完整详情（只读）：为 Windows 客户端提供已实现的四部分聚合
  // （session / summary 可为 null / participants / reports）。直接复用既有
  // StudySessionDetailService.getDetail 与 studySessionDetailJsonSchema，不在路由中
  // 重新拼装或排序；真实排序语义由 service 层（joinedAt ASC, actorId ASC 等）保证。
  // params 严格 UUID；querystring 严格空对象，不接受 body / 身份字段 / 额外 query，
  // 非法 UUID / 未知 query 返回受控 400；Session 不存在复用既有 study_session_not_found。
  // 请求体边界：本接口是纯只读 GET，不接受任何请求体。Fastify 对 GET 不填充
  // request.body、也不允许 GET 定义 body schema（FST_ERR_ROUTE_BODY_VALIDATION_
  // SCHEMA_NOT_SUPPORTED），因此在路由自己的 onRequest 用 HTTP framing 在读取正文
  // 前 fail-fast：存在 Transfer-Encoding（含 chunked）→ 400；Content-Length 非法 /
  // 多值 / 非零 → 400；仅 Content-Length: 0 或无正文 framing → 放行正常无 body GET。
  // 只读 header、绝不读取 request.raw，避免无上限消费慢速或超大 body、绕过常规
  // bodyLimit；不记录或回显 header / body 值。拒绝发生在调用 service 之前。
  app.get(
    '/study-sessions/:id/detail',
    {
      schema: {
        params: studySessionParamsSchema,
        querystring: studySessionDetailQuerySchema,
        response: {
          200: studySessionDetailJsonSchema,
          // 请求体拒绝响应：与全局 errorHandler 的 validation_failed 形状一致。
          400: {
            type: 'object',
            required: ['error', 'message'],
            properties: { error: { type: 'string' }, message: { type: 'string' } },
          },
        },
      },
      onRequest: async (request, reply) => {
        const headers = request.headers;
        if (headers['transfer-encoding'] !== undefined) {
          return reply
            .status(400)
            .send({ error: 'validation_failed', message: 'request body is not allowed' });
        }
        const contentLength = headers['content-length'];
        if (contentLength !== undefined) {
          // 非零、非法、多值合并的 Content-Length 都 fail-closed 拒绝；仅 "0" 放行。
          const value = Array.isArray(contentLength) ? contentLength.join(',') : contentLength;
          if (!/^0+$/.test(value.trim())) {
            return reply
              .status(400)
              .send({ error: 'validation_failed', message: 'request body is not allowed' });
          }
        }
      },
    },
    async (request) => {
      const { id } = request.params as { id: string };
      return studySessionDetailService.getDetail(id);
    },
  );

  // 开始 Session：把已配置好的草稿启动为 running。请求体仅允许 expectedVersion，
  // 不接受 actorId / status / startedAt / 时长结果或其他受保护字段；startedAt 由服务端写入。
  app.post(
    '/study-sessions/:id/start',
    {
      schema: {
        params: studySessionParamsSchema,
        body: startStudySessionBodySchema,
        response: { 200: studySessionJsonSchema },
      },
    },
    async (request) => {
      const { id } = request.params as { id: string };
      const input = request.body as StartStudySessionInput;
      return studySessionService.startStudySession(id, input);
    },
  );

  // 暂停 Session：running → paused。pausedAt 由服务端单次采样写入，客户端不能提交时间。
  app.post(
    '/study-sessions/:id/pause',
    {
      schema: {
        params: studySessionParamsSchema,
        body: pauseStudySessionBodySchema,
        response: { 200: studySessionJsonSchema },
      },
    },
    async (request) => {
      const { id } = request.params as { id: string };
      const input = request.body as PauseStudySessionInput;
      return studySessionService.pauseStudySession(id, input);
    },
  );

  // 恢复 Session：paused → running。服务端单次采样时间并累计本次暂停整秒到
  // pausedDurationSeconds；pausedAt 清空、startedAt 保持不变。
  app.post(
    '/study-sessions/:id/resume',
    {
      schema: {
        params: studySessionParamsSchema,
        body: resumeStudySessionBodySchema,
        response: { 200: studySessionJsonSchema },
      },
    },
    async (request) => {
      const { id } = request.params as { id: string };
      const input = request.body as ResumeStudySessionInput;
      return studySessionService.resumeStudySession(id, input);
    },
  );

  // 结束 Session：running / paused → completed。服务端单次采样时间并结算最终时长；
  // endedAt / 状态 / 时长结果均由服务端写入，客户端不能提交。
  app.post(
    '/study-sessions/:id/end',
    {
      schema: {
        params: studySessionParamsSchema,
        body: endStudySessionBodySchema,
        response: { 200: studySessionJsonSchema },
      },
    },
    async (request) => {
      const { id } = request.params as { id: string };
      const input = request.body as EndStudySessionInput;
      return studySessionService.endStudySession(id, input);
    },
  );

  // 读取正式学习总结（只读）。Session 不存在返回 study_session_not_found（404），
  // Session 存在但没有总结返回 study_summary_not_found（404），两者错误码不同。
  // 本批不调用 AI、不建立 AI 参与者 / AI 学习报告模型。
  app.get(
    '/study-sessions/:id/summary',
    {
      schema: {
        params: studySessionParamsSchema,
        response: { 200: studySummaryJsonSchema },
      },
    },
    async (request) => {
      const { id } = request.params as { id: string };
      return studySummaryService.getBySessionId(id);
    },
  );

  // 提交 / 修改正式学习总结。一个 Session 最多一份，反复修改不新增第二份：
  // - expectedRevision=0 原子创建，201；网络 / 并发重试撞上已存在总结时，请求内容
  //   与已有内容一致按幂等返回已有总结（200），不一致返回稳定 409，不静默覆盖；
  // - expectedRevision>0 为乐观并发更新（CAS revision+1），200；陈旧 revision 409。
  // 请求体只允许 content / source / expectedRevision，拒绝受保护或身份字段；
  // 时间（confirmedByUserAt / createdAt / updatedAt）与服务端生成 id 由服务端写入。
  app.put(
    '/study-sessions/:id/summary',
    {
      schema: {
        params: studySessionParamsSchema,
        body: studySummaryBodySchema,
        response: { 201: studySummaryJsonSchema, 200: studySummaryJsonSchema },
      },
    },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const input = request.body as PutStudySummaryInput;
      const { summary, created } = await studySummaryService.putBySessionId(id, input);
      return reply.status(created ? 201 : 200).send(summary);
    },
  );
};
