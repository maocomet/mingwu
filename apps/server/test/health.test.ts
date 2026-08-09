import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { makeServices } from './helpers.js';

function setup() {
  const config = loadConfig({ NODE_ENV: 'test' });
  const { projectService, stageService, taskService } = makeServices();
  const app = buildApp({ config, projectService, stageService, taskService });
  return { app, config };
}

describe('health endpoints', () => {
  it('GET /healthz returns ok with service metadata', async () => {
    const { app, config } = setup();
    const res = await app.inject({ method: 'GET', url: '/healthz' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.status).toBe('ok');
    expect(body.service).toBe(config.serviceName);
    expect(body.version).toBe(config.serviceVersion);
    expect(typeof body.time).toBe('string');
  });

  it('HEAD /healthz returns 200 without a body', async () => {
    const { app } = setup();
    const res = await app.inject({ method: 'HEAD', url: '/healthz' });
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe('');
  });

  it('GET /readyz reports not_ready with honest not_configured checks until Level 6', async () => {
    const { app } = setup();
    const res = await app.inject({ method: 'GET', url: '/readyz' });
    expect(res.statusCode).toBe(503);
    const body = res.json();
    expect(body.status).toBe('not_ready');
    for (const name of ['database', 'migrations', 'asset_storage', 'mcp']) {
      expect(body.checks[name].ok).toBe(false);
      expect(body.checks[name].error).toBe('not_configured');
    }
  });

  it('readyz reports ready when all checks pass', async () => {
    const config = loadConfig({ NODE_ENV: 'test' });
    const { projectService, stageService, taskService } = makeServices();
    const app = buildApp({
      config,
      projectService,
      stageService,
      taskService,
      readinessChecks: [
        { name: 'database', check: async () => ({ ok: true }) },
        { name: 'migrations', check: async () => ({ ok: true }) },
        { name: 'asset_storage', check: async () => ({ ok: true }) },
        { name: 'mcp', check: async () => ({ ok: true }) },
      ],
    });
    const res = await app.inject({ method: 'GET', url: '/readyz' });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('ready');
  });

  it('readyz keeps serving even when a check rejects', async () => {
    const config = loadConfig({ NODE_ENV: 'test' });
    const { projectService, stageService, taskService } = makeServices();
    const app = buildApp({
      config,
      projectService,
      stageService,
      taskService,
      readinessChecks: [
        { name: 'database', check: async () => ({ ok: true }) },
        {
          name: 'migrations',
          check: async () => {
            throw new Error('connection refused');
          },
        },
        { name: 'asset_storage', check: async () => ({ ok: true }) },
        { name: 'mcp', check: async () => ({ ok: true }) },
      ],
    });
    const res = await app.inject({ method: 'GET', url: '/readyz' });
    expect(res.statusCode).toBe(503);
    expect(res.json().checks.migrations.error).toBe('check_failed');
  });

  it('does not leak raw exception messages into the readyz response', async () => {
    const config = loadConfig({ NODE_ENV: 'test' });
    const { projectService, stageService, taskService } = makeServices();
    const app = buildApp({
      config,
      projectService,
      stageService,
      taskService,
      readinessChecks: [
        { name: 'database', check: async () => ({ ok: true }) },
        {
          name: 'migrations',
          check: async () => {
            throw new Error('postgres://user:SuperSecretPassword123@db.internal:5432/mingwu');
          },
        },
        { name: 'asset_storage', check: async () => ({ ok: true }) },
        { name: 'mcp', check: async () => ({ ok: true }) },
      ],
    });
    const res = await app.inject({ method: 'GET', url: '/readyz' });
    expect(res.statusCode).toBe(503);
    const body = JSON.stringify(res.json());
    expect(res.json().checks.migrations.error).toBe('check_failed');
    expect(body).not.toContain('SuperSecretPassword123');
    expect(body).not.toContain('postgres://');
  });

  it('normalizes arbitrary check failure messages to a controlled error code', async () => {
    const config = loadConfig({ NODE_ENV: 'test' });
    const { projectService, stageService, taskService } = makeServices();
    const app = buildApp({
      config,
      projectService,
      stageService,
      taskService,
      readinessChecks: [
        { name: 'database', check: async () => ({ ok: true }) },
        {
          name: 'migrations',
          check: async () => ({ ok: false, message: 'postgres://user:secret@host/db' }),
        },
        { name: 'asset_storage', check: async () => ({ ok: true }) },
        { name: 'mcp', check: async () => ({ ok: true }) },
      ],
    });
    const res = await app.inject({ method: 'GET', url: '/readyz' });
    const body = JSON.stringify(res.json());
    expect(res.json().checks.migrations.error).toBe('check_failed');
    expect(body).not.toContain('postgres://');
    expect(body).not.toContain('secret');
  });

  it('maps a hanging check to the timeout error code', async () => {
    const config = loadConfig({ NODE_ENV: 'test' });
    const { projectService, stageService, taskService } = makeServices();
    const app = buildApp({
      config,
      projectService,
      stageService,
      taskService,
      readyzTimeoutMs: 50,
      readinessChecks: [
        { name: 'database', check: async () => ({ ok: true }) },
        {
          name: 'migrations',
          check: () => new Promise<never>(() => {}),
        },
        { name: 'asset_storage', check: async () => ({ ok: true }) },
        { name: 'mcp', check: async () => ({ ok: true }) },
      ],
    });
    const res = await app.inject({ method: 'GET', url: '/readyz' });
    expect(res.statusCode).toBe(503);
    expect(res.json().checks.migrations.error).toBe('timeout');
  });
});
