// packages/slingshot-orchestration-plugin/tests/plugin-config.test.ts
//
// Tests for the createOrchestrationPlugin configuration validation:
// - Adapter type resolution (adapter vs runtime)
// - Invalid config rejection
// - routes option interaction with routeMiddleware
// - Edge cases in task/workflow registration
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
  OrchestrationError,
  createMemoryAdapter,
  createOrchestrationRuntime,
  defineTask,
  defineWorkflow,
  sleep,
} from '@lastshotlabs/slingshot-orchestration';
import { createOrchestrationPlugin } from '../src/plugin';

const noopTask = defineTask({
  name: 'noop-task',
  input: z.object({}),
  output: z.object({}),
  async handler() {
    return {};
  },
});

const noopWorkflow = defineWorkflow({
  name: 'noop-workflow',
  input: z.object({}),
  steps: [sleep('step-a', 0)],
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

function setupPluginState(app: Hono) {
  const pluginState = new Map<unknown, unknown>();
  attachContext(app, { app, pluginState } as never);
  return pluginState;
}

describe('createOrchestrationPlugin — adapter type resolution', () => {
  test('accepts a prebuilt runtime and uses it directly', () => {
    const adapter = makeMockAdapter();
    const runtime = createOrchestrationRuntime({ adapter, tasks: [noopTask] });

    const plugin = createOrchestrationPlugin({
      runtime,
      tasks: [noopTask],
      routes: false,
    });

    const app = new Hono();
    setupPluginState(app);
    expect(() => plugin.setupRoutes?.(makeSetupContext(app))).not.toThrow();
  });

  test('accepts an adapter and builds an internal runtime', () => {
    const adapter = makeMockAdapter();
    const plugin = createOrchestrationPlugin({
      adapter,
      tasks: [noopTask],
      routes: false,
    });

    const app = new Hono();
    setupPluginState(app);
    expect(() => plugin.setupRoutes?.(makeSetupContext(app))).not.toThrow();
  });

  test('throws INVALID_CONFIG during setupRoutes when neither adapter nor runtime is provided', () => {
    const plugin = createOrchestrationPlugin({
      // @ts-expect-error - testing missing adapter/runtime
      tasks: [noopTask],
      routes: false,
    });

    const app = new Hono();
    setupPluginState(app);
    expect(() => plugin.setupRoutes?.(makeSetupContext(app))).toThrow(OrchestrationError);
  });

  test('when both adapter and runtime are provided, runtime wins silently', () => {
    const adapter = makeMockAdapter();
    const runtime = createOrchestrationRuntime({ adapter: makeMockAdapter(), tasks: [noopTask] });

    const plugin = createOrchestrationPlugin({
      // @ts-expect-error - testing conflicting adapter/runtime
      adapter,
      runtime,
      tasks: [noopTask],
      routes: false,
    });

    const app = new Hono();
    setupPluginState(app);
    // Should NOT throw — runtime takes precedence over adapter
    expect(() => plugin.setupRoutes?.(makeSetupContext(app))).not.toThrow();
  });
});

describe('createOrchestrationPlugin — task and workflow registration', () => {
  test('registers tasks with adapter during setupRoutes', () => {
    const adapter = makeMockAdapter();
    const plugin = createOrchestrationPlugin({
      adapter,
      tasks: [noopTask],
      routes: false,
    });

    const app = new Hono();
    setupPluginState(app);

    // Tasks are registered during setupRoutes when the runtime is built
    plugin.setupRoutes?.(makeSetupContext(app));
    expect(adapter.registerTask).toHaveBeenCalledWith(noopTask);
  });

  test('registers workflows with adapter during setupRoutes', () => {
    const adapter = makeMockAdapter();
    const plugin = createOrchestrationPlugin({
      adapter,
      tasks: [noopTask],
      workflows: [noopWorkflow],
      routes: false,
    });

    const app = new Hono();
    setupPluginState(app);

    plugin.setupRoutes?.(makeSetupContext(app));
    expect(adapter.registerWorkflow).toHaveBeenCalledWith(noopWorkflow);
  });

  test('does not crash with empty workflows array', () => {
    const adapter = makeMockAdapter();
    const plugin = createOrchestrationPlugin({
      adapter,
      tasks: [noopTask],
      workflows: [],
      routes: false,
    });

    expect(plugin.name).toBe('slingshot-orchestration');
  });
});

describe('createOrchestrationPlugin — routes option interaction', () => {
  test('throws INVALID_CONFIG when routes is true and routeMiddleware is empty (default)', () => {
    const adapter = makeMockAdapter();
    const plugin = createOrchestrationPlugin({
      adapter,
      tasks: [noopTask],
      routes: true,
    });

    const app = new Hono();
    setupPluginState(app);
    const ctx = makeSetupContext(app);

    expect(() => plugin.setupRoutes?.(ctx)).toThrow(OrchestrationError);
  });

  test('accepts routes:true with routeMiddleware provided', () => {
    const adapter = makeMockAdapter();
    const plugin = createOrchestrationPlugin({
      adapter,
      tasks: [noopTask],
      routes: true,
      routeMiddleware: [
        async (c, next) => {
          await next();
        },
      ],
    });

    const app = new Hono();
    setupPluginState(app);
    const ctx = makeSetupContext(app);

    expect(() => plugin.setupRoutes?.(ctx)).not.toThrow();
  });

  test('does not throw when routes is false even with empty routeMiddleware', () => {
    const adapter = makeMockAdapter();
    const plugin = createOrchestrationPlugin({
      adapter,
      tasks: [noopTask],
      routes: false,
    });

    const app = new Hono();
    setupPluginState(app);
    const ctx = makeSetupContext(app);

    expect(() => plugin.setupRoutes?.(ctx)).not.toThrow();
  });
});
