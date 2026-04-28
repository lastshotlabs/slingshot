// packages/slingshot-ssr/tests/unit/etag-304.test.ts
//
// Tests for ETag / 304 Not Modified handling in the SSR middleware.
//
// On a successful render, the middleware:
// - Computes a strong ETag from the response body
// - Sets the ETag response header
// - Returns 304 Not Modified when If-None-Match matches the computed ETag
// - Defaults Cache-Control to 'private, must-revalidate' for non-draft, 2xx routes
import { describe, expect, it } from 'bun:test';
import { Hono } from 'hono';
import { type SlingshotContext, attachContext } from '@lastshotlabs/slingshot-core';
import { buildSsrMiddleware } from '../../src/middleware';
import type { SlingshotSsrRenderer, SsrRouteMatch } from '../../src/types';

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

function createRenderer(html: string, status = 200): SlingshotSsrRenderer {
  return {
    resolve: async (url): Promise<SsrRouteMatch> => makeRouteMatch(url),
    render: async () =>
      new Response(html, {
        status,
        headers: { 'Content-Type': 'text/html; charset=utf-8' },
      }),
    renderChain: async () =>
      new Response(html, {
        status,
        headers: { 'Content-Type': 'text/html; charset=utf-8' },
      }),
  };
}

function buildApp(renderer: SlingshotSsrRenderer): Hono {
  const app = new Hono();
  attachContext(app, { app, pluginState: new Map() } as unknown as SlingshotContext);

  const middleware = buildSsrMiddleware(
    {
      renderer,
      serverRoutesDir: '/fake/routes',
      assetsManifest: '/fake/manifest.json',
      devMode: true,
    },
    null,
    app,
  );

  app.use('*', middleware);
  app.get('*', c => c.text('SPA fallback'));
  return app;
}

describe('ETag / 304 — first request', () => {
  it('returns 200 with an ETag header on a successful render', async () => {
    const app = buildApp(createRenderer('<html><body>hello</body></html>'));

    const res = await app.request('/page');
    expect(res.status).toBe(200);
    const etag = res.headers.get('ETag');
    expect(etag).not.toBeNull();
    expect(etag).toMatch(/^"[A-Za-z0-9_-]{27}"$/);
  });

  it('returns 200 body content unchanged when no If-None-Match is sent', async () => {
    const app = buildApp(createRenderer('<html><body>hello</body></html>'));

    const res = await app.request('/page');
    expect(await res.text()).toBe('<html><body>hello</body></html>');
  });

  it('uses the default Cache-Control of private, must-revalidate for successful renders', async () => {
    const app = buildApp(createRenderer('<html><body>hello</body></html>'));

    const res = await app.request('/page');
    expect(res.headers.get('Cache-Control')).toBe('private, must-revalidate');
  });
});

describe('ETag / 304 — second request with If-None-Match', () => {
  it('returns 304 Not Modified with the same ETag header and an empty body', async () => {
    const app = buildApp(createRenderer('<html><body>cached</body></html>'));

    const first = await app.request('/page');
    const etag = first.headers.get('ETag');
    expect(etag).not.toBeNull();

    const second = await app.request('/page', {
      headers: { 'If-None-Match': etag! },
    });

    expect(second.status).toBe(304);
    expect(second.headers.get('ETag')).toBe(etag);
    expect(await second.text()).toBe('');
  });

  it('returns 200 with a fresh body when the If-None-Match header does not match', async () => {
    const app = buildApp(createRenderer('<html><body>cached</body></html>'));

    const res = await app.request('/page', {
      headers: { 'If-None-Match': '"not-a-real-etag-value-for-this-page"' },
    });

    expect(res.status).toBe(200);
    expect(await res.text()).toBe('<html><body>cached</body></html>');
  });

  it('produces stable ETags for identical bodies across requests', async () => {
    const app = buildApp(createRenderer('<html><body>stable</body></html>'));

    const a = await app.request('/page');
    const b = await app.request('/page');
    expect(a.headers.get('ETag')).toBe(b.headers.get('ETag'));
  });
});

describe('ETag / 304 — eligibility', () => {
  it('does not set an ETag when the renderer already supplied one', async () => {
    const renderer: SlingshotSsrRenderer = {
      resolve: async (url): Promise<SsrRouteMatch> => makeRouteMatch(url),
      render: async () =>
        new Response('<html><body>renderer-etag</body></html>', {
          headers: {
            'Content-Type': 'text/html; charset=utf-8',
            ETag: '"renderer-supplied-etag"',
          },
        }),
      renderChain: async () =>
        new Response('<html><body>renderer-etag</body></html>', {
          headers: {
            'Content-Type': 'text/html; charset=utf-8',
            ETag: '"renderer-supplied-etag"',
          },
        }),
    };
    const app = buildApp(renderer);

    const res = await app.request('/page');
    expect(res.headers.get('ETag')).toBe('"renderer-supplied-etag"');
  });
});
