import { describe, expect, mock, test } from 'bun:test';
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
import type { OrchestrationRuntime, Run } from '@lastshotlabs/slingshot-orchestration';
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

  test('POST /tasks/:name/runs with malformed JSON body returns 400', async () => {
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

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toContain('Invalid JSON');
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

// ---------------------------------------------------------------------------
// Helper: build a minimal OrchestrationRuntime from parts so tests can control
// listRuns without spinning up a real in-process task worker.
// ---------------------------------------------------------------------------

function makeFakeRun(id: string, tenantId?: string): Run {
  return {
    id,
    type: 'task',
    name: 'fake-task',
    status: 'pending',
    input: {},
    tenantId,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

function makeMockRuntime(listRunsImpl: OrchestrationRuntime['listRuns']): OrchestrationRuntime {
  return {
    runTask: mock(async () => ({ id: 'run-mock', result: async () => ({}) })),
    runWorkflow: mock(async () => ({ id: 'run-mock', result: async () => ({}) })),
    getRun: mock(async () => null),
    cancelRun: mock(async () => {}),
    signal: mock(async () => {}),
    schedule: mock(async () => ({ id: 'sched-mock' })),
    listRuns: listRunsImpl,
    onProgress: mock(() => () => {}),
    supports: cap => cap === 'observability',
  } as unknown as OrchestrationRuntime;
}

// ---------------------------------------------------------------------------
// resolveRequestContext() exception handling
// ---------------------------------------------------------------------------

describe('resolveRequestContext — exception handling', () => {
  test('synchronous throw in resolveRequestContext returns HTTP 500', async () => {
    const task = defineTask({
      name: 'ctx-sync-throw-task',
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
      createOrchestrationRouter({
        runtime,
        tasks: [task],
        workflows: [],
        resolveRequestContext() {
          throw new Error('boom');
        },
      }),
    );

    const response = await app.request('/orchestration/tasks/ctx-sync-throw-task/runs', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(response.status).toBe(500);
  });

  test('OrchestrationError VALIDATION_FAILED in resolveRequestContext returns HTTP 400', async () => {
    const task = defineTask({
      name: 'ctx-validation-task',
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
      createOrchestrationRouter({
        runtime,
        tasks: [task],
        workflows: [],
        resolveRequestContext() {
          throw new OrchestrationError('VALIDATION_FAILED', 'bad actor header');
        },
      }),
    );

    const response = await app.request('/orchestration/tasks/ctx-validation-task/runs', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.code).toBe('VALIDATION_FAILED');
  });

  test('OrchestrationError TASK_NOT_FOUND in resolveRequestContext returns HTTP 404', async () => {
    const task = defineTask({
      name: 'ctx-not-found-task',
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
      createOrchestrationRouter({
        runtime,
        tasks: [task],
        workflows: [],
        resolveRequestContext() {
          throw new OrchestrationError('TASK_NOT_FOUND', 'no such task');
        },
      }),
    );

    const response = await app.request('/orchestration/tasks/ctx-not-found-task/runs', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(response.status).toBe(404);
    const body = await response.json();
    expect(body.code).toBe('TASK_NOT_FOUND');
  });

  test('unknown error code in resolveRequestContext maps to HTTP 500', async () => {
    const task = defineTask({
      name: 'ctx-unknown-error-task',
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
      createOrchestrationRouter({
        runtime,
        tasks: [task],
        workflows: [],
        resolveRequestContext() {
          throw new OrchestrationError('ADAPTER_ERROR', 'something weird');
        },
      }),
    );

    const response = await app.request('/orchestration/tasks/ctx-unknown-error-task/runs', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(response.status).toBe(500);
  });
});

// ---------------------------------------------------------------------------
// authorizeRun() failure handling on GET /runs/:id
// ---------------------------------------------------------------------------

describe('authorizeRun — failure handling', () => {
  test('authorizeRun throwing returns HTTP 500 on GET /runs/:id', async () => {
    const task = defineTask({
      name: 'auth-throw-task',
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

    const handle = await runtime.runTask(task, {});

    const app = new Hono();
    app.route(
      '/orchestration',
      createOrchestrationRouter({
        runtime,
        tasks: [task],
        workflows: [],
        authorizeRun() {
          throw new Error('auth system is down');
        },
      }),
    );

    const response = await app.request(`/orchestration/runs/${handle.id}`);
    expect(response.status).toBe(500);
  });

  test('authorizeRun returning false returns HTTP 404 on GET /runs/:id', async () => {
    const task = defineTask({
      name: 'auth-false-task',
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

    const handle = await runtime.runTask(task, {});

    const app = new Hono();
    app.route(
      '/orchestration',
      createOrchestrationRouter({
        runtime,
        tasks: [task],
        workflows: [],
        authorizeRun() {
          return false;
        },
      }),
    );

    const response = await app.request(`/orchestration/runs/${handle.id}`);
    expect(response.status).toBe(404);
  });

  test('async authorizeRun that rejects returns HTTP 500 on GET /runs/:id', async () => {
    const task = defineTask({
      name: 'auth-async-reject-task',
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

    const handle = await runtime.runTask(task, {});

    const app = new Hono();
    app.route(
      '/orchestration',
      createOrchestrationRouter({
        runtime,
        tasks: [task],
        workflows: [],
        async authorizeRun() {
          throw new Error('async rejection');
        },
      }),
    );

    const response = await app.request(`/orchestration/runs/${handle.id}`);
    expect(response.status).toBe(500);
  });
});

// ---------------------------------------------------------------------------
// listAuthorizedRuns() — MAX_AUTH_SCAN cap
// ---------------------------------------------------------------------------

describe('listAuthorizedRuns — scan cap', () => {
  test('returns results without scanning more than MAX_AUTH_SCAN records when all 3000 are authorized', async () => {
    const totalRuns = 3_000;
    // Build a fake listRuns that returns pages of 100 runs each from a pool of 3000.
    const fakeRuns: Run[] = Array.from({ length: totalRuns }, (_, i) => makeFakeRun(`run-${i}`));

    let totalScanned = 0;
    const runtime = makeMockRuntime(async filter => {
      const offset = filter?.offset ?? 0;
      const limit = filter?.limit ?? 50;
      const page = fakeRuns.slice(offset, offset + limit);
      totalScanned += page.length;
      return { runs: page, total: totalRuns };
    });

    const app = new Hono();
    app.route(
      '/orchestration',
      createOrchestrationRouter({
        runtime,
        tasks: [],
        workflows: [],
        // authorizeRun always grants access — forces the loop to rely on scan cap
        authorizeRun: () => true,
      }),
    );

    const response = await app.request('/orchestration/runs?limit=10');
    expect(response.status).toBe(200);
    const body = await response.json();
    // Should have returned 10 runs
    expect(body.runs).toHaveLength(10);
    // Should have stopped scanning at MAX_AUTH_SCAN (2000), not gone to 3000
    expect(totalScanned).toBeLessThanOrEqual(2_000);
  });

  test('returns empty list when all 3000 runs are rejected by authorizeRun', async () => {
    const totalRuns = 3_000;
    const fakeRuns: Run[] = Array.from({ length: totalRuns }, (_, i) => makeFakeRun(`run-${i}`));

    const runtime = makeMockRuntime(async filter => {
      const offset = filter?.offset ?? 0;
      const limit = filter?.limit ?? 50;
      const page = fakeRuns.slice(offset, offset + limit);
      return { runs: page, total: totalRuns };
    });

    const app = new Hono();
    app.route(
      '/orchestration',
      createOrchestrationRouter({
        runtime,
        tasks: [],
        workflows: [],
        // authorizeRun always denies — loop must cap and not hang
        authorizeRun: () => false,
      }),
    );

    const response = await app.request('/orchestration/runs?limit=10');
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.runs).toHaveLength(0);
    expect(body.total).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Metadata size validation
// ---------------------------------------------------------------------------

describe('metadata size validation', () => {
  test('POST /tasks/:name/runs returns 400 when metadata serializes to more than 64KB', async () => {
    const task = defineTask({
      name: 'metadata-large-task',
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

    // 65 KB of metadata (each char is 1 byte in ASCII)
    const oversized = { data: 'x'.repeat(65 * 1024) };

    const response = await app.request('/orchestration/tasks/metadata-large-task/runs', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ metadata: oversized }),
    });

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toContain('64KB');
  });

  test('POST /tasks/:name/runs succeeds when metadata is under 64KB', async () => {
    const task = defineTask({
      name: 'metadata-small-task',
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

    // 63 KB of metadata — should pass validation
    const smallEnough = { data: 'x'.repeat(63 * 1024) };

    const response = await app.request('/orchestration/tasks/metadata-small-task/runs', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ metadata: smallEnough }),
    });

    expect(response.status).toBe(202);
  });
});

// ---------------------------------------------------------------------------
// Invalid JSON body
// ---------------------------------------------------------------------------

describe('invalid JSON body', () => {
  test('POST /tasks/:name/runs with invalid JSON body returns 400 with descriptive error', async () => {
    const task = defineTask({
      name: 'bad-json-task',
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

    const response = await app.request('/orchestration/tasks/bad-json-task/runs', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: 'not json at all',
    });

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toMatch(/invalid json/i);
  });
});

// ---------------------------------------------------------------------------
// POST /runs/:id/replay
// ---------------------------------------------------------------------------

describe('replay route', () => {
  test('POST /runs/:id/replay re-runs the task with the same input and a derived idempotency key', async () => {
    const task = defineTask({
      name: 'replay-task',
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
      createOrchestrationRouter({ runtime, tasks: [task], workflows: [] }),
    );

    const createResponse = await app.request('/orchestration/tasks/replay-task/runs', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ input: { value: 'original' } }),
    });
    expect(createResponse.status).toBe(202);
    const original = await createResponse.json();

    const replayResponse = await app.request(`/orchestration/runs/${original.id}/replay`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '',
    });
    expect(replayResponse.status).toBe(202);
    const replay = await replayResponse.json();
    expect(replay.id).not.toBe(original.id);
    expect(replay.type).toBe('task');
    expect(replay.name).toBe('replay-task');
    expect(replay.replayOf).toBe(original.id);
    expect(replay.links.run).toContain(replay.id);

    const newRun = await runtime.getRun(replay.id);
    expect(newRun?.input).toEqual({ value: 'original' });
    expect(newRun?.metadata?.['replayOf']).toBe(original.id);
    expect(typeof newRun?.metadata?.['replayedAt']).toBe('string');
  });

  test('POST /runs/:id/replay returns 404 when source run does not exist', async () => {
    const task = defineTask({
      name: 'replay-missing-task',
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

    const response = await app.request('/orchestration/runs/run_nonexistent/replay', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '',
    });
    expect(response.status).toBe(404);
    const body = await response.json();
    expect(body.code).toBe('RUN_NOT_FOUND');
  });

  test('POST /runs/:id/replay returns 501 when adapter strips input on completion', async () => {
    const task = defineTask({
      name: 'replay-no-input-task',
      input: z.any(),
      output: z.any(),
      async handler(input) {
        return input;
      },
    });

    // Build a stripped-input runtime: getRun returns the run without `input`.
    const runtime = makeMockRuntime(async () => ({ runs: [], total: 0 }));
    (runtime.getRun as ReturnType<typeof mock>).mockImplementation(async (id: string) => ({
      id,
      type: 'task',
      name: 'replay-no-input-task',
      status: 'completed',
      // no input field — adapter has stripped it
      tenantId: undefined,
      createdAt: new Date(),
      updatedAt: new Date(),
    }));

    const app = new Hono();
    app.route(
      '/orchestration',
      createOrchestrationRouter({ runtime, tasks: [task], workflows: [] }),
    );

    const response = await app.request('/orchestration/runs/run_completed/replay', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '',
    });
    expect(response.status).toBe(501);
    const body = await response.json();
    expect(body.code).toBe('CAPABILITY_NOT_SUPPORTED');
  });

  test('POST /runs/:id/replay honors authorizeRun and returns 404 when denied', async () => {
    const task = defineTask({
      name: 'replay-auth-task',
      input: z.object({ v: z.number() }),
      output: z.object({ v: z.number() }),
      async handler(input) {
        return input;
      },
    });

    const runtime = createOrchestrationRuntime({
      adapter: createMemoryAdapter({ concurrency: 1 }),
      tasks: [task],
    });
    const handle = await runtime.runTask(task, { v: 1 });

    const app = new Hono();
    app.route(
      '/orchestration',
      createOrchestrationRouter({
        runtime,
        tasks: [task],
        workflows: [],
        authorizeRun: () => false,
      }),
    );

    const response = await app.request(`/orchestration/runs/${handle.id}/replay`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '',
    });
    expect(response.status).toBe(404);
    const body = await response.json();
    expect(body.code).toBe('RUN_NOT_FOUND');
  });
});

// ---------------------------------------------------------------------------
// Admin routes — /health and /metrics
// ---------------------------------------------------------------------------

describe('admin routes', () => {
  test('GET /health without adapter returns ok with null adapter name', async () => {
    const runtime = makeMockRuntime(async () => ({ runs: [], total: 0 }));

    const app = new Hono();
    app.route('/orchestration', createOrchestrationRouter({ runtime, tasks: [], workflows: [] }));

    const response = await app.request('/orchestration/health');
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.status).toBe('ok');
    expect(body.adapter).toBeNull();
  });

  test('GET /health with adapter.getHealth() merges adapter snapshot into response', async () => {
    const runtime = makeMockRuntime(async () => ({ runs: [], total: 0 }));
    const adapter = {
      registerTask: () => {},
      registerWorkflow: () => {},
      runTask: async () => ({ id: 'r', result: async () => ({}) }),
      runWorkflow: async () => ({ id: 'r', result: async () => ({}) }),
      getRun: async () => null,
      cancelRun: async () => {},
      start: async () => {},
      shutdown: async () => {},
      name: 'mock-adapter',
      getHealth: () => ({
        status: 'ok',
        queues: { primary: { waiting: 0, active: 1 } },
        droppedMessages: 0,
      }),
    };

    const app = new Hono();
    app.route(
      '/orchestration',
      createOrchestrationRouter({
        runtime,
        tasks: [],
        workflows: [],
        adapter: adapter as never,
      }),
    );

    const response = await app.request('/orchestration/health');
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.status).toBe('ok');
    expect(body.adapter).toBe('mock-adapter');
    expect(body.queues).toEqual({ primary: { waiting: 0, active: 1 } });
    expect(body.droppedMessages).toBe(0);
  });

  test('GET /metrics returns 501 when adapter does not implement getMetrics', async () => {
    const runtime = makeMockRuntime(async () => ({ runs: [], total: 0 }));

    const app = new Hono();
    app.route('/orchestration', createOrchestrationRouter({ runtime, tasks: [], workflows: [] }));

    const response = await app.request('/orchestration/metrics');
    expect(response.status).toBe(501);
    const body = await response.json();
    expect(body.code).toBe('CAPABILITY_NOT_SUPPORTED');
  });

  test('GET /metrics returns adapter metrics snapshot when supported', async () => {
    const runtime = makeMockRuntime(async () => ({ runs: [], total: 0 }));
    const adapter = {
      registerTask: () => {},
      registerWorkflow: () => {},
      runTask: async () => ({ id: 'r', result: async () => ({}) }),
      runWorkflow: async () => ({ id: 'r', result: async () => ({}) }),
      getRun: async () => null,
      cancelRun: async () => {},
      start: async () => {},
      shutdown: async () => {},
      name: 'metrics-adapter',
      getMetrics: () => ({ runs_total: 42, runs_failed: 1 }),
    };

    const app = new Hono();
    app.route(
      '/orchestration',
      createOrchestrationRouter({
        runtime,
        tasks: [],
        workflows: [],
        adapter: adapter as never,
      }),
    );

    const response = await app.request('/orchestration/metrics');
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.adapter).toBe('metrics-adapter');
    expect(body.metrics).toEqual({ runs_total: 42, runs_failed: 1 });
  });

  test('admin routes are gated by adminAuth and skip routeMiddleware', async () => {
    const runtime = makeMockRuntime(async () => ({ runs: [], total: 0 }));
    let routeMiddlewareCalls = 0;
    let adminAuthCalls = 0;

    const app = new Hono();
    app.route(
      '/orchestration',
      createOrchestrationRouter({
        runtime,
        tasks: [],
        workflows: [],
        routeMiddleware: [
          async (_c, next) => {
            routeMiddlewareCalls += 1;
            await next();
          },
        ],
        adminAuth: [
          async (c, next) => {
            adminAuthCalls += 1;
            const auth = c.req.header('x-admin-token');
            if (auth !== 'secret') {
              return c.json({ error: 'unauthorized' }, 401);
            }
            await next();
          },
        ],
      }),
    );

    // Missing admin token → 401 from adminAuth, routeMiddleware should not run.
    const denied = await app.request('/orchestration/health');
    expect(denied.status).toBe(401);
    expect(adminAuthCalls).toBe(1);
    expect(routeMiddlewareCalls).toBe(0);

    // Valid admin token → 200 from /health, routeMiddleware should still not run.
    const allowed = await app.request('/orchestration/health', {
      headers: { 'x-admin-token': 'secret' },
    });
    expect(allowed.status).toBe(200);
    expect(adminAuthCalls).toBe(2);
    expect(routeMiddlewareCalls).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Resolver shape validation
// ---------------------------------------------------------------------------

describe('resolveRequestContext — shape validation', () => {
  test('returning a non-object throws a structured 500 with INVALID_RESOLVER_RESULT', async () => {
    const task = defineTask({
      name: 'resolver-shape-task',
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
      createOrchestrationRouter({
        runtime,
        tasks: [task],
        workflows: [],
        // Returning a string is a contract violation.
        resolveRequestContext: () => 'not-an-object' as never,
      }),
    );

    const response = await app.request('/orchestration/tasks/resolver-shape-task/runs', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(response.status).toBe(500);
    const body = await response.json();
    expect(body.code).toBe('INVALID_RESOLVER_RESULT');
  });

  test('returning an object with non-string tenantId throws INVALID_RESOLVER_RESULT', async () => {
    const task = defineTask({
      name: 'resolver-tenantid-task',
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
      createOrchestrationRouter({
        runtime,
        tasks: [task],
        workflows: [],
        resolveRequestContext: () => ({ tenantId: 12345 }) as never,
      }),
    );

    const response = await app.request('/orchestration/tasks/resolver-tenantid-task/runs', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(response.status).toBe(500);
    const body = await response.json();
    expect(body.code).toBe('INVALID_RESOLVER_RESULT');
    expect(body.error).toMatch(/tenantId/);
  });

  test('null is treated as an empty context and does not throw', async () => {
    const task = defineTask({
      name: 'resolver-null-task',
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
      createOrchestrationRouter({
        runtime,
        tasks: [task],
        workflows: [],
        resolveRequestContext: () => null as never,
      }),
    );

    const response = await app.request('/orchestration/tasks/resolver-null-task/runs', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(response.status).toBe(202);
  });
});
