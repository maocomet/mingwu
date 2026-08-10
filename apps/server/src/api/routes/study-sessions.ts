import type {
  CreateStudySessionInput,
  EndStudySessionInput,
  PauseStudySessionInput,
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
  studySessionJsonSchema,
  studySessionParamsSchema,
} from '@mingwu/contracts';
import type { FastifyPluginAsync } from 'fastify';
import type { StudySessionService } from '../../application/study-session/study-session-service.js';

export const studySessionRoutes: FastifyPluginAsync<{
  studySessionService: StudySessionService;
}> = async (app, opts) => {
  const { studySessionService } = opts;

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
};
