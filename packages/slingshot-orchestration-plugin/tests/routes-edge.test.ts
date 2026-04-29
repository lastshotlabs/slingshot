// packages/slingshot-orchestration-plugin/tests/routes-edge.test.ts
//
// Edge cases for orchestration HTTP routes: invalid runId format, missing
// required params, malformed request bodies, empty payloads.
import { describe, expect, mock, test } from 'bun:test';
import { Hono } from 'hono';
import { z } from 'zod';
import {
  OrchestrationError,
  createMemoryAdapter,
  createOrchestrationRuntime,
  defineTask,
} from '@lastshotlabs/slingshot-orchestration';
import type { OrchestrationRuntime } from '@lastshotlabs/slingshot-orchestration';
import { createOrchestrationRouter } from '../src/routes';

describe('orchestration routes — edge cases', () => {
  const task = defineTask({
    name: 'edge-task',
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

  test('GET /runs with non-existent runId returns 404', async () => {
    const response = await app.request('/orchestration/runs/nonexistent-run-id');
    expect(response.status).toBe(404);
    const body = await response.json();
    expect(body.code).toBe('RUN_NOT_FOUND');
  });

  test('DELETE /runs with non-existent runId returns 404', async () => {
    const response = await app.request('/orchestration/runs/nonexistent-run-id', {
      method: 'DELETE',
    });
    expect(response.status).toBe(404);
    const body = await response.json();
    expect(body.code).toBe('RUN_NOT_FOUND');
  });

  test('POST /tasks/:name/runs with empty body defaults to empty input', async () => {
    // Tasks that accept any input should handle empty body gracefully
    const anyTask = defineTask({
      name: 'any-input-task',
      input: z.any(),
      output: z.any(),
      async handler(input) {
        return input;
      },
    });

    const rt = createOrchestrationRuntime({
      adapter: createMemoryAdapter({ concurrency: 1 }),
      tasks: [anyTask],
    });

    const testApp = new Hono();
    testApp.route(
      '/orchestration',
      createOrchestrationRouter({ runtime: rt, tasks: [anyTask], workflows: [] }),
    );

    // POST with "{}" -> input is undefined -> handler receives undefined
    const response = await testApp.request('/orchestration/tasks/any-input-task/runs', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(response.status).toBe(202);
    const body = await response.json();
    expect(body.type).toBe('task');
  });

  test('POST /tasks/:name/runs with empty JSON body string works', async () => {
    const anyTask = defineTask({
      name: 'empty-body-task',
      input: z.any(),
      output: z.any(),
      async handler(input) {
        return input;
      },
    });

    const rt = createOrchestrationRuntime({
      adapter: createMemoryAdapter({ concurrency: 1 }),
      tasks: [anyTask],
    });

    const testApp = new Hono();
    testApp.route(
      '/orchestration',
      createOrchestrationRouter({ runtime: rt, tasks: [anyTask], workflows: [] }),
    );

    const response = await testApp.request('/orchestration/tasks/empty-body-task/runs', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '',
    });
    // Empty body yields JSON parse error -> 400
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toContain('Invalid JSON');
  });

  test('POST /tasks/:name/runs with no content-type header is still parsed', async () => {
    const anyTask = defineTask({
      name: 'no-content-type-task',
      input: z.any(),
      output: z.any(),
      async handler(input) {
        return input;
      },
    });

    const rt = createOrchestrationRuntime({
      adapter: createMemoryAdapter({ concurrency: 1 }),
      tasks: [anyTask],
    });

    const testApp = new Hono();
    testApp.route(
      '/orchestration',
      createOrchestrationRouter({ runtime: rt, tasks: [anyTask], workflows: [] }),
    );

    const response = await testApp.request('/orchestration/tasks/no-content-type-task/runs', {
      method: 'POST',
      body: JSON.stringify({}),
    });
    // Hono should still parse the JSON body even without content-type header
    expect(response.status).toBe(202);
  });

  test('GET /tasks returns empty array when no tasks are registered', async () => {
    const emptyApp = new Hono();
    emptyApp.route(
      '/orchestration',
      createOrchestrationRouter({
        runtime: createOrchestrationRuntime({
          adapter: createMemoryAdapter({ concurrency: 1 }),
          tasks: [],
        }),
        tasks: [],
        workflows: [],
      }),
    );

    const response = await emptyApp.request('/orchestration/tasks');
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toEqual([]);
  });

  test('POST /runs/:id/signal/:name with no capabilities returns 501', async () => {
    const mockRuntime = {
      runTask: mock(async () => ({ id: 'r1', result: async () => ({}) })),
      runWorkflow: mock(async () => ({ id: 'r1', result: async () => ({}) })),
      getRun: mock(async () => ({ id: 'r1', type: 'task', status: 'running' })),
      cancelRun: mock(async () => {}),
      listRuns: mock(async () => ({ runs: [], total: 0 })),
      onProgress: mock(() => () => {}),
      supports: (cap: string) => cap !== 'signals',
    } as unknown as OrchestrationRuntime;

    const testApp = new Hono();
    testApp.route(
      '/orchestration',
      createOrchestrationRouter({ runtime: mockRuntime, tasks: [], workflows: [] }),
    );

    const response = await testApp.request('/orchestration/runs/r1/signal/pause', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(response.status).toBe(501);
  });
});
