import { describe, expect, test } from 'bun:test';
import { Hono } from 'hono';
import { z } from 'zod';
import {
  OrchestrationError,
  createMemoryAdapter,
  createOrchestrationRuntime,
  defineTask,
  defineWorkflow,
  sleep,
} from '@lastshotlabs/slingshot-orchestration';
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
        resolveRequestContext(c) {
          return {
            tenantId: c.req.header('x-tenant-id') ?? undefined,
            actorId: c.req.header('x-actor-id') ?? undefined,
          };
        },
        tasks: [task],
        workflows: [],
      }),
    );

    const response = await app.request('/orchestration/tasks/route-task/runs', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-tenant-id': 'tenant-route',
        'x-actor-id': 'actor-route',
      },
      body: JSON.stringify({ input: { value: 'via-route' } }),
    });

    expect(response.status).toBe(202);
    const body = await response.json();
    expect(typeof body.id).toBe('string');
    expect(body.links?.run).toBe(`/orchestration/runs/${body.id}`);

    const run = await runtime.getRun(body.id);
    expect(run?.tenantId).toBe('tenant-route');
    expect(run?.metadata).toEqual({ actorId: 'actor-route' });

    const listResponse = await app.request('/orchestration/runs', {
      headers: { 'x-tenant-id': 'tenant-route', 'x-actor-id': 'actor-route' },
    });
    expect(listResponse.status).toBe(200);
    const listed = await listResponse.json();
    expect(listed.total).toBe(1);

    const catalogResponse = await app.request('/orchestration/tasks');
    expect(catalogResponse.status).toBe(200);
    expect(await catalogResponse.json()).toEqual([{ name: 'route-task', description: null }]);
  });

  test('hides tenant-scoped runs from other tenants', async () => {
    const task = defineTask({
      name: 'tenant-isolated-task',
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
        resolveRequestContext(c) {
          return {
            tenantId: c.req.header('x-tenant-id') ?? undefined,
          };
        },
        tasks: [task],
        workflows: [],
      }),
    );

    const createResponse = await app.request('/orchestration/tasks/tenant-isolated-task/runs', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-tenant-id': 'tenant-a' },
      body: JSON.stringify({ input: { value: 'secret' } }),
    });
    const body = await createResponse.json();

    const readResponse = await app.request(`/orchestration/runs/${body.id}`, {
      headers: { 'x-tenant-id': 'tenant-b' },
    });
    expect(readResponse.status).toBe(404);

    const cancelResponse = await app.request(`/orchestration/runs/${body.id}`, {
      method: 'DELETE',
      headers: { 'x-tenant-id': 'tenant-b' },
    });
    expect(cancelResponse.status).toBe(404);
  });

  test('lists global runs alongside tenant-scoped runs for the active tenant', async () => {
    const task = defineTask({
      name: 'mixed-scope-task',
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

    await runtime.runTask(task, { value: 'global' });
    await runtime.runTask(task, { value: 'tenant-a' }, { tenantId: 'tenant-a' });
    await runtime.runTask(task, { value: 'tenant-b' }, { tenantId: 'tenant-b' });

    const app = new Hono();
    app.route(
      '/orchestration',
      createOrchestrationRouter({
        runtime,
        resolveRequestContext(c) {
          return {
            tenantId: c.req.header('x-tenant-id') ?? undefined,
          };
        },
        tasks: [task],
        workflows: [],
      }),
    );

    const response = await app.request('/orchestration/runs', {
      headers: { 'x-tenant-id': 'tenant-a' },
    });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.total).toBe(2);
    expect(body.runs).toHaveLength(2);
    expect(body.runs.every((run: { tenantId?: string }) => run.tenantId !== 'tenant-b')).toBe(true);
    expect(body.runs.some((run: { tenantId?: string }) => run.tenantId === undefined)).toBe(true);
    expect(body.runs.some((run: { tenantId?: string }) => run.tenantId === 'tenant-a')).toBe(true);
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
        resolveRequestContext(c) {
          return {
            tenantId: c.req.header('x-tenant-id') ?? undefined,
          };
        },
        tasks: [task],
        workflows: [],
      }),
    );

    const response = await app.request('/orchestration/runs/run_missing/signal/poke', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-tenant-id': 'tenant-route' },
      body: JSON.stringify({ payload: { ok: true } }),
    });

    expect(response.status).toBe(501);
  });

  test('supports custom run authorization independent of tenant context', async () => {
    const task = defineTask({
      name: 'actor-scoped-task',
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
        resolveRequestContext(c) {
          const actorId = c.req.header('x-actor-id');
          if (!actorId) {
            throw new OrchestrationError('VALIDATION_FAILED', 'missing x-actor-id');
          }
          return {
            tenantId: 'shared-tenant',
            actorId,
          };
        },
        authorizeRun({ context, run }) {
          return run.metadata?.['actorId'] === context.actorId;
        },
        tasks: [task],
        workflows: [],
      }),
    );

    const createResponse = await app.request('/orchestration/tasks/actor-scoped-task/runs', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-actor-id': 'actor-a' },
      body: JSON.stringify({ input: { value: 'private' } }),
    });
    expect(createResponse.status).toBe(202);
    const body = await createResponse.json();

    const allowedResponse = await app.request(`/orchestration/runs/${body.id}`, {
      headers: { 'x-actor-id': 'actor-a' },
    });
    expect(allowedResponse.status).toBe(200);

    const allowedListResponse = await app.request('/orchestration/runs', {
      headers: { 'x-actor-id': 'actor-a' },
    });
    expect(allowedListResponse.status).toBe(200);
    const allowedList = await allowedListResponse.json();
    expect(allowedList.total).toBe(1);

    const deniedResponse = await app.request(`/orchestration/runs/${body.id}`, {
      headers: { 'x-actor-id': 'actor-b' },
    });
    expect(deniedResponse.status).toBe(404);

    const deniedListResponse = await app.request('/orchestration/runs', {
      headers: { 'x-actor-id': 'actor-b' },
    });
    expect(deniedListResponse.status).toBe(200);
    const deniedList = await deniedListResponse.json();
    expect(deniedList.total).toBe(0);
  });

  test('workflow routes — POST /workflows/:name/runs creates a workflow run', async () => {
    const workflow = defineWorkflow({
      name: 'simple-workflow',
      input: z.object({ value: z.string() }),
      steps: [sleep('noop-step', 0)],
    });

    const runtime = createOrchestrationRuntime({
      adapter: createMemoryAdapter({ concurrency: 1 }),
      tasks: [],
      workflows: [workflow],
    });

    const app = new Hono();
    app.route(
      '/orchestration',
      createOrchestrationRouter({ runtime, tasks: [], workflows: [workflow] }),
    );

    const response = await app.request('/orchestration/workflows/simple-workflow/runs', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ input: { value: 'hello' } }),
    });

    expect(response.status).toBe(202);
    const body = await response.json();
    expect(typeof body.id).toBe('string');
    expect(body.type).toBe('workflow');
    expect(body.name).toBe('simple-workflow');
    expect(body.links?.run).toContain(body.id);
  });

  test('GET /workflows returns the workflow catalog', async () => {
    const workflow = defineWorkflow({
      name: 'catalog-workflow',
      input: z.object({}),
      steps: [sleep('step-a', 0)],
      description: 'A test workflow',
    });

    const runtime = createOrchestrationRuntime({
      adapter: createMemoryAdapter({ concurrency: 1 }),
      tasks: [],
      workflows: [workflow],
    });

    const app = new Hono();
    app.route(
      '/orchestration',
      createOrchestrationRouter({ runtime, tasks: [], workflows: [workflow] }),
    );

    const response = await app.request('/orchestration/workflows');
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toEqual([{ name: 'catalog-workflow', description: 'A test workflow' }]);
  });

  test('POST /tasks/:name/runs with malformed JSON body defaults to empty options', async () => {
    const task = defineTask({
      name: 'json-fallback-task',
      input: z.any(),
      output: z.any(),
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
      createOrchestrationRouter({ runtime, tasks: [task], workflows: [] }),
    );

    const response = await app.request('/orchestration/tasks/json-fallback-task/runs', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: 'not json {{{',
    });

    expect(response.status).toBe(202);
  });

  test('POST /tasks/:name/runs returns 404 when task is not registered', async () => {
    const task = defineTask({
      name: 'registered-task',
      input: z.any(),
      output: z.any(),
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
      createOrchestrationRouter({ runtime, tasks: [task], workflows: [] }),
    );

    const response = await app.request('/orchestration/tasks/nonexistent-task/runs', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });

    expect(response.status).toBe(404);
    const body = await response.json();
    expect(body.code).toBe('TASK_NOT_FOUND');
  });

  test('parseRunOptions — tags are capped at 50 entries and keys/values are truncated', async () => {
    const task = defineTask({
      name: 'tags-overflow-task',
      input: z.any(),
      output: z.any(),
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
      createOrchestrationRouter({ runtime, tasks: [task], workflows: [] }),
    );

    const manyTags: Record<string, string> = {};
    for (let i = 0; i < 60; i++) {
      manyTags[`tag-${i}`] = 'value';
    }
    const longKey = 'k'.repeat(300);
    const longValue = 'v'.repeat(2000);
    manyTags[longKey] = longValue;

    const response = await app.request('/orchestration/tasks/tags-overflow-task/runs', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ tags: manyTags }),
    });

    expect(response.status).toBe(202);
    const runId = (await response.json()).id;
    const run = await runtime.getRun(runId);
    const tags = run?.tags ?? {};
    expect(Object.keys(tags).length).toBe(50);
    expect(Object.keys(tags).every(k => k.length <= 256)).toBe(true);
    expect(Object.values(tags).every((v: unknown) => (v as string).length <= 1024)).toBe(true);
  });

  test('idempotency key from Idempotency-Key header deduplicates requests', async () => {
    const task = defineTask({
      name: 'idem-header-task',
      input: z.any(),
      output: z.any(),
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
      createOrchestrationRouter({ runtime, tasks: [task], workflows: [] }),
    );

    const makeRequest = () =>
      app.request('/orchestration/tasks/idem-header-task/runs', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'idempotency-key': 'my-idem-key-123' },
        body: JSON.stringify({}),
      });

    const first = await makeRequest();
    const second = await makeRequest();
    expect(first.status).toBe(202);
    expect(second.status).toBe(202);
    const firstId = (await first.json()).id;
    const secondId = (await second.json()).id;
    expect(firstId).toBe(secondId);
  });

  test('GET /runs filters by multiple statuses when status appears more than once', async () => {
    const task = defineTask({
      name: 'multi-status-task',
      input: z.any(),
      output: z.any(),
      async handler(input) {
        return input;
      },
    });

    const runtime = createOrchestrationRuntime({
      adapter: createMemoryAdapter({ concurrency: 1 }),
      tasks: [task],
    });

    await runtime.runTask(task, {});
    await runtime.runTask(task, {});

    const app = new Hono();
    app.route(
      '/orchestration',
      createOrchestrationRouter({ runtime, tasks: [task], workflows: [] }),
    );

    const response = await app.request(
      '/orchestration/runs?status=pending&status=running&status=invalid-status',
    );
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.total).toBeGreaterThanOrEqual(0);
    expect(body.runs).toBeDefined();
  });
});
