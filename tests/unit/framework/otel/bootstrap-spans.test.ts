import { OpenAPIHono } from '@hono/zod-openapi';
import { describe, expect, mock, test } from 'bun:test';
import type { AppEnv, SlingshotEvents, SlingshotPlugin } from '@lastshotlabs/slingshot-core';
import { createInProcessAdapter } from '@lastshotlabs/slingshot-core';
import { withSpan, withSpanSync } from '../../../../src/framework/otel/spans';
import { getTracer, isTracingEnabled } from '../../../../src/framework/otel/tracer';
import {
  runPluginMiddleware,
  runPluginPost,
  runPluginRoutes,
} from '../../../../src/framework/runPluginLifecycle';

describe('bootstrap span helpers with no-op tracer', () => {
  test('withSpan completes normally with no-op tracer (no SDK)', async () => {
    const tracer = getTracer(undefined);
    const result = await withSpan(tracer, 'slingshot.bootstrap', async span => {
      span.setAttribute('slingshot.app_name', 'test');
      return 'done';
    });
    expect(result).toBe('done');
  });

  test('withSpan nested calls produce no errors with no-op tracer', async () => {
    const tracer = getTracer({ enabled: true, serviceName: 'test-app' });
    const result = await withSpan(tracer, 'slingshot.bootstrap', async span => {
      span.setAttribute('slingshot.app_name', 'test');

      await withSpan(tracer, 'slingshot.bootstrap.validate', async () => {
        // validation step
      });

      const secrets = await withSpan(tracer, 'slingshot.bootstrap.secrets', async innerSpan => {
        innerSpan.setAttribute('slingshot.secret_provider', 'env');
        return { framework: {} };
      });

      await withSpan(tracer, 'slingshot.bootstrap.infrastructure', async innerSpan => {
        innerSpan.setAttribute('slingshot.db.mongo', 'single');
        innerSpan.setAttribute('slingshot.db.redis', 'true');
      });

      return secrets;
    });
    expect(result).toEqual({ framework: {} });
  });

  test('isTracingEnabled guards span creation', () => {
    expect(isTracingEnabled(undefined)).toBe(false);
    expect(isTracingEnabled({ enabled: false })).toBe(false);
    expect(isTracingEnabled({ enabled: true })).toBe(true);
  });

  test('getTracer returns a usable tracer regardless of config', () => {
    const disabled = getTracer(undefined);
    const enabled = getTracer({ enabled: true });

    // Both should return valid tracer objects with startActiveSpan
    expect(typeof disabled.startActiveSpan).toBe('function');
    expect(typeof enabled.startActiveSpan).toBe('function');
  });

  test('withSpanSync works for synchronous bootstrap steps', () => {
    const tracer = getTracer({ enabled: true });
    const result = withSpanSync(tracer, 'slingshot.bootstrap.validate', span => {
      span.setAttribute('slingshot.test', 'value');
      return { warnings: [] };
    });
    expect(result).toEqual({ warnings: [] });
  });

  test('error in span is propagated correctly', async () => {
    const tracer = getTracer({ enabled: true });
    await expect(
      withSpan(tracer, 'slingshot.bootstrap.infrastructure', async () => {
        throw new Error('connection failed');
      }),
    ).rejects.toThrow('connection failed');
  });

  test('full bootstrap span hierarchy completes without error', async () => {
    const tracer = getTracer({ enabled: true, serviceName: 'test-app' });

    const result = await withSpan(tracer, 'slingshot.bootstrap', async rootSpan => {
      rootSpan.setAttribute('slingshot.app_name', 'test');

      await withSpan(tracer, 'slingshot.bootstrap.validate', async () => {});
      await withSpan(tracer, 'slingshot.bootstrap.secrets', async () => {});
      await withSpan(tracer, 'slingshot.bootstrap.infrastructure', async () => {});
      await withSpan(tracer, 'slingshot.bootstrap.context', async () => {});
      await withSpan(tracer, 'slingshot.bootstrap.middleware.framework', async () => {});
      await withSpan(tracer, 'slingshot.bootstrap.middleware.boundary', async () => {});
      await withSpan(tracer, 'slingshot.bootstrap.middleware.plugins', async () => {});
      await withSpan(tracer, 'slingshot.bootstrap.schemas', async () => {});
      await withSpan(tracer, 'slingshot.bootstrap.routes.plugins', async () => {});
      await withSpan(tracer, 'slingshot.bootstrap.routes.core', async () => {});
      await withSpan(tracer, 'slingshot.bootstrap.routes.service', async () => {});
      await withSpan(tracer, 'slingshot.bootstrap.post', async () => {});
      await withSpan(tracer, 'slingshot.bootstrap.finalize', async () => {});

      return 'bootstrapped';
    });

    expect(result).toBe('bootstrapped');
  });
});

