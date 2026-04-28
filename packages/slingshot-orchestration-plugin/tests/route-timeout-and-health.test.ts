import { describe, expect, test } from 'bun:test';
import { Hono } from 'hono';
import type { HealthReport } from '@lastshotlabs/slingshot-core';
import {
  type OrchestrationAdapter,
  type OrchestrationRuntime,
} from '@lastshotlabs/slingshot-orchestration';
import { createOrchestrationRouter } from '../src/routes';

const minimalAdapter = (): OrchestrationAdapter => ({
  registerTask() {},
  registerWorkflow() {},
  async runTask() {
    return { id: 'noop', result: () => Promise.resolve(undefined) } as never;
  },
  async runWorkflow() {
    return { id: 'noop', result: () => Promise.resolve(undefined) } as never;
  },
  async getRun() {
    return null;
  },
  async cancelRun() {},
  async listRuns() {
    return { runs: [], total: 0 };
  },
  supports() {
    return false;
  },
  async start() {},
  async shutdown() {},
});

function buildHangingRuntime(): OrchestrationRuntime {
  const adapter = minimalAdapter();
  return {
    runTask: () => new Promise(() => undefined),
    runWorkflow: () => new Promise(() => undefined),
    getRun: () => new Promise(() => undefined),
    cancelRun: async () => undefined,
    signal: async () => undefined,
    listRuns: () => new Promise(() => undefined),
    schedule: async () => ({ id: 'noop' }) as never,
    unschedule: async () => undefined,
    listSchedules: async () => [],
    onProgress: () => () => undefined,
    supports: cap => cap === 'observability',
    adapter,
  } as unknown as OrchestrationRuntime;
}

describe('orchestration routes — route timeout (P-OPLUGIN-2)', () => {
  test('runTask returns 504 with structured body when adapter await exceeds routeTimeoutMs', async () => {
    const runtime = buildHangingRuntime();
    const app = new Hono();
    app.route(
      '/orchestration',
      createOrchestrationRouter({
        runtime,
        tasks: [],
        workflows: [],
        routeTimeoutMs: 25,
      }),
    );

    const response = await app.request('/orchestration/tasks/anything/runs', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ input: {} }),
    });
    expect(response.status).toBe(504);
    const body = (await response.json()) as { code: string; timeoutMs: number };
    expect(body.code).toBe('ROUTE_TIMEOUT');
    expect(body.timeoutMs).toBe(25);
  });

  test('runWorkflow returns 504 when adapter await hangs past routeTimeoutMs', async () => {
    const runtime = buildHangingRuntime();
    const app = new Hono();
    app.route(
      '/orchestration',
      createOrchestrationRouter({
        runtime,
        tasks: [],
        workflows: [],
        routeTimeoutMs: 25,
      }),
    );

    const response = await app.request('/orchestration/workflows/anything/runs', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ input: {} }),
    });
    expect(response.status).toBe(504);
    const body = (await response.json()) as { code: string };
    expect(body.code).toBe('ROUTE_TIMEOUT');
  });

  test('list runs returns 504 when listRuns hangs past routeTimeoutMs', async () => {
    const runtime = buildHangingRuntime();
    const app = new Hono();
    app.route(
      '/orchestration',
      createOrchestrationRouter({
        runtime,
        tasks: [],
        workflows: [],
        routeTimeoutMs: 25,
      }),
    );

    const response = await app.request('/orchestration/runs');
    expect(response.status).toBe(504);
    const body = (await response.json()) as { code: string };
    expect(body.code).toBe('ROUTE_TIMEOUT');
  });
});

describe('orchestration routes — health classification (P-OPLUGIN-4)', () => {
  test('unhealthy state returns 503 with Retry-After when adapter implements checkHealth', async () => {
    const adapter = {
      ...minimalAdapter(),
      name: 'test-adapter',
      async checkHealth(): Promise<HealthReport> {
        return {
          state: 'unhealthy',
          message: 'broker disconnected',
          component: 'test-adapter',
        };
      },
    } as OrchestrationAdapter & { name: string; checkHealth: () => Promise<HealthReport> };

    const app = new Hono();
    app.route(
      '/orchestration',
      createOrchestrationRouter({
        runtime: buildHangingRuntime(),
        tasks: [],
        workflows: [],
        adapter,
      }),
    );

    const response = await app.request('/orchestration/health');
    expect(response.status).toBe(503);
    expect(response.headers.get('retry-after')).toBe('5');
    const body = (await response.json()) as { state: string; message: string };
    expect(body.state).toBe('unhealthy');
    expect(body.message).toBe('broker disconnected');
  });

  test('degraded state returns 503 with Retry-After', async () => {
    const adapter = {
      ...minimalAdapter(),
      name: 'test-adapter',
      async checkHealth(): Promise<HealthReport> {
        return {
          state: 'degraded',
          message: 'falling back',
          component: 'test-adapter',
        };
      },
    } as OrchestrationAdapter & { name: string; checkHealth: () => Promise<HealthReport> };

    const app = new Hono();
    app.route(
      '/orchestration',
      createOrchestrationRouter({
        runtime: buildHangingRuntime(),
        tasks: [],
        workflows: [],
        adapter,
      }),
    );

    const response = await app.request('/orchestration/health');
    expect(response.status).toBe(503);
    expect(response.headers.get('retry-after')).toBe('5');
  });

  test('checkHealth probe throw returns 500 (permanent)', async () => {
    const adapter = {
      ...minimalAdapter(),
      name: 'test-adapter',
      async checkHealth(): Promise<HealthReport> {
        throw new Error('probe blew up');
      },
    } as OrchestrationAdapter & { name: string; checkHealth: () => Promise<HealthReport> };

    const app = new Hono();
    app.route(
      '/orchestration',
      createOrchestrationRouter({
        runtime: buildHangingRuntime(),
        tasks: [],
        workflows: [],
        adapter,
      }),
    );

    const response = await app.request('/orchestration/health');
    expect(response.status).toBe(500);
    expect(response.headers.get('retry-after')).toBeNull();
  });

  test('healthy state returns 200', async () => {
    const adapter = {
      ...minimalAdapter(),
      name: 'test-adapter',
      async checkHealth(): Promise<HealthReport> {
        return { state: 'healthy', component: 'test-adapter' };
      },
    } as OrchestrationAdapter & { name: string; checkHealth: () => Promise<HealthReport> };

    const app = new Hono();
    app.route(
      '/orchestration',
      createOrchestrationRouter({
        runtime: buildHangingRuntime(),
        tasks: [],
        workflows: [],
        adapter,
      }),
    );

    const response = await app.request('/orchestration/health');
    expect(response.status).toBe(200);
  });
});
