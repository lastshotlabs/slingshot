import { describe, expect, it } from 'bun:test';
import { ssrPluginConfigSchema } from '../../src/config.schema';
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

function makeMockRenderer(overrides: Partial<SlingshotSsrRenderer> = {}): SlingshotSsrRenderer {
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
    ...overrides,
  };
}

describe('createSsrPlugin', () => {
  it('returns a SlingshotPlugin with name slingshot-ssr', () => {
    const plugin = createSsrPlugin({
      renderer: makeMockRenderer(),
      serverRoutesDir: '/fake/routes',
      assetsManifest: '/fake/manifest.json',
      devMode: true,
    });
    expect(plugin.name).toBe('slingshot-ssr');
  });

  it('has setupMiddleware lifecycle method', () => {
    const plugin = createSsrPlugin({
      renderer: makeMockRenderer(),
      serverRoutesDir: '/fake/routes',
      assetsManifest: '/fake/manifest.json',
      devMode: true,
    });
    expect(typeof plugin.setupMiddleware).toBe('function');
  });

  it('registers route and middleware lifecycle methods', () => {
    const plugin = createSsrPlugin({
      renderer: makeMockRenderer(),
      serverRoutesDir: '/fake/routes',
      assetsManifest: '/fake/manifest.json',
      devMode: true,
    });
    expect(typeof plugin.setupRoutes).toBe('function');
    expect(typeof plugin.setupPost).toBe('function');
  });
});

describe('createSsrPlugin — config validation', () => {
  it('throws ZodError when serverRoutesDir is missing', () => {
    expect(() =>
      createSsrPlugin({
        renderer: makeMockRenderer(),
        serverRoutesDir: '',
        assetsManifest: '/fake/manifest.json',
        devMode: true,
      }),
    ).toThrow();
  });

  it('throws ZodError when assetsManifest is missing', () => {
    expect(() =>
      createSsrPlugin({
        renderer: makeMockRenderer(),
        serverRoutesDir: '/fake/routes',
        assetsManifest: '',
        devMode: true,
      }),
    ).toThrow();
  });

  it('throws ZodError when renderer is not an object', () => {
    expect(() =>
      createSsrPlugin({
        renderer: 'not-an-object' as never,
        serverRoutesDir: '/fake/routes',
        assetsManifest: '/fake/manifest.json',
        devMode: true,
      }),
    ).toThrow();
  });
});

describe('ssrPluginConfigSchema', () => {
  it('accepts valid config shape', () => {
    const result = ssrPluginConfigSchema.safeParse({
      renderer: { resolve: () => {}, render: () => {}, renderChain: () => {} },
      serverRoutesDir: '/app/server/routes',
      assetsManifest: '/app/dist/.vite/manifest.json',
      devMode: true,
    });
    expect(result.success).toBe(true);
  });

  it('rejects empty serverRoutesDir', () => {
    const result = ssrPluginConfigSchema.safeParse({
      renderer: { resolve: () => {}, render: () => {}, renderChain: () => {} },
      serverRoutesDir: '',
      assetsManifest: '/app/dist/.vite/manifest.json',
    });
    expect(result.success).toBe(false);
  });

  it('accepts optional fields', () => {
    const result = ssrPluginConfigSchema.safeParse({
      renderer: { resolve: () => {}, render: () => {}, renderChain: () => {} },
      serverRoutesDir: '/routes',
      assetsManifest: '/manifest.json',
      entryPoint: 'app.html',
      cacheControl: { default: 'no-store', routes: { '/': 'public, max-age=300' } },
      exclude: ['/admin', '/webhooks'],
      devMode: false,
    });
    expect(result.success).toBe(true);
  });
});

describe('createSsrPlugin — production mode manifest check', () => {
  it('throws at setupMiddleware time when manifest is missing in production', async () => {
    const plugin = createSsrPlugin({
      renderer: makeMockRenderer(),
      serverRoutesDir: '/fake/routes',
      assetsManifest: '/nonexistent/manifest.json',
      devMode: false, // production mode — manifest is required
    });

    const { Hono } = await import('hono');
    const app = new Hono();

    const mockBus = {
      on: () => {},
      emit: () => {},
      drain: async () => {},
    };

    expect(() =>
      plugin.setupMiddleware!({
        app,
        bus: mockBus as any,
        config: {} as any,
      }),
    ).toThrow('[slingshot-ssr]');
  });

  it('does NOT throw at setupMiddleware time in dev mode', async () => {
    const plugin = createSsrPlugin({
      renderer: makeMockRenderer(),
      serverRoutesDir: '/fake/routes',
      assetsManifest: '/nonexistent/manifest.json',
      devMode: true, // dev mode — manifest is optional
    });

    const { Hono } = await import('hono');
    const app = new Hono();

    const mockBus = {
      on: () => {},
      emit: () => {},
      drain: async () => {},
    };

    expect(() =>
      plugin.setupMiddleware!({
        app,
        bus: mockBus as any,
        config: {} as any,
      }),
    ).not.toThrow();
  });
});
