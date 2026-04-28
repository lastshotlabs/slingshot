// Tests for the ISR-aware Cache-Control header default.
//
// When a loader returns a positive `revalidate` (and the response is otherwise
// cacheable), the SSR middleware emits a public s-maxage / SWR directive so
// shared caches participate in the ISR freshness window.
import { describe, expect, it } from 'bun:test';
import { Hono } from 'hono';
import { type SlingshotContext, attachContext } from '@lastshotlabs/slingshot-core';
import { createMemoryIsrCache } from '../../src/isr/memory';
import { buildSsrMiddleware } from '../../src/middleware';
import type { IsrSink, SlingshotSsrRenderer, SsrRouteMatch } from '../../src/types';

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

function createIsrRenderer(revalidate: number | undefined): SlingshotSsrRenderer {
  return {
    resolve: async (url): Promise<SsrRouteMatch> => makeRouteMatch(url),
    render: async (_match, shell) => {
      if (shell._isr && revalidate !== undefined) {
        (shell._isr as IsrSink).revalidate = revalidate;
      }
      return new Response('<html>render</html>', {
        headers: { 'Content-Type': 'text/html; charset=utf-8' },
      });
    },
    renderChain: async (_chain, shell) => {
      if (shell._isr && revalidate !== undefined) {
        (shell._isr as IsrSink).revalidate = revalidate;
      }
      return new Response('<html>chain</html>', {
        headers: { 'Content-Type': 'text/html; charset=utf-8' },
      });
    },
  };
}

function buildApp(renderer: SlingshotSsrRenderer): Hono {
  const app = new Hono();
  attachContext(app, { app, pluginState: new Map() } as unknown as SlingshotContext);
  const isrAdapter = createMemoryIsrCache();
  const middleware = buildSsrMiddleware(
    {
      renderer,
      serverRoutesDir: '/fake/routes',
      assetsManifest: '/fake/manifest.json',
      devMode: true,
      isr: { adapter: isrAdapter },
    },
    null,
    app,
    isrAdapter,
  );
  app.use('*', middleware);
  app.get('*', c => c.text('SPA fallback'));
  return app;
}

describe('SSR Cache-Control — ISR revalidate hints public SWR directive', () => {
  it('emits public, s-maxage=N, stale-while-revalidate=N when loader returns revalidate', async () => {
    const app = buildApp(createIsrRenderer(60));
    const res = await app.request('/post');
    expect(res.status).toBe(200);
    const cc = res.headers.get('cache-control');
    expect(cc).toBe('public, s-maxage=60, stale-while-revalidate=60');
  });

  it('falls back to private, must-revalidate when no revalidate is set', async () => {
    const app = buildApp(createIsrRenderer(undefined));
    const res = await app.request('/static');
    const cc = res.headers.get('cache-control');
    expect(cc).toBe('private, must-revalidate');
  });

  it('does not override an explicit cacheControl.routes match', async () => {
    const app = new Hono();
    attachContext(app, { app, pluginState: new Map() } as unknown as SlingshotContext);
    const isrAdapter = createMemoryIsrCache();
    const middleware = buildSsrMiddleware(
      {
        renderer: createIsrRenderer(60),
        serverRoutesDir: '/fake/routes',
        assetsManifest: '/fake/manifest.json',
        devMode: true,
        isr: { adapter: isrAdapter },
        cacheControl: { routes: { '/override': 'public, max-age=10' } },
      },
      null,
      app,
      isrAdapter,
    );
    app.use('*', middleware);
    app.get('*', c => c.text('SPA fallback'));

    const res = await app.request('/override');
    expect(res.headers.get('cache-control')).toBe('public, max-age=10');
  });
});
