// packages/slingshot-orchestration-plugin/tests/prod-hardening-2.test.ts
//
// Prod-hardening edge cases for the orchestration plugin:
// - adminAuth behavior (Response vs throw)
// - routeMiddleware ordering
// - Event sink integration with real bus
// - Route prefix customization
// - Plugin lifecycle with prebuilt runtime
import { describe, expect, mock, test } from 'bun:test';
import { Hono } from 'hono';
import { z } from 'zod';
import {
  attachContext,
  createEventDefinitionRegistry,
  createEventPublisher,
  createInProcessAdapter,
} from '@lastshotlabs/slingshot-core';
import {
  createMemoryAdapter,
  createOrchestrationRuntime,
  defineTask,
} from '@lastshotlabs/slingshot-orchestration';
import { ORCHESTRATION_PLUGIN_KEY } from '../src/context';
import { createOrchestrationPlugin } from '../src/plugin';

const noopTask = defineTask({
  name: 'noop-task',
  input: z.object({}),
  output: z.object({}),
  async handler() {
    return {};
  },
});

function makeMockAdapter() {
  return {
    registerTask: mock(() => {}),
    registerWorkflow: mock(() => {}),
    runTask: mock(async () => ({ id: 'run-1', result: async () => ({}) })),
    runWorkflow: mock(async () => ({ id: 'run-1', result: async () => ({}) })),
    getRun: mock(async () => null),
    cancelRun: mock(async () => {}),
    start: mock(async () => {}),
    shutdown: mock(async () => {}),
  };
}

function makeSetupContext(app: Hono) {
  const bus = createInProcessAdapter();
  const events = createEventPublisher({
    definitions: createEventDefinitionRegistry(),
    bus,
  });
  return { app: app as never, bus, events, config: {} as never };
}

function attachMinimalContext(app: Hono) {
  const pluginState = new Map<unknown, unknown>();
  const capabilityProviders = new Map<string, string>();
  attachContext(app, { app, pluginState, capabilityProviders } as never);
  return pluginState;
}

describe('adminAuth — edge cases', () => {
  test('adminAuth returning Response denies access with that response', async () => {
    const adapter = makeMockAdapter();
    const runtime = createOrchestrationRuntime({ adapter, tasks: [noopTask] });
    const plugin = createOrchestrationPlugin({
      runtime,
      tasks: [noopTask],
      routes: true,
      routeMiddleware: [
        async (c, next) => {
          await next();
        },
      ],
      adminAuth: [
        async c => {
          return c.json({ error: 'custom denied' }, 403);
        },
      ],
    });

    const app = new Hono();
    attachMinimalContext(app);
    await plugin.setupRoutes?.(makeSetupContext(app));

    const response = await app.request('/orchestration/health');
    expect(response.status).toBe(403);
    const body = await response.json();
    expect(body.error).toBe('custom denied');
  });

  test('adminAuth returning error response denies access with structured error', async () => {
    const adapter = makeMockAdapter();
    const runtime = createOrchestrationRuntime({ adapter, tasks: [noopTask] });
    const plugin = createOrchestrationPlugin({
      runtime,
      tasks: [noopTask],
      routes: true,
      routeMiddleware: [
        async (c, next) => {
          await next();
        },
      ],
      adminAuth: [
        async c => {
          return c.json({ error: 'admin auth error', code: 'ADMIN_AUTH_FAILED' }, 500);
        },
      ],
    });

    const app = new Hono();
    attachMinimalContext(app);
    await plugin.setupRoutes?.(makeSetupContext(app));

    const response = await app.request('/orchestration/health');
    expect(response.status).toBe(500);
    const body = await response.json();
    expect(body.code).toBe('ADMIN_AUTH_FAILED');
  });

  test('without adminAuth, health endpoint is not gated by routeMiddleware', async () => {
    let middlewareRan = false;
    const adapter = makeMockAdapter();
    const runtime = createOrchestrationRuntime({ adapter, tasks: [noopTask] });
    const plugin = createOrchestrationPlugin({
      runtime,
      tasks: [noopTask],
      routes: true,
      routeMiddleware: [
        async (c, next) => {
          middlewareRan = true;
          await next();
        },
      ],
      // adminAuth not provided — health routes are mounted without adminAuth gate
      // and bypass routeMiddleware (admin routes skip routeMiddleware intentionally)
    });

    const app = new Hono();
    attachMinimalContext(app);
    await plugin.setupRoutes?.(makeSetupContext(app));

    const response = await app.request('/orchestration/health');
    expect(response.status).toBe(200);
    // Health routes bypass routeMiddleware, so middlewareRan stays false
    expect(middlewareRan).toBe(false);
  });
});

