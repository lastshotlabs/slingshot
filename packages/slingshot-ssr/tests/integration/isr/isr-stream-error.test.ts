// Integration test for P-SSR-2: stream errors during pipeTo are routed
// through the structured Logger and the optional onStreamError callback so
// apps can wire metrics/circuit breakers without scraping stderr.
import { describe, expect, it } from 'bun:test';
import { Hono } from 'hono';
import { type Logger, type SlingshotContext, attachContext } from '@lastshotlabs/slingshot-core';
import { buildSsrMiddleware } from '../../../src/middleware';
import type { SlingshotSsrRenderer, SsrRouteMatch } from '../../../src/types';

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

describe('SSR response stream error reporting (P-SSR-2)', () => {
  it('routes pipeTo errors through Logger.error and onStreamError callback', async () => {
    const errors: { msg: string; fields: Record<string, unknown> | undefined }[] = [];
    const logger: Logger = {
      debug() {},
      info() {},
      warn() {},
      error(msg, fields) {
        errors.push({ msg, fields });
      },
      child() {
        return logger;
      },
    };

    const onStreamErrorCalls: Array<{
      message: string;
      route: string;
      requestId: string | undefined;
    }> = [];

    const renderer: SlingshotSsrRenderer = {
      resolve: async url => makeRouteMatch(url),
      render: async () => {
        // Stream emits a chunk, then errors mid-flight so pipeTo() rejects.
        // We pre-set ETag so the middleware's etag block does not consume
        // the body before pipeTo runs.
        const body = new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('<html>'));
          },
          pull(controller) {
            controller.error(new Error('upstream stream blew up'));
          },
        });
        return new Response(body, {
          headers: {
            'content-type': 'text/html; charset=utf-8',
            ETag: '"pre-set-etag"',
          },
        });
      },
      renderChain: async chain => {
        const body = new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('<html>'));
          },
          pull(controller) {
            controller.error(new Error(`upstream stream blew up: ${chain.page.url.pathname}`));
          },
        });
        return new Response(body, {
          headers: {
            'content-type': 'text/html; charset=utf-8',
            ETag: '"pre-set-etag"',
          },
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
        logger,
        onStreamError: info => {
          onStreamErrorCalls.push({
            message: info.error.message,
            route: info.route,
            requestId: info.requestId,
          });
        },
      },
      null,
      app,
    );
    app.use('*', middleware);
    app.get('*', c => c.text('SPA fallback'));

    const res = await app.request('/some/route', {
      headers: { 'x-request-id': 'req-123' },
    });
    // Drain the body — this triggers the pipeTo() pipeline whose source errors.
    try {
      await res.text();
    } catch {
      // Reading from an errored stream may throw; that is fine for this test.
    }

    // Allow the catch handler in pipeTo() to run.
    await new Promise(resolve => setTimeout(resolve, 50));

    const streamErr = errors.find(e => e.msg === 'response.stream.error');
    expect(streamErr).toBeDefined();
    expect(streamErr?.fields?.route).toBe('/some/route');
    expect(streamErr?.fields?.requestId).toBe('req-123');
    expect(String(streamErr?.fields?.error)).toContain('upstream stream blew up');

    expect(onStreamErrorCalls).toHaveLength(1);
    expect(onStreamErrorCalls[0].route).toBe('/some/route');
    expect(onStreamErrorCalls[0].requestId).toBe('req-123');
  });
});