describe('plugin lifecycle spans', () => {
  // Minimal framework config stub — plugins in these tests don't use it
  const frameworkConfig = {} as unknown as Parameters<typeof runPluginMiddleware>[2];
  const events = {} as SlingshotEvents;

  function makePlugin(name: string, deps?: string[]): SlingshotPlugin {
    return {
      name,
      dependencies: deps,
      setupMiddleware: mock(async () => {}),
      setupRoutes: mock(async () => {}),
      setupPost: mock(async () => {}),
    };
  }

  test('plugin lifecycle calls complete with tracer', async () => {
    const tracer = getTracer({ enabled: true });
    const bus = createInProcessAdapter();
    const app = new OpenAPIHono<AppEnv>();
    const plugin = makePlugin('test-plugin');

    await runPluginMiddleware([plugin], app, frameworkConfig, bus, events, tracer);
    await runPluginRoutes([plugin], app, frameworkConfig, bus, events, tracer);
    await runPluginPost([plugin], app, frameworkConfig, bus, events, tracer);

    expect(plugin.setupMiddleware).toHaveBeenCalledTimes(1);
    expect(plugin.setupRoutes).toHaveBeenCalledTimes(1);
    expect(plugin.setupPost).toHaveBeenCalledTimes(1);
  });

  test('plugin lifecycle calls complete without tracer', async () => {
    const bus = createInProcessAdapter();
    const app = new OpenAPIHono<AppEnv>();
    const plugin = makePlugin('test-plugin');

    await runPluginMiddleware([plugin], app, frameworkConfig, bus, events);
    await runPluginRoutes([plugin], app, frameworkConfig, bus, events);
    await runPluginPost([plugin], app, frameworkConfig, bus, events);

    expect(plugin.setupMiddleware).toHaveBeenCalledTimes(1);
    expect(plugin.setupRoutes).toHaveBeenCalledTimes(1);
    expect(plugin.setupPost).toHaveBeenCalledTimes(1);
  });

  test('multiple plugins are each called with tracer', async () => {
    const tracer = getTracer({ enabled: true });
    const bus = createInProcessAdapter();
    const app = new OpenAPIHono<AppEnv>();
    const pluginA = makePlugin('plugin-a');
    const pluginB = makePlugin('plugin-b', ['plugin-a']);

    await runPluginMiddleware([pluginA, pluginB], app, frameworkConfig, bus, events, tracer);

    expect(pluginA.setupMiddleware).toHaveBeenCalledTimes(1);
    expect(pluginB.setupMiddleware).toHaveBeenCalledTimes(1);
  });

  test('plugin error is propagated through span', async () => {
    const tracer = getTracer({ enabled: true });
    const bus = createInProcessAdapter();
    const app = new OpenAPIHono<AppEnv>();
    const plugin: SlingshotPlugin = {
      name: 'failing-plugin',
      setupMiddleware: mock(async () => {
        throw new Error('plugin setup failed');
      }),
    };

    await expect(
      runPluginMiddleware([plugin], app, frameworkConfig, bus, events, tracer),
    ).rejects.toThrow('plugin setup failed');
  });
});
