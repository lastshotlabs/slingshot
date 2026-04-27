import { describe, expect, mock, test } from 'bun:test';
import { Hono } from 'hono';
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
} from '@lastshotlabs/slingshot-orchestration';
import { z } from 'zod';
import { createOrchestrationPlugin } from '../src/plugin';
import { ORCHESTRATION_PLUGIN_KEY, getOrchestration, getOrchestrationOrNull } from '../src/context';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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
  attachContext(app, { app, pluginState } as never);
  return pluginState;
}

const noopTask = defineTask({
  name: 'noop',
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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('createOrchestrationPlugin — metadata', () => {
  test('plugin has the correct name', () => {
    const adapter = makeMockAdapter();
    const plugin = createOrchestrationPlugin({ adapter, tasks: [noopTask], routes: false });
    expect(plugin.name).toBe(ORCHESTRATION_PLUGIN_KEY);
    expect(plugin.name).toBe('slingshot-orchestration');
  });

  test('plugin has empty dependencies array', () => {
    const adapter = makeMockAdapter();
    const plugin = createOrchestrationPlugin({ adapter, tasks: [noopTask], routes: false });
    expect(plugin.dependencies).toEqual([]);
  });
});

describe('createOrchestrationPlugin — setupRoutes with routes: true', () => {
  test('throws INVALID_CONFIG when routeMiddleware is empty', () => {
    const adapter = makeMockAdapter();
    const plugin = createOrchestrationPlugin({
      adapter,
      tasks: [noopTask],
      routes: true,
      // routeMiddleware defaults to []
    });

    const app = new Hono();
    attachMinimalContext(app);
    const ctx = makeSetupContext(app);

    let caught: unknown;
    try {
      plugin.setupRoutes?.(ctx);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(OrchestrationError);
    expect((caught as OrchestrationError).code).toBe('INVALID_CONFIG');
  });

  test('throws with correct message about routeMiddleware requirement', () => {
    const adapter = makeMockAdapter();
    const plugin = createOrchestrationPlugin({
      adapter,
      tasks: [noopTask],
      routes: true,
      routeMiddleware: [],
    });

    const app = new Hono();
    attachMinimalContext(app);
    const ctx = makeSetupContext(app);

    let caught: unknown;
    try {
      plugin.setupRoutes?.(ctx);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(OrchestrationError);
    expect((caught as OrchestrationError).message).toContain('routeMiddleware');
  });

  test('mounts routes when routeMiddleware is provided', async () => {
    const adapter = makeMockAdapter();
    const guardCalled: boolean[] = [];
    const plugin = createOrchestrationPlugin({
      adapter,
      tasks: [noopTask],
      routes: true,
      routeMiddleware: [
        async (c, next) => {
          guardCalled.push(true);
          await next();
        },
      ],
    });

    const app = new Hono();
    attachMinimalContext(app);
    const ctx = makeSetupContext(app);

    expect(() => plugin.setupRoutes?.(ctx)).not.toThrow();
  });

  test('publishes runtime on pluginState after setupRoutes', () => {
    const adapter = makeMockAdapter();
    const plugin = createOrchestrationPlugin({
      adapter,
      tasks: [noopTask],
      routes: false,
    });

    const app = new Hono();
    const pluginState = attachMinimalContext(app);
    const ctx = makeSetupContext(app);

    plugin.setupRoutes?.(ctx);

    expect(pluginState.has(ORCHESTRATION_PLUGIN_KEY)).toBe(true);
  });
});

describe('createOrchestrationPlugin — setupRoutes with routes: false', () => {
  test('does not throw when routes: false and routeMiddleware is empty', () => {
    const adapter = makeMockAdapter();
    const plugin = createOrchestrationPlugin({
      adapter,
      tasks: [noopTask],
      routes: false,
    });

    const app = new Hono();
    attachMinimalContext(app);
    const ctx = makeSetupContext(app);

    expect(() => plugin.setupRoutes?.(ctx)).not.toThrow();
  });

  test('still publishes runtime on pluginState when routes: false', () => {
    const adapter = makeMockAdapter();
    const plugin = createOrchestrationPlugin({
      adapter,
      tasks: [noopTask],
      routes: false,
    });

    const app = new Hono();
    const pluginState = attachMinimalContext(app);
    const ctx = makeSetupContext(app);

    plugin.setupRoutes?.(ctx);

    expect(pluginState.has(ORCHESTRATION_PLUGIN_KEY)).toBe(true);
  });
});

describe('createOrchestrationPlugin — setupPost / teardown with adapter', () => {
  test('setupPost calls adapter.start()', async () => {
    const adapter = makeMockAdapter();
    const plugin = createOrchestrationPlugin({
      adapter,
      tasks: [noopTask],
      routes: false,
    });

    await plugin.setupPost?.({} as never);

    expect(adapter.start).toHaveBeenCalledTimes(1);
  });

  test('teardown calls adapter.shutdown()', async () => {
    const adapter = makeMockAdapter();
    const plugin = createOrchestrationPlugin({
      adapter,
      tasks: [noopTask],
      routes: false,
    });

    await plugin.teardown?.();

    expect(adapter.shutdown).toHaveBeenCalledTimes(1);
  });
});

describe('createOrchestrationPlugin — setupPost / teardown with runtime', () => {
  test('setupPost does not call start when a prebuilt runtime is provided', async () => {
    const adapter = makeMockAdapter();
    const runtime = createOrchestrationRuntime({ adapter, tasks: [noopTask] });
    const startSpy = mock(async () => {});
    adapter.start = startSpy;

    const plugin = createOrchestrationPlugin({
      runtime,
      tasks: [noopTask],
      routes: false,
    });

    await plugin.setupPost?.({} as never);

    // adapter.start() should NOT be called when a prebuilt runtime is passed
    expect(startSpy).not.toHaveBeenCalled();
  });

  test('teardown does not call shutdown when a prebuilt runtime is provided', async () => {
    const adapter = makeMockAdapter();
    const runtime = createOrchestrationRuntime({ adapter, tasks: [noopTask] });
    const shutdownSpy = mock(async () => {});
    adapter.shutdown = shutdownSpy;

    const plugin = createOrchestrationPlugin({
      runtime,
      tasks: [noopTask],
      routes: false,
    });

    await plugin.teardown?.();

    expect(shutdownSpy).not.toHaveBeenCalled();
  });
});

describe('getOrchestration / getOrchestrationOrNull', () => {

  test('getOrchestrationOrNull returns null when plugin not registered', () => {
    const ctx = { pluginState: new Map() } as never;
    expect(getOrchestrationOrNull(ctx)).toBeNull();
  });

  test('getOrchestration throws when plugin not registered', () => {
    const ctx = { pluginState: new Map() } as never;
    let caught: unknown;
    try {
      getOrchestration(ctx);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(OrchestrationError);
    expect((caught as OrchestrationError).code).toBe('ADAPTER_ERROR');
  });

  test('getOrchestration returns runtime published by setupRoutes', () => {
    const adapter = makeMockAdapter();
    const plugin = createOrchestrationPlugin({
      adapter,
      tasks: [noopTask],
      routes: false,
    });

    const app = new Hono();
    const pluginState = attachMinimalContext(app);
    plugin.setupRoutes?.(makeSetupContext(app));

    const ctx = { pluginState } as never;
    const runtime = getOrchestration(ctx);
    expect(runtime).toBeDefined();
    expect(typeof runtime.runTask).toBe('function');
  });
});
