import { describe, expect, test } from 'bun:test';
import { Hono } from 'hono';
import { z } from 'zod';
import { createMemoryAdapter } from '@lastshotlabs/slingshot-orchestration';
import { defineTask } from '@lastshotlabs/slingshot-orchestration';
import { createOrchestrationRuntime } from '@lastshotlabs/slingshot-orchestration';
import { createOrchestrationRouter } from '../src/routes';

describe('orchestration routes', () => {
  test('starts runs through HTTP routes and propagates tenant context', async () => {
    const task = defineTask({
      name: 'route-task',
      input: z.object({ value: z.string() }),
      output: z.object({ value: z.string() }),
      async handler(input) {
        return input;
      },
    });

    const runtime = createOrchestrationRuntime({
      adapter: createMemoryAdapter({ concurrency: 1 }),
      tasks: [task],
    });

    const app = new Hono();
    app.route(
      '/orchestration',
      createOrchestrationRouter({
        runtime,
        routeMiddleware: [
          async (c, next) => {
            c.set('tenantId', 'tenant-route');
            await next();
          },
        ],
        tasks: [task],
        workflows: [],
      }),
    );

    const response = await app.request('/orchestration/tasks/route-task/runs', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ input: { value: 'via-route' } }),
    });

    expect(response.status).toBe(202);
    const body = await response.json();
    expect(typeof body.id).toBe('string');

    const run = await runtime.getRun(body.id);
    expect(run?.tenantId).toBe('tenant-route');

    const listResponse = await app.request('/orchestration/runs');
    expect(listResponse.status).toBe(200);
    const listed = await listResponse.json();
    expect(listed.total).toBe(1);
  });

  test('returns not implemented for signal routes when adapter lacks signal support', async () => {
    const task = defineTask({
      name: 'signal-route-task',
      input: z.object({ value: z.string() }),
      output: z.object({ value: z.string() }),
      async handler(input) {
        return input;
      },
    });

    const runtime = createOrchestrationRuntime({
      adapter: createMemoryAdapter({ concurrency: 1 }),
      tasks: [task],
    });

    const app = new Hono();
    app.route(
      '/orchestration',
      createOrchestrationRouter({
        runtime,
        routeMiddleware: [async (_c, next) => next()],
        tasks: [task],
        workflows: [],
      }),
    );

    const response = await app.request('/orchestration/runs/run_missing/signal/poke', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ payload: { ok: true } }),
    });

    expect(response.status).toBe(501);
  });
});
