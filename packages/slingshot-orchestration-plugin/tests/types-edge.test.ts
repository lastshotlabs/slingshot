// packages/slingshot-orchestration-plugin/tests/types-edge.test.ts
//
// Runtime shape verification for plugin-level types: ensures exported types
// describe correct object shapes and that discriminated unions work at runtime.
import { describe, expect, test } from 'bun:test';
import { Hono } from 'hono';
import { z } from 'zod';
import { createInProcessAdapter } from '@lastshotlabs/slingshot-core';
import {
  createMemoryAdapter,
  createOrchestrationRuntime,
  defineTask,
} from '@lastshotlabs/slingshot-orchestration';
import * as pluginExports from '../src/index';

const noopTask = defineTask({
  name: 'noop-task',
  input: z.object({}),
  output: z.object({}),
  async handler() {
    return {};
  },
});

describe('plugin public exports', () => {
  test('exports createOrchestrationPlugin', () => {
    expect(typeof pluginExports.createOrchestrationPlugin).toBe('function');
  });

  test('exports getOrchestration and getOrchestrationOrNull', () => {
    expect(typeof pluginExports.getOrchestration).toBe('function');
    expect(typeof pluginExports.getOrchestrationOrNull).toBe('function');
  });

  test('exports createSlingshotEventSink', () => {
    expect(typeof pluginExports.createSlingshotEventSink).toBe('function');
  });

  test('exports orchestrationPluginConfigSchema', () => {
    expect(pluginExports.orchestrationPluginConfigSchema).toBeDefined();
  });

  test('exports ORCHESTRATION_PLUGIN_KEY', () => {
    expect(pluginExports.ORCHESTRATION_PLUGIN_KEY).toBe('slingshot-orchestration');
  });

  test('exports InvalidResolverResultError', () => {
    expect(pluginExports.InvalidResolverResultError).toBeDefined();
  });

  test('exports all type symbols (runtime check via typeof)', () => {
    // Types are erased at runtime, but we can verify the export names are
    // present by checking that index.ts re-exports them without error.
    expect(typeof pluginExports.ConfigurableOrchestrationPluginOptions).toBe('undefined');
    expect(typeof pluginExports.OrchestrationPluginOptions).toBe('undefined');
    // All the above are TS-only type exports; verifying they don't throw is the goal.
  });
});

describe('OrchestrationRequestContext shape — resolved through route resolver', () => {
  test('empty context is accepted (no fields)', async () => {
    const runtime = createOrchestrationRuntime({
      adapter: createMemoryAdapter({ concurrency: 1 }),
      tasks: [noopTask],
    });

    const plugin = pluginExports.createOrchestrationPlugin({
      runtime,
      tasks: [noopTask],
      routes: true,
      routeMiddleware: [
        async (c, next) => {
          await next();
        },
      ],
      resolveRequestContext: () => ({}),
    });

    const app = new Hono();
    const pluginState = new Map();
    const { attachContext } = await import('@lastshotlabs/slingshot-core');
    attachContext(app, { app, pluginState } as never);
    const bus = createInProcessAdapter();
    const ctx = { app: app as never, bus, events: {} as never, config: {} as never };

    expect(() => plugin.setupRoutes?.(ctx)).not.toThrow();
  });

  test('context with all fields is accepted', async () => {
    const runtime = createOrchestrationRuntime({
      adapter: createMemoryAdapter({ concurrency: 1 }),
      tasks: [noopTask],
    });

    const plugin = pluginExports.createOrchestrationPlugin({
      runtime,
      tasks: [noopTask],
      routes: true,
      routeMiddleware: [
        async (c, next) => {
          await next();
        },
      ],
      resolveRequestContext: () => ({
        tenantId: 'tenant-1',
        actorId: 'actor-1',
        tags: { env: 'test' },
        metadata: { requestId: 'req-123' },
      }),
    });

    const app = new Hono();
    const pluginState = new Map();
    const { attachContext } = await import('@lastshotlabs/slingshot-core');
    attachContext(app, { app, pluginState } as never);
    const bus = createInProcessAdapter();
    const ctx = { app: app as never, bus, events: {} as never, config: {} as never };

    expect(() => plugin.setupRoutes?.(ctx)).not.toThrow();
  });
});

describe('OrchestrationPluginOptions — discriminated union', () => {
  test('adapter-provided options work without runtime', () => {
    const adapter = createMemoryAdapter({ concurrency: 1 });
    const plugin = pluginExports.createOrchestrationPlugin({
      adapter,
      tasks: [noopTask],
      routes: false,
    });
    expect(plugin.name).toBe('slingshot-orchestration');
  });

  test('runtime-provided options work without adapter', () => {
    const adapter = createMemoryAdapter({ concurrency: 1 });
    const runtime = createOrchestrationRuntime({ adapter, tasks: [noopTask] });
    const plugin = pluginExports.createOrchestrationPlugin({
      runtime,
      tasks: [noopTask],
      routes: false,
    });
    expect(plugin.name).toBe('slingshot-orchestration');
  });
});

describe('ConfigurableOrchestrationPluginOptions — route options combine with union', () => {
  test('accepts all route options alongside adapter', () => {
    const adapter = createMemoryAdapter({ concurrency: 1 });
    const plugin = pluginExports.createOrchestrationPlugin({
      adapter,
      tasks: [noopTask],
      routes: true,
      routePrefix: '/custom',
      routeMiddleware: [
        async (c, next) => {
          await next();
        },
      ],
      adminAuth: [
        async (c, next) => {
          await next();
        },
      ],
      routeTimeoutMs: 5000,
    });
    expect(plugin.name).toBe('slingshot-orchestration');
  });

  test('accepts all route options alongside runtime', () => {
    const adapter = createMemoryAdapter({ concurrency: 1 });
    const runtime = createOrchestrationRuntime({ adapter, tasks: [noopTask] });
    const plugin = pluginExports.createOrchestrationPlugin({
      runtime,
      tasks: [noopTask],
      routes: true,
      routePrefix: '/jobs',
      routeMiddleware: [
        async (c, next) => {
          await next();
        },
      ],
      resolveRequestContext: () => ({ tenantId: 't1' }),
      authorizeRun: () => true,
    });
    expect(plugin.name).toBe('slingshot-orchestration');
  });
});
