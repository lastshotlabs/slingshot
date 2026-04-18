import { describe, expect, it, mock } from 'bun:test';
import { Hono } from 'hono';
import { createMemoryIsrCache } from '../../../src/isr/memory';
import type { IsrCacheAdapter, IsrCacheEntry } from '../../../src/isr/types';
import { buildSsrMiddleware } from '../../../src/middleware';
import type {
  IsrSink,
  SlingshotSsrRenderer,
  SsrRouteChain,
  SsrRouteMatch,
} from '../../../src/types';

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

// ── Helpers ────────────────────────────────────────────────────────────────────

/**
 * Build a minimal mock renderer that populates the ISR sink after "calling load()".
 *
 * The `isrSink` field on `SsrShell._isr` is a mutable object — the renderer
 * writes to it so the middleware can read revalidate/tags after render() returns.
 */
function createIsrAwareRenderer(
  opts: {
    revalidate?: number;
    tags?: string[];
    html?: string;
  } = {},
): SlingshotSsrRenderer {
  const html = opts.html ?? '<html><body>rendered</body></html>';

  return {
    resolve: async (url): Promise<SsrRouteMatch> => makeRouteMatch(url),

    render: async (_match, shell) => {
      // Simulate the renderer populating the ISR sink after calling load()
      if (shell._isr && opts.revalidate !== undefined) {
        (shell._isr as IsrSink).revalidate = opts.revalidate;
        (shell._isr as IsrSink).tags = opts.tags ?? [];
      }

      return new Response(html, {
        headers: { 'Content-Type': 'text/html; charset=utf-8' },
      });
    },
    renderChain: async (chain: SsrRouteChain, shell) =>
      new Response(
        `<html><body>rendered chain:${chain.page.url.pathname}</body></html>${shell.assetTags}`,
        {
          headers: { 'Content-Type': 'text/html; charset=utf-8' },
        },
      ),
  };
}

/**
 * Build a Hono test app with a middleware that has a real ISR adapter but
 * uses a mock `getContext` skip. Since middleware tests run without a real
 * SlingshotContext, we use the pattern from existing tests (the middleware
 * catches getContext() throws and calls next()).
 *
 * For ISR tests that need `bsCtx`, we attach a fake context to the app.
 */