describe('routeMiddleware — ordering and execution', () => {
  test('multiple middleware entries execute in order', async () => {
    const order: number[] = [];
    const adapter = makeMockAdapter();
    const runtime = createOrchestrationRuntime({ adapter, tasks: [noopTask] });
    const plugin = createOrchestrationPlugin({
      runtime,
      tasks: [noopTask],
      routes: true,
      routeMiddleware: [
        async (_c, next) => {
          order.push(1);
          await next();
          order.push(4);
        },
        async (_c, next) => {
          order.push(2);
          await next();
          order.push(3);
        },
      ],
    });

    const app = new Hono();
    attachMinimalContext(app);
    await plugin.setupRoutes?.(makeSetupContext(app));

    await app.request('/orchestration/tasks/noop-task/runs', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });

    // Middleware 1 starts (1), middleware 2 runs (2), handler runs, middleware 2 resumes (3), middleware 1 resumes (4)
    expect(order).toEqual([1, 2, 3, 4]);
  });

  test('middleware can short-circuit before reaching the handler', async () => {
    const adapter = makeMockAdapter();
    const runtime = createOrchestrationRuntime({ adapter, tasks: [noopTask] });
    const plugin = createOrchestrationPlugin({
      runtime,
      tasks: [noopTask],
      routes: true,
      routeMiddleware: [
        async c => {
          return c.json({ blocked: true }, 401);
        },
      ],
    });

    const app = new Hono();
    attachMinimalContext(app);
    await plugin.setupRoutes?.(makeSetupContext(app));

    const response = await app.request('/orchestration/tasks/noop-task/runs', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(response.status).toBe(401);
    const body = await response.json();
    expect(body.blocked).toBe(true);
  });
});

describe('plugin — routePrefix customization', () => {
  test('custom routePrefix mounts routes at that path', async () => {
    const adapter = makeMockAdapter();
    const runtime = createOrchestrationRuntime({ adapter, tasks: [noopTask] });
    const plugin = createOrchestrationPlugin({
      runtime,
      tasks: [noopTask],
      routePrefix: '/jobs',
      routes: true,
      routeMiddleware: [
        async (c, next) => {
          await next();
        },
      ],
    });

    const app = new Hono();
    attachMinimalContext(app);
    await plugin.setupRoutes?.(makeSetupContext(app));

    const response = await app.request('/jobs/tasks');
    expect(response.status).toBe(200);
  });

  test('routes at default prefix still work when custom prefix is set', async () => {
    const adapter = makeMockAdapter();
    const runtime = createOrchestrationRuntime({ adapter, tasks: [noopTask] });
    const plugin = createOrchestrationPlugin({
      runtime,
      tasks: [noopTask],
      routePrefix: '/jobs',
      routes: true,
      routeMiddleware: [
        async (c, next) => {
          await next();
        },
      ],
    });

    const app = new Hono();
    attachMinimalContext(app);
    await plugin.setupRoutes?.(makeSetupContext(app));

    // Default prefix should NOT be mounted
    const response = await app.request('/orchestration/tasks');
    expect(response.status).toBe(404);
  });
});

describe('plugin — event sink integration with bus', () => {
  test('plugin stores runtime in pluginState after setupRoutes with adapter', async () => {
    const realAdapter = createMemoryAdapter({ concurrency: 1 });
    const plugin = createOrchestrationPlugin({
      adapter: realAdapter,
      tasks: [noopTask],
      routes: false,
    });

    const app = new Hono();
    const pluginState = attachMinimalContext(app);

    await plugin.setupRoutes?.(makeSetupContext(app));

    // After setupRoutes, the runtime is published as a contract capability under the
    // PACKAGE_CAPABILITIES_PREFIX slot for slingshot-orchestration.
    const slot = pluginState.get(
      'slingshot:package:capabilities:slingshot-orchestration',
    ) as Record<string, unknown> | undefined;
    expect(slot).toBeDefined();
    const runtime = slot?.runtime as Record<string, unknown> | undefined;
    expect(runtime).toBeDefined();
    expect(typeof runtime?.runTask).toBe('function');

    await realAdapter.shutdown();
  });

  test('runtime in pluginState can execute a task', async () => {
    const realAdapter = createMemoryAdapter({ concurrency: 1 });
    const plugin = createOrchestrationPlugin({
      adapter: realAdapter,
      tasks: [noopTask],
      routes: false,
    });

    const app = new Hono();
    const pluginState = attachMinimalContext(app);

    await plugin.setupRoutes?.(makeSetupContext(app));

    const slot = pluginState.get(
      'slingshot:package:capabilities:slingshot-orchestration',
    ) as Record<string, unknown>;
    const runtime = slot.runtime as {
      runTask: (task: unknown, input: unknown) => Promise<{ result: () => Promise<unknown> }>;
    };

    const handle = await runtime.runTask(noopTask, {});
    const result = await handle.result();
    // noopTask handler returns {}
    expect(result).toEqual({});

    await realAdapter.shutdown();
  });

  test('teardown disposes the event sink', async () => {
    const adapter = makeMockAdapter();
    const plugin = createOrchestrationPlugin({
      adapter,
      tasks: [noopTask],
      routes: false,
    });

    const app = new Hono();
    attachMinimalContext(app);
    await plugin.setupRoutes?.(makeSetupContext(app));

    // After teardown, the event sink is disposed. Teardown must not throw.
    await expect(plugin.teardown?.()).resolves.toBeUndefined();

    // Second teardown is idempotent
    await expect(plugin.teardown?.()).resolves.toBeUndefined();
  });
});
