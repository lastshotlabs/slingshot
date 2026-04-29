// packages/slingshot-orchestration-plugin/tests/context-edge.test.ts
//
// Edge-case tests for getOrchestration / getOrchestrationOrNull: missing
// plugin state, type safety, key consistency.
import { describe, expect, test } from 'bun:test';
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
} from '@lastshotlabs/slingshot-orchestration';
import { ORCHESTRATION_PLUGIN_KEY, getOrchestration, getOrchestrationOrNull } from '../src/context';
import * as pluginIndex from '../src/index';
import { createOrchestrationPlugin } from '../src/plugin';

describe('getOrchestrationOrNull — missing plugin state', () => {
  test('returns null when pluginState is empty', () => {
    const ctx = { pluginState: new Map() } as never;
    expect(getOrchestrationOrNull(ctx)).toBeNull();
  });

  test('returns null when pluginState has a different key', () => {
    const ctx = { pluginState: new Map([['other-plugin', {}]]) } as never;
    expect(getOrchestrationOrNull(ctx)).toBeNull();
  });

  test('returns raw value when pluginState value is not a runtime (no type guard)', () => {
    // getOrchestrationOrNull does not validate the runtime type, so a
    // non-runtime value stored under the plugin key is returned as-is.
    const ctx = { pluginState: new Map([[ORCHESTRATION_PLUGIN_KEY, 'not-a-runtime']]) } as never;
    const result = getOrchestrationOrNull(ctx);
    expect(result).toBe('not-a-runtime');
  });
});

describe('getOrchestration — error behavior', () => {
  test('throws OrchestrationError with ADAPTER_ERROR code when missing', () => {
    const ctx = { pluginState: new Map() } as never;
    expect(() => getOrchestration(ctx)).toThrow(OrchestrationError);
  });

  test('error message mentions the plugin registration', () => {
    const ctx = { pluginState: new Map() } as never;
    try {
      getOrchestration(ctx);
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(OrchestrationError);
      expect((err as OrchestrationError).code).toBe('ADAPTER_ERROR');
      expect((err as OrchestrationError).message).toContain('not registered');
    }
  });

  test('throws TypeError when pluginState is missing from context', () => {
    // getOrchestration accesses ctx.pluginState.get() — if pluginState is
    // undefined the runtime throws a TypeError, not an OrchestrationError.
    expect(() => getOrchestration({} as never)).toThrow(TypeError);
  });
});

describe('getOrchestration — returns runtime after plugin setup', () => {
  const noopTask = defineTask({
    name: 'context-test-task',
    input: z.object({}),
    output: z.object({}),
    async handler() {
      return {};
    },
  });

  test('returns a runtime with runTask capability', () => {
    const plugin = createOrchestrationPlugin({
      adapter: createMemoryAdapter({ concurrency: 1 }),
      tasks: [noopTask],
      routes: false,
    });

    const app = new Hono<{ Variables: { pluginState: Map<string | symbol, unknown> } }>();
    const pluginState = new Map<string | symbol, unknown>();
    attachContext(app, { app, pluginState } as never);
    plugin.setupRoutes?.({
      app: app as never,
      bus: createInProcessAdapter(),
      events: createEventPublisher({
        definitions: createEventDefinitionRegistry(),
        bus: createInProcessAdapter(),
      }),
      config: {} as never,
    });

    const runtime = getOrchestration({ pluginState } as never);
    expect(runtime).toBeDefined();
    expect(typeof runtime.runTask).toBe('function');
    expect(typeof runtime.getRun).toBe('function');
  });

  test('getOrchestrationOrNull returns runtime after plugin setup', () => {
    const plugin = createOrchestrationPlugin({
      adapter: createMemoryAdapter({ concurrency: 1 }),
      tasks: [noopTask],
      routes: false,
    });

    const app = new Hono<{ Variables: { pluginState: Map<string | symbol, unknown> } }>();
    const pluginState = new Map<string | symbol, unknown>();
    attachContext(app, { app, pluginState } as never);
    plugin.setupRoutes?.({
      app: app as never,
      bus: createInProcessAdapter(),
      events: createEventPublisher({
        definitions: createEventDefinitionRegistry(),
        bus: createInProcessAdapter(),
      }),
      config: {} as never,
    });

    const runtime = getOrchestrationOrNull({ pluginState } as never);
    expect(runtime).not.toBeNull();
    expect(typeof runtime?.runTask).toBe('function');
  });
});

describe('ORCHESTRATION_PLUGIN_KEY', () => {
  test('is the string slingshot-orchestration', () => {
    expect(ORCHESTRATION_PLUGIN_KEY).toBe('slingshot-orchestration');
  });

  test('is exported from the package index', () => {
    expect(pluginIndex.ORCHESTRATION_PLUGIN_KEY).toBe('slingshot-orchestration');
  });
});