function buildIsrTestApp(renderer: SlingshotSsrRenderer, isrAdapter: IsrCacheAdapter) {
  const app = new Hono();

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

// ── Cache hit/miss ─────────────────────────────────────────────────────────────

describe('ISR middleware — cache miss falls through to renderer', () => {
  it('on a cache miss, the middleware falls through (to fallback in this test)', async () => {
    const isrAdapter = createMemoryIsrCache();
    const renderer = createIsrAwareRenderer({ revalidate: 60, html: '<html>fresh</html>' });
    const app = buildIsrTestApp(renderer, isrAdapter);

    // No context attached, so getContext throws → middleware calls next() → fallback
    const res = await app.request('/posts');
    expect(res.status).toBe(200);
    // Falls through to SPA fallback because getContext() throws in test env
    expect(await res.text()).toBe('SPA fallback');
  });
});

describe('ISR middleware — cache hit serves cached entry', () => {
  it('serves the cached HTML directly when a non-stale entry exists', async () => {
    const isrAdapter = createMemoryIsrCache();

    const now = Date.now();
    const cachedEntry: IsrCacheEntry = {
      html: '<html><body>from-cache</body></html>',
      headers: { 'content-type': 'text/html; charset=utf-8' },
      generatedAt: now - 10_000,
      revalidateAfter: now + 50_000, // not stale
      tags: ['posts'],
    };

    // Pre-populate the cache
    await isrAdapter.set('/posts', cachedEntry);

    const renderer = createIsrAwareRenderer({ revalidate: 60 });
    const app = buildIsrTestApp(renderer, isrAdapter);

    const res = await app.request('/posts');
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('<html><body>from-cache</body></html>');
    expect(res.headers.get('x-isr-cache')).toBe('hit');
  });

  it('includes original headers from the cached entry', async () => {
    const isrAdapter = createMemoryIsrCache();

    const now = Date.now();
    await isrAdapter.set('/page', {
      html: '<html>page</html>',
      headers: {
        'content-type': 'text/html; charset=utf-8',
        'x-custom': 'from-renderer',
      },
      generatedAt: now,
      revalidateAfter: now + 60_000,
      tags: [],
    });

    const renderer = createIsrAwareRenderer();
    const app = buildIsrTestApp(renderer, isrAdapter);

    const res = await app.request('/page');
    expect(res.headers.get('x-custom')).toBe('from-renderer');
  });
});

describe('ISR middleware — stale entry serves immediately and marks as stale', () => {
  it('serves stale content with x-isr-cache: stale header', async () => {
    const isrAdapter = createMemoryIsrCache();

    const now = Date.now();
    const staleEntry: IsrCacheEntry = {
      html: '<html><body>stale-content</body></html>',
      headers: { 'content-type': 'text/html; charset=utf-8' },
      generatedAt: now - 120_000,
      revalidateAfter: now - 60_000, // stale — revalidateAfter is in the past
      tags: [],
    };

    await isrAdapter.set('/stale-page', staleEntry);

    const renderer = createIsrAwareRenderer({ revalidate: 60 });
    const app = buildIsrTestApp(renderer, isrAdapter);

    const res = await app.request('/stale-page');
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('<html><body>stale-content</body></html>');
    expect(res.headers.get('x-isr-cache')).toBe('stale');
  });
});

describe('ISR middleware — excluded paths bypass cache entirely', () => {
  it('does not check the ISR cache for /api/ paths', async () => {
    const isrAdapter = createMemoryIsrCache();
    const getSpy = mock(isrAdapter.get.bind(isrAdapter));
    isrAdapter.get = getSpy;

    const renderer = createIsrAwareRenderer();
    const app = buildIsrTestApp(renderer, isrAdapter);

    await app.request('/api/posts');
    expect(getSpy).not.toHaveBeenCalled();
  });

  it('does not check the ISR cache for /_slingshot/ paths', async () => {
    const isrAdapter = createMemoryIsrCache();
    const getSpy = mock(isrAdapter.get.bind(isrAdapter));
    isrAdapter.get = getSpy;

    const renderer = createIsrAwareRenderer();
    const app = buildIsrTestApp(renderer, isrAdapter);

    await app.request('/_slingshot/health');
    expect(getSpy).not.toHaveBeenCalled();
  });

  it('does not check the ISR cache for POST requests', async () => {
    const isrAdapter = createMemoryIsrCache();
    const getSpy = mock(isrAdapter.get.bind(isrAdapter));
    isrAdapter.get = getSpy;

    const renderer = createIsrAwareRenderer();
    const app = buildIsrTestApp(renderer, isrAdapter);

    await app.request('/posts', { method: 'POST' });
    expect(getSpy).not.toHaveBeenCalled();
  });
});

describe('ISR middleware — no isr config means no caching', () => {
  it('does not call any cache adapter when isr is not configured', async () => {
    const isrAdapter = createMemoryIsrCache();
    const getSpy = mock(isrAdapter.get.bind(isrAdapter));
    isrAdapter.get = getSpy;

    const app = new Hono();
    const middleware = buildSsrMiddleware(
      {
        renderer: createIsrAwareRenderer({ revalidate: 60 }),
        serverRoutesDir: '/fake/routes',
        assetsManifest: '/fake/manifest.json',
        devMode: true,
        // isr intentionally omitted
      },
      null,
      app,
    );

    app.use('*', middleware);
    app.get('*', c => c.text('fallback'));

    await app.request('/posts');

    // adapter.get should never be called when isr is not configured
    expect(getSpy).not.toHaveBeenCalled();
  });
});

describe('ISR — createIsrInvalidators integration', () => {
  it('revalidatePath removes the correct entry', async () => {
    const cache = createMemoryIsrCache();

    const now = Date.now();
    await cache.set('/posts', {
      html: '<html>posts</html>',
      headers: {},
      generatedAt: now,
      revalidateAfter: now + 60_000,
      tags: ['posts'],
    });

    await cache.invalidatePath('/posts');

    expect(await cache.get('/posts')).toBeNull();
  });

  it('revalidateTag removes all tagged entries', async () => {
    const cache = createMemoryIsrCache();
    const now = Date.now();

    await cache.set('/posts', {
      html: '<html>posts</html>',
      headers: {},
      generatedAt: now,
      revalidateAfter: now + 60_000,
      tags: ['posts'],
    });

    await cache.set('/posts/1', {
      html: '<html>post 1</html>',
      headers: {},
      generatedAt: now,
      revalidateAfter: now + 60_000,
      tags: ['posts', 'post:1'],
    });

    await cache.invalidateTag('posts');

    expect(await cache.get('/posts')).toBeNull();
    expect(await cache.get('/posts/1')).toBeNull();
  });
});
