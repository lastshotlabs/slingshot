import { afterEach, describe, expect, test } from 'bun:test';
import {
  type SlingshotPlugin,
  createInProcessAdapter,
  getContext,
  isPluginStateSealed,
  publishPluginState,
} from '@lastshotlabs/slingshot-core';
import { createApp } from '../../src/app';
import { getTenantCacheFromApp } from '../../src/framework/middleware/tenant';

const baseConfig = {
  meta: { name: 'Finalization Test App' },
  db: {
    mongo: false as const,
    redis: false,
    sessions: 'memory' as const,
    cache: 'memory' as const,
    auth: 'memory' as const,
  },
  security: {
    rateLimit: { windowMs: 60_000, max: 1000 },
    signing: {
      secret: 'test-secret-key-must-be-at-least-32-chars!!',
      sessionBinding: false as const,
    },
  },
  logging: { onLog: () => {} },
};

const createdContexts: Array<{ destroy(): Promise<void> }> = [];

afterEach(async () => {
  for (const ctx of createdContexts.splice(0)) {
    await ctx.destroy().catch(() => {});
  }
});

describe('app finalization', () => {
  test('serves OpenAPI docs even when no routesDir is configured', async () => {
    const result = await createApp(baseConfig);
    createdContexts.push(result.ctx);

    const specResponse = await result.app.request('/openapi.json');
    expect(specResponse.status).toBe(200);
    await expect(specResponse.json()).resolves.toMatchObject({
      info: { title: 'Finalization Test App', version: '1.0.0' },
    });

    const docsResponse = await result.app.request('/docs');
    expect(docsResponse.status).toBe(200);
    expect(docsResponse.headers.get('content-type')).toContain('text/html');
  });

  test('emits app:ready with framework plugin names after bootstrap finalization', async () => {
    const bus = createInProcessAdapter();
    let payload: unknown;
    bus.on('app:ready', event => {
      payload = event;
    });

    const plugin: SlingshotPlugin = {
      name: 'probe-plugin',
      async setupRoutes() {},
    };

    const result = await createApp({
      ...baseConfig,
      eventBus: bus,
      plugins: [plugin],
    });
    createdContexts.push(result.ctx);

    expect(payload).toEqual({ plugins: ['probe-plugin'] });
  });

  test('emits app:ready only after registrar-backed context state is finalized', async () => {
    const bus = createInProcessAdapter();
    const routeAuth = {
      userAuth: async (_c: unknown, next: () => Promise<void>) => {
        await next();
      },
      requireRole: () => async (_c: unknown, next: () => Promise<void>) => {
        await next();
      },
    };
    let observedRouteAuth: unknown = undefined;

    const publisher: SlingshotPlugin = {
      name: 'publisher',
      async setupPost({ config }) {
        config.registrar.setRouteAuth(routeAuth as never);
      },
    };
    const observer: SlingshotPlugin = {
      name: 'observer',
      async setupPost({ app, bus }) {
        bus.on('app:ready', () => {
          observedRouteAuth = getContext(app).routeAuth;
        });
      },
    };

    const result = await createApp({
      ...baseConfig,
      eventBus: bus,
      plugins: [publisher, observer],
    });
    createdContexts.push(result.ctx);

    expect(observedRouteAuth).toBe(routeAuth);
  });

  test('freezes the plugin-facing framework config before plugin lifecycle execution', async () => {
    let observedConfig: Record<string, unknown> | null = null;

    const plugin: SlingshotPlugin = {
      name: 'freeze-probe',
      async setupMiddleware({ config }) {
        observedConfig = config as unknown as Record<string, unknown>;
      },
    };

    const result = await createApp({
      ...baseConfig,
      plugins: [plugin],
    });
    createdContexts.push(result.ctx);

    expect(observedConfig).not.toBeNull();
    expect(Object.isFrozen(observedConfig)).toBe(true);
    expect(Object.isFrozen(observedConfig!['security'])).toBe(true);
  });

  test('does not emit app:ready when only setup()-only plugins are present', async () => {
    const bus = createInProcessAdapter();
    let emitted = false;
    bus.on('app:ready', () => {
      emitted = true;
    });

    const plugin: SlingshotPlugin = {
      name: 'standalone-plugin',
      async setup() {},
    };

    const result = await createApp({
      ...baseConfig,
      eventBus: bus,
      plugins: [plugin],
    });
    createdContexts.push(result.ctx);

    expect(emitted).toBe(false);
  });

  test('attaches the tenant resolution cache to context pluginState when enabled', async () => {
    const result = await createApp({
      ...baseConfig,
      tenancy: {
        resolution: 'header',
        cacheTtlMs: 60_000,
        onResolve: async tenantId => ({ tenantId }),
      },
    });
    createdContexts.push(result.ctx);

    const cacheFromContext = result.ctx.pluginState.get('tenantResolutionCache');
    expect(cacheFromContext).toBeDefined();
    expect(getTenantCacheFromApp(result.app)).toBe(cacheFromContext as any);
  });

  test('seals pluginState after finalization while preserving lifecycle publications', async () => {
    const plugin: SlingshotPlugin = {
      name: 'state-publisher',
      async setupPost({ app }) {
        publishPluginState(getContext(app).pluginState, 'state-publisher', { ready: true });
      },
    };

    const result = await createApp({
      ...baseConfig,
      plugins: [plugin],
    });
    createdContexts.push(result.ctx);

    expect(result.ctx.pluginState.get('state-publisher')).toEqual({ ready: true });
    expect(isPluginStateSealed(result.ctx.pluginState)).toBe(true);
    expect(() => publishPluginState(result.ctx.pluginState, 'late-plugin', true)).toThrow(
      'pluginState is sealed after app bootstrap',
    );
    expect(() =>
      (result.ctx.pluginState as unknown as Map<string, unknown>).set('late-plugin', true),
    ).toThrow('pluginState is sealed after app bootstrap');
  });

  test('does not attach a tenant cache when no resolver is configured', async () => {
    const result = await createApp({
      ...baseConfig,
      tenancy: {
        resolution: 'header',
      },
    });
    createdContexts.push(result.ctx);

    expect(result.ctx.pluginState.has('tenantResolutionCache')).toBe(false);
    expect(getTenantCacheFromApp(result.app)).toBeNull();
  });
});
