// Integration test for P-SSR-1: the SSR middleware caps concurrent in-flight
// background regenerations per cache instance via the shared IsrTracker.
// When the cap is reached, additional regen requests are dropped (logged via
// Logger.warn) and the served stale response is unaffected.
import { describe, expect, it } from 'bun:test';
import { Hono } from 'hono';
import { type Logger, type SlingshotContext, attachContext } from '@lastshotlabs/slingshot-core';
import { createMemoryIsrCache } from '../../../src/isr/memory';
import { buildSsrMiddleware, createIsrTracker } from '../../../src/middleware';
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

function captureLogger(): {
  logger: Logger;
  warns: { msg: string; fields: Record<string, unknown> | undefined }[];
} {
  const warns: { msg: string; fields: Record<string, unknown> | undefined }[] = [];
  const logger: Logger = {
    debug() {},
    info() {},
    warn(msg, fields) {
      warns.push({ msg, fields });
    },
    error() {},
    child() {
      return logger;
    },
  };
  return { logger, warns };
}

describe('ISR background regen concurrency cap (P-SSR-1)', () => {
  it('drops the 33rd concurrent regen request when maxConcurrentRegenerations=32', async () => {
    const adapter = createMemoryIsrCache();
    const now = Date.now();
    // Seed 33 distinct stale entries.
    for (let i = 0; i < 33; i += 1) {
      await adapter.set(`/page-${i}`, {
        html: `<html>stale-${i}</html>`,
        headers: { 'content-type': 'text/html; charset=utf-8' },
        generatedAt: now - 120_000,
        revalidateAfter: now - 60_000,
        tags: [],
      });
    }

    let inFlightRender = 0;
    let peakInFlight = 0;
    let resolveBatch: (() => void) | null = null;
    const allHeld = new Promise<void>(resolve => {
      resolveBatch = resolve;
    });

    // Renderer holds every render until released — guarantees all granted
    // regens are simultaneously in-flight when the 33rd request arrives.
    const renderer: SlingshotSsrRenderer = {
      resolve: async url => makeRouteMatch(url),
      render: async (_match, shell) => {
        inFlightRender += 1;
        peakInFlight = Math.max(peakInFlight, inFlightRender);
        await allHeld;
        if (shell._isr) (shell._isr as IsrSink).revalidate = 60;
        inFlightRender -= 1;
        return new Response('<html>fresh</html>', {
          headers: { 'content-type': 'text/html; charset=utf-8' },
        });
      },
      renderChain: async (chain, shell) => {
        inFlightRender += 1;
        peakInFlight = Math.max(peakInFlight, inFlightRender);
        await allHeld;
        if (shell._isr) (shell._isr as IsrSink).revalidate = 60;
        inFlightRender -= 1;
        return new Response(`<html>fresh:${chain.page.url.pathname}</html>`, {
          headers: { 'content-type': 'text/html; charset=utf-8' },
        });
      },
    };

    const app = new Hono();
    attachContext(app, { app, pluginState: new Map() } as unknown as SlingshotContext);

    const tracker = createIsrTracker(32);
    const { logger, warns } = captureLogger();

    const middleware = buildSsrMiddleware(
      {
        renderer,
        serverRoutesDir: '/fake/routes',
        assetsManifest: '/fake/manifest.json',
        devMode: true,
        isr: { adapter, maxConcurrentRegenerations: 32, backgroundRegenTimeoutMs: 30_000 },
        logger,
      },
      null,
      app,
      adapter,
      tracker,
    );
    app.use('*', middleware);
    app.get('*', c => c.text('SPA fallback'));

    // Fire all 33 requests in flight. Each returns the stale entry immediately
    // and detaches a regen task — the 33rd should be dropped at the cap.
    const responses = await Promise.all(
      Array.from({ length: 33 }, (_, i) => app.request(`/page-${i}`)),
    );
    expect(responses.every(r => r.status === 200)).toBe(true);

    // Yield so detached regen tasks reach their hold point.
    await new Promise(resolve => setTimeout(resolve, 50));

    // Exactly 32 regens are in flight; the 33rd was dropped.
    expect(peakInFlight).toBe(32);
    expect(tracker.getDroppedCount()).toBe(1);

    // Drop was logged as a structured warn record.
    const dropWarn = warns.find(w => w.msg === 'isr.regen.dropped');
    expect(dropWarn).toBeDefined();
    expect(dropWarn?.fields?.reason).toBe('maxConcurrentRegenerations');

    // Release renderers so the test can drain cleanly.
    if (resolveBatch !== null) (resolveBatch as () => void)();
    await new Promise(resolve => setTimeout(resolve, 100));
  });
});
