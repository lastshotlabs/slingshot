// Plugin-level integration tests for the prod-hardening fixes:
// - P-SSR-3: validate page adapters at plugin setup, not request time.
// - P-SSR-7: drain pending fire-and-forget ISR cache writes during teardown.
import { describe, expect, it } from 'bun:test';
import { Hono } from 'hono';
import {
  type AppEnv,
  type EntityRegistry,
  type ResolvedEntityConfig,
  createEntityRegistry,
} from '@lastshotlabs/slingshot-core';
import type { IsrCacheAdapter, IsrCacheEntry } from '../../src/isr/types';
import type { PageDeclaration } from '../../src/pageDeclarations';
import { createSsrPlugin } from '../../src/plugin';
import type { SlingshotSsrRenderer, SsrRouteChain, SsrRouteMatch } from '../../src/types';

function makeRouteMatch(url: URL): SsrRouteMatch {
  return {
    filePath: '/fake/route.ts',
    metaFilePath: null,
    params: {},
    query: {},
    url,
    loadingFilePath: null,
    errorFilePath: null,
    notFoundFilePath: null,
    forbiddenFilePath: null,
    unauthorizedFilePath: null,
    templateFilePath: null,
  };
}

function makeMockRenderer(): SlingshotSsrRenderer {
  return {
    resolve: async (url): Promise<SsrRouteMatch> => makeRouteMatch(url),
    render: async () =>
      new Response('<html>SSR</html>', {
        headers: { 'Content-Type': 'text/html; charset=utf-8' },
      }),
    renderChain: async (chain: SsrRouteChain) =>
      new Response(`<html>SSR chain ${chain.page.url.pathname}</html>`, {
        headers: { 'Content-Type': 'text/html; charset=utf-8' },
      }),
  };
}

const mockBus = { on: () => {}, off: () => {}, emit: () => {}, drain: async () => {} } as never;

function makeFrameworkConfig(entityRegistry: EntityRegistry) {
  return { entityRegistry } as unknown as Parameters<
    NonNullable<ReturnType<typeof createSsrPlugin>['setupPost']>
  >[0]['config'];
}

describe('createSsrPlugin — P-SSR-3 page adapter validation at setup', () => {
  it('throws when a page references an unregistered entity', () => {
    const pages: Record<string, PageDeclaration> = {
      posts: {
        type: 'entity-list',
        path: '/posts',
        title: 'Posts',
        entity: 'post',
        fields: ['id'],
      } as PageDeclaration,
    };
    const plugin = createSsrPlugin({
      renderer: makeMockRenderer(),
      serverRoutesDir: '/fake/routes',
      assetsManifest: '/fake/manifest.json',
      devMode: true,
      pages,
    });

    // Empty registry — no adapter registered for the "post" entity.
    const registry = createEntityRegistry();
    const app = new Hono() as unknown as import('hono').Hono<AppEnv>;
    expect(() =>
      plugin.setupPost!({
        app,
        bus: mockBus,
        events: mockBus,
        config: makeFrameworkConfig(registry),
      }),
    ).toThrow(/no entity adapter registered for "post"/);
  });

  it('does not throw when every referenced entity has a registered config', () => {
    const pages: Record<string, PageDeclaration> = {
      posts: {
        type: 'entity-list',
        path: '/posts',
        title: 'Posts',
        entity: 'post',
        fields: ['id'],
      } as PageDeclaration,
    };
    const plugin = createSsrPlugin({
      renderer: makeMockRenderer(),
      serverRoutesDir: '/fake/routes',
      assetsManifest: '/fake/manifest.json',
      devMode: true,
      pages,
    });

    const registry = createEntityRegistry();
    registry.register({
      name: 'post',
      _pkField: 'id',
      _storageName: 'posts',
      fields: { id: { type: 'string', optional: false, primary: true, immutable: true } },
    } as unknown as ResolvedEntityConfig);

    const app = new Hono() as unknown as import('hono').Hono<AppEnv>;
    expect(() =>
      plugin.setupPost!({
        app,
        bus: mockBus,
        events: mockBus,
        config: makeFrameworkConfig(registry),
      }),
    ).not.toThrow();
  });

  it('error message names every offending page route, not just the first', () => {
    const pages: Record<string, PageDeclaration> = {
      a: {
        type: 'entity-list',
        path: '/alpha',
        title: 'A',
        entity: 'alpha',
        fields: ['id'],
      } as PageDeclaration,
      b: {
        type: 'entity-list',
        path: '/beta',
        title: 'B',
        entity: 'beta',
        fields: ['id'],
      } as PageDeclaration,
    };
    const plugin = createSsrPlugin({
      renderer: makeMockRenderer(),
      serverRoutesDir: '/fake/routes',
      assetsManifest: '/fake/manifest.json',
      devMode: true,
      pages,
    });

    const registry = createEntityRegistry();
    const app = new Hono() as unknown as import('hono').Hono<AppEnv>;
    let captured: Error | undefined;
    try {
      plugin.setupPost!({
        app,
        bus: mockBus,
        events: mockBus,
        config: makeFrameworkConfig(registry),
      });
    } catch (err) {
      captured = err as Error;
    }
    expect(captured).toBeInstanceOf(Error);
    expect(captured?.message).toContain('/alpha');
    expect(captured?.message).toContain('/beta');
    expect(captured?.message).toContain('alpha');
    expect(captured?.message).toContain('beta');
  });
});

