// Tests for the ISR background regeneration AbortSignal plumbing.
//
// When `backgroundRegenTimeoutMs` elapses, the controller fires `abort()`.
// `regeneratePage()` must observe the signal at every async boundary so that
// the render unwinds without writing a stale entry back to the cache.
import { describe, expect, it } from 'bun:test';
import { Hono } from 'hono';
import { type SlingshotContext, attachContext } from '@lastshotlabs/slingshot-core';
import { createMemoryIsrCache } from '../../../src/isr/memory';
import type { IsrCacheEntry } from '../../../src/isr/types';
import { buildSsrMiddleware } from '../../../src/middleware';
import type { IsrSink, SlingshotSsrRenderer, SsrRouteMatch } from '../../../src/types';

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

/** Wait one macrotask so detached promises can run. */
function flushMacrotasks(ms = 50): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

describe('ISR background regen — AbortSignal propagation', () => {
  it('aborts a slow render when the timeout fires and never writes to the cache', async () => {
    const isrAdapter = createMemoryIsrCache();
    let setCalls = 0;
    const originalSet = isrAdapter.set.bind(isrAdapter);
    isrAdapter.set = async (key: string, entry: IsrCacheEntry) => {
      setCalls++;
      return originalSet(key, entry);
    };

    // Pre-populate with a stale entry so background regen kicks in.
    const now = Date.now();
    await isrAdapter.set('/slow', {
      html: '<html>stale</html>',
      headers: { 'content-type': 'text/html; charset=utf-8' },
      generatedAt: now - 120_000,
      revalidateAfter: now - 60_000,
      tags: [],
    });
    setCalls = 0; // reset after seeding

    let renderStarted = false;
    let renderCompleted = false;

    const renderer: SlingshotSsrRenderer = {
      resolve: async (url): Promise<SsrRouteMatch> => makeRouteMatch(url),
      render: async (_match, shell) => {
        renderStarted = true;
        // Hold the renderer past the configured timeout.
        await new Promise(resolve => setTimeout(resolve, 200));
        if (shell._isr) (shell._isr as IsrSink).revalidate = 60;
        renderCompleted = true;
        return new Response('<html>fresh</html>', {
          headers: { 'content-type': 'text/html; charset=utf-8' },
        });
      },
      renderChain: async (chain, shell) => {
        renderStarted = true;
        await new Promise(resolve => setTimeout(resolve, 200));
        if (shell._isr) (shell._isr as IsrSink).revalidate = 60;
        renderCompleted = true;
        return new Response(`<html>fresh:${chain.page.url.pathname}</html>`, {
          headers: { 'content-type': 'text/html; charset=utf-8' },
        });
      },
    };

    const app = new Hono();
    attachContext(app, { app, pluginState: new Map() } as unknown as SlingshotContext);

    const middleware = buildSsrMiddleware(
      {
        renderer,
        serverRoutesDir: '/fake/routes',
        assetsManifest: '/fake/manifest.json',
        devMode: true,
        // Timeout fires well before the slow render completes.
        isr: { adapter: isrAdapter, backgroundRegenTimeoutMs: 25 },
      },
      null,
      app,
      isrAdapter,
    );
    app.use('*', middleware);
    app.get('*', c => c.text('SPA fallback'));

    // Request returns the stale entry immediately.
    const res = await app.request('/slow');
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('<html>stale</html>');
    expect(res.headers.get('x-isr-cache')).toBe('stale');

    // Wait for the timeout to fire and the regen to unwind.
    await flushMacrotasks(300);

    // Regen started but the abort short-circuited the render before it wrote to cache.
    // The cache must still contain the original stale entry, untouched.
    expect(renderStarted).toBe(true);
    // Even if the renderer's promise eventually resolves, the post-render
    // `signal?.throwIfAborted()` checks must prevent the cache write.
    expect(setCalls).toBe(0);

    // Sanity: the cached entry is unchanged.
    const stillCached = await isrAdapter.get('/slow');
    expect(stillCached?.html).toBe('<html>stale</html>');

    // Suppress unused-variable lint when the renderer happens to finish racing.
    void renderCompleted;
  });
});
