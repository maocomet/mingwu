import type { FastifyPluginAsync } from 'fastify';
import type { AppConfig } from '../../config.js';

/** 允许出现在 readyz 响应中的受控错误码。内部异常文字不得进入响应或未脱敏日志。 */
export type ReadinessErrorCode = 'not_configured' | 'timeout' | 'check_failed';

export interface ReadinessCheck {
  name: 'database' | 'migrations' | 'asset_storage' | 'mcp';
  check: () => Promise<{ ok: boolean; message?: string }>;
}

class ReadinessTimeoutError extends Error {
  constructor() {
    super('readiness check timeout');
    this.name = 'ReadinessTimeoutError';
  }
}

const readinessResponseSchema = {
  type: 'object',
  required: ['status', 'checks'],
  additionalProperties: false,
  properties: {
    status: { type: 'string' },
    checks: {
      type: 'object',
      additionalProperties: {
        type: 'object',
        required: ['ok'],
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean' },
          error: { type: ['string', 'null'] },
        },
      },
    },
  },
} as const;

export const healthRoutes: FastifyPluginAsync<{
  config: AppConfig;
  readinessChecks: ReadinessCheck[];
  readyzTimeoutMs: number;
}> = async (app, opts) => {
  const { config, readinessChecks, readyzTimeoutMs } = opts;

  app.route({
    method: ['GET', 'HEAD'],
    url: '/healthz',
    schema: {
      response: {
        200: {
          type: 'object',
          required: ['status', 'service', 'version', 'time'],
          additionalProperties: false,
          properties: {
            status: { type: 'string' },
            service: { type: 'string' },
            version: { type: 'string' },
            time: { type: 'string' },
          },
        },
      },
    },
    handler: async (request, reply) => {
      if (request.method === 'HEAD') {
        // HEAD 探测不携带响应体，只返回状态码。
        return reply.code(200).send();
      }
      return {
        status: 'ok',
        service: config.serviceName,
        version: config.serviceVersion,
        time: new Date().toISOString(),
      };
    },
  });

  app.route({
    method: ['GET', 'HEAD'],
    url: '/readyz',
    schema: {
      response: {
        200: readinessResponseSchema,
        503: readinessResponseSchema,
      },
    },
    handler: async (request, reply) => {
      const results: Record<string, { ok: boolean; error?: ReadinessErrorCode }> = {};
      const deadline = Date.now() + readyzTimeoutMs;
      let allReady = true;
      for (const check of readinessChecks) {
        let ok = false;
        let errorCode: ReadinessErrorCode | undefined;
        try {
          const timeoutLeft = deadline - Date.now();
          if (timeoutLeft <= 0) {
            throw new ReadinessTimeoutError();
          }
          const result = await Promise.race([
            check.check(),
            new Promise<never>((_, reject) =>
              setTimeout(() => reject(new ReadinessTimeoutError()), timeoutLeft),
            ),
          ]);
          ok = result.ok;
          if (!ok) {
            // 检查项报告失败：只允许受控错误码进入响应，其余文字一律归一化为 check_failed。
            errorCode = result.message === 'not_configured' ? 'not_configured' : 'check_failed';
          }
        } catch (err) {
          ok = false;
          errorCode = err instanceof ReadinessTimeoutError ? 'timeout' : 'check_failed';
          // 脱敏日志：只记录检查名与受控错误码，不记录原始异常文字。
          app.log.warn({ readinessCheck: check.name, errorCode }, 'readiness check failed');
        }
        if (!ok) {
          allReady = false;
        }
        results[check.name] = { ok, ...(errorCode ? { error: errorCode } : {}) };
      }
      const statusCode = allReady ? 200 : 503;
      if (request.method === 'HEAD') {
        // HEAD 探测返回状态码，不携带响应体。
        return reply.code(statusCode).send();
      }
      return reply
        .code(statusCode)
        .send({ status: allReady ? 'ready' : 'not_ready', checks: results });
    },
  });
};