describe('createSsrPlugin — P-SSR-7 ISR cache write drain on teardown', () => {
  it('teardown awaits in-flight ISR cache writes up to cacheFlushTimeoutMs', async () => {
    // Drive a real request through the middleware to enqueue a fire-and-forget
    // cache write, then assert teardown awaits the in-flight set() before
    // resolving. The adapter holds set() for 100ms; teardown must take at
    // least that long but no more than the configured timeout.
    const { attachContext } = await import('@lastshotlabs/slingshot-core');
    let setEnd = 0;
    const adapter: IsrCacheAdapter = {
      get: async () => null,
      set: async (_key, _entry: IsrCacheEntry) => {
        await new Promise(resolve => setTimeout(resolve, 100));
        setEnd = Date.now();
      },
      invalidatePath: async () => {},
      invalidateTag: async () => {},
    };

    const renderer: SlingshotSsrRenderer = {
      resolve: async (url): Promise<SsrRouteMatch> => makeRouteMatch(url),
      render: async (_match, shell) => {
        // Populate the ISR sink so the middleware writes to the cache.
        if (shell._isr) (shell._isr as { revalidate?: number }).revalidate = 60;
        return new Response('<html>fresh</html>', {
          headers: { 'content-type': 'text/html; charset=utf-8' },
        });
      },
      renderChain: async (chain, shell) => {
        if (shell._isr) (shell._isr as { revalidate?: number }).revalidate = 60;
        return new Response(`<html>fresh:${chain.page.url.pathname}</html>`, {
          headers: { 'content-type': 'text/html; charset=utf-8' },
        });
      },
    };

    const plugin = createSsrPlugin({
      renderer,
      serverRoutesDir: '/fake/routes',
      assetsManifest: '/fake/manifest.json',
      devMode: true,
      isr: { adapter, cacheFlushTimeoutMs: 5_000 },
    });

    const app = new Hono() as unknown as import('hono').Hono<AppEnv>;
    // Attach a stub context with pluginState so plugin.setupMiddleware succeeds.
    (attachContext as (...args: unknown[]) => void)(app, {
      app,
      pluginState: new Map(),
    });
    plugin.setupMiddleware!({
      app,
      bus: mockBus,
      events: mockBus,
      config: {} as never,
    });

    // Issue a request — the middleware renders and queues a cache.set().
    const honoApp = app as unknown as { request: (path: string) => Promise<Response> };
    const res = await honoApp.request('/some/route');
    expect(res.status).toBe(200);
    // Drain the response so the middleware's internal flow has settled.
    await res.text();

    // The cache write is fire-and-forget; teardown must await it.
    const start = Date.now();
    await plugin.teardown!();
    const elapsed = Date.now() - start;
    // The adapter holds set() for 100ms. Teardown awaits it before returning.
    expect(elapsed).toBeGreaterThanOrEqual(50);
    expect(setEnd).toBeGreaterThan(0);
  });

  it('teardown returns promptly when no ISR writes are pending', async () => {
    const adapter: IsrCacheAdapter = {
      get: async () => null,
      set: async () => {},
      invalidatePath: async () => {},
      invalidateTag: async () => {},
    };
    const plugin = createSsrPlugin({
      renderer: makeMockRenderer(),
      serverRoutesDir: '/fake/routes',
      assetsManifest: '/fake/manifest.json',
      devMode: true,
      isr: { adapter, cacheFlushTimeoutMs: 1_000 },
    });
    const start = Date.now();
    await plugin.teardown!();
    expect(Date.now() - start).toBeLessThan(100);
  });

  it('teardown bails after cacheFlushTimeoutMs when a write hangs', async () => {
    const { attachContext } = await import('@lastshotlabs/slingshot-core');
    const adapter: IsrCacheAdapter = {
      get: async () => null,
      // set() never resolves
      set: async () => new Promise<void>(() => {}),
      invalidatePath: async () => {},
      invalidateTag: async () => {},
    };
    const renderer: SlingshotSsrRenderer = {
      resolve: async (url): Promise<SsrRouteMatch> => makeRouteMatch(url),
      render: async (_match, shell) => {
        if (shell._isr) (shell._isr as { revalidate?: number }).revalidate = 60;
        return new Response('<html>fresh</html>', {
          headers: { 'content-type': 'text/html; charset=utf-8' },
        });
      },
      renderChain: async (chain, shell) => {
        if (shell._isr) (shell._isr as { revalidate?: number }).revalidate = 60;
        return new Response(`<html>fresh:${chain.page.url.pathname}</html>`, {
          headers: { 'content-type': 'text/html; charset=utf-8' },
        });
      },
    };
    const plugin = createSsrPlugin({
      renderer,
      serverRoutesDir: '/fake/routes',
      assetsManifest: '/fake/manifest.json',
      devMode: true,
      isr: { adapter, cacheFlushTimeoutMs: 50 },
    });
    const app = new Hono() as unknown as import('hono').Hono<AppEnv>;
    (attachContext as (...args: unknown[]) => void)(app, { app, pluginState: new Map() });
    plugin.setupMiddleware!({ app, bus: mockBus, events: mockBus, config: {} as never });

    const honoApp = app as unknown as { request: (path: string) => Promise<Response> };
    const res = await honoApp.request('/route-x');
    await res.text();

    const start = Date.now();
    await plugin.teardown!();
    const elapsed = Date.now() - start;
    // Teardown gives up after the configured timeout instead of hanging.
    expect(elapsed).toBeGreaterThanOrEqual(40);
    expect(elapsed).toBeLessThan(500);
  });
});
