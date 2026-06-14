// Integration tests for the SSR middleware's JSON-mode response branch.
//
// Background: a request with `?_data=1` (or `Accept: application/json`) to a
// public SSR URL should run the route's loader and return its result as JSON
// instead of rendering HTML. This is the protocol that powers TanStack-style
// soft client-side navigation: the same URL doubles as a JSON endpoint when
// asked for JSON. Two paths under test:
//
//   1. Matched route + JSON-mode signal → run loader, return JSON
//   2. Unmatched route + JSON-mode signal → return structured 404 JSON
//      (NOT fall through to SPA fallback — that would yield empty body /
//      HTML for paths the dev-server proxy doesn't recognise)
//
// Plus: verify that the `_data` protocol parameter is stripped from
// `ctx.query` before the loader sees it (so it doesn't pollute filter
// queries the loader passes through to entity adapters).
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'bun:test';
import { Hono } from 'hono';
import { type SlingshotContext, attachContext } from '@lastshotlabs/slingshot-core';
import { buildSsrMiddleware } from '../../src/middleware';
import { initRouteTree, invalidateRouteTree } from '../../src/resolver';
import type { SlingshotSsrRenderer } from '../../src/types';

const TMP = join(import.meta.dir, '__tmp_middleware_json_mode__');

function setupRoutes(files: Record<string, string>): string {
  if (existsSync(TMP)) rmSync(TMP, { recursive: true });
  const routesDir = join(TMP, 'routes');
  mkdirSync(routesDir, { recursive: true });
  for (const [rel, content] of Object.entries(files)) {
    const full = join(routesDir, rel);
    mkdirSync(join(full, '..'), { recursive: true });
    writeFileSync(full, content, 'utf8');
  }
  // initRouteTree caches by directory path. Tests reuse the same TMP dir, so
  // invalidate first to force a re-scan with whatever files this test wrote.
  invalidateRouteTree(routesDir);
  initRouteTree(routesDir);
  return routesDir;
}

function cleanupRoutes(routesDir?: string): void {
  if (routesDir) invalidateRouteTree(routesDir);
  if (existsSync(TMP)) rmSync(TMP, { recursive: true });
}

function makeRenderer(): SlingshotSsrRenderer {
  return {
    resolve: async () => null,
    render: async () =>
      new Response('<html>render-should-not-be-called</html>', {
        headers: { 'content-type': 'text/html; charset=utf-8' },
      }),
    renderChain: async () =>
      new Response('<html>render-should-not-be-called</html>', {
        headers: { 'content-type': 'text/html; charset=utf-8' },
      }),
  };
}

function buildApp(routesDir: string): Hono {
  const app = new Hono();
  attachContext(app, {
    app,
    pluginState: new Map(),
    auth: {
      getUser: async () => null,
    },
  } as unknown as SlingshotContext);

  app.use(
    '*',
    buildSsrMiddleware(
      {
        renderer: makeRenderer(),
        serverRoutesDir: routesDir,
        assetsManifest: '/fake/manifest.json',
        devMode: true,
      },
      null,
      app,
    ),
  );
  // Concrete fallback so unmatched HTML requests don't 404 from Hono itself.
  app.get('*', c => c.text('SPA fallback'));
  return app;
}

describe('SSR middleware — JSON mode', () => {
  let routesDir: string | undefined;

  afterAll(() => cleanupRoutes(routesDir));

  it('returns structured 404 JSON when no route matches and ?_data=1 is set', async () => {
    routesDir = setupRoutes({
      // Define a real route so the route source initialises non-empty,
      // but request a path that doesn't match it.
      'home/page.ts': 'export async function load() { return { data: { ok: true } }; }',
    });
    const app = buildApp(routesDir);

    const res = await app.request('/does-not-exist?_data=1');

    expect(res.status).toBe(404);
    expect(res.headers.get('content-type')).toContain('application/json');
    const body = (await res.json()) as Record<string, unknown>;
    expect(body['notFound']).toBe(true);
    expect(body['reason']).toBe('no_ssr_route_matched');
    expect(body['pathname']).toBe('/does-not-exist');
  });

  it('returns structured 404 JSON when no route matches and Accept: application/json is set', async () => {
    routesDir = setupRoutes({
      'home/page.ts': 'export async function load() { return { data: { ok: true } }; }',
    });
    const app = buildApp(routesDir);

    const res = await app.request('/missing', {
      headers: { accept: 'application/json' },
    });

    expect(res.status).toBe(404);
    expect(res.headers.get('content-type')).toContain('application/json');
    const body = (await res.json()) as Record<string, unknown>;
    expect(body['notFound']).toBe(true);
    expect(body['reason']).toBe('no_ssr_route_matched');
  });

  it('falls through to SPA fallback (no JSON 404) when no route matches and Accept is text/html', async () => {
    routesDir = setupRoutes({
      'home/page.ts': 'export async function load() { return { data: { ok: true } }; }',
    });
    const app = buildApp(routesDir);

    const res = await app.request('/missing', {
      headers: { accept: 'text/html,*/*' },
    });

    // The middleware does NOT short-circuit for HTML — it falls through to
    // the next handler (the SPA fallback in this test app).
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('SPA fallback');
  });

  it('runs loader and returns its data as JSON when a route matches and ?_data=1 is set', async () => {
    routesDir = setupRoutes({
      'echo/page.ts': `
        export async function load(ctx) {
          return {
            data: { pathname: ctx.url.pathname, query: ctx.query },
            tags: ['echo'],
          };
        }
      `,
    });
    const app = buildApp(routesDir);

    const res = await app.request('/echo?foo=bar&_data=1');

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/json');
    const body = (await res.json()) as Record<string, unknown>;
    const data = body['data'] as Record<string, unknown>;
    expect(data['pathname']).toBe('/echo');
    // Loader should NOT see the `_data` protocol marker — it must be stripped
    // before reaching the load function so callers can pass `ctx.query` to
    // entity-adapter filters without `_data` polluting the result.
    expect(data['query']).toEqual({ foo: 'bar' });
    expect(body['tags']).toEqual(['echo']);
  });

  it('strips _data marker from ctx.query even when it is the only param', async () => {
    routesDir = setupRoutes({
      'echo/page.ts': `
        export async function load(ctx) {
          return { data: { query: ctx.query } };
        }
      `,
    });
    const app = buildApp(routesDir);

    const res = await app.request('/echo?_data=1');

    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { query: Record<string, string> } };
    expect(body.data.query).toEqual({});
  });

  it('maps loader notFound signal to 404 JSON', async () => {
    routesDir = setupRoutes({
      'gone/page.ts': `
        export async function load() {
          return { notFound: true };
        }
      `,
    });
    const app = buildApp(routesDir);

    const res = await app.request('/gone?_data=1');

    expect(res.status).toBe(404);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body['notFound']).toBe(true);
  });

  it('maps loader forbidden signal to 403 JSON', async () => {
    routesDir = setupRoutes({
      'private/page.ts': `
        export async function load() {
          return { forbidden: true };
        }
      `,
    });
    const app = buildApp(routesDir);

    const res = await app.request('/private?_data=1');

    expect(res.status).toBe(403);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body['forbidden']).toBe(true);
  });

  it('maps loader unauthorized signal to 401 JSON', async () => {
    routesDir = setupRoutes({
      'auth/page.ts': `
        export async function load() {
          return { unauthorized: true };
        }
      `,
    });
    const app = buildApp(routesDir);

    const res = await app.request('/auth?_data=1');

    expect(res.status).toBe(401);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body['unauthorized']).toBe(true);
  });

  it('maps loader redirect signal to 200 JSON with redirect field (not an HTTP redirect)', async () => {
    routesDir = setupRoutes({
      'go/page.ts': `
        export async function load() {
          return { redirect: '/elsewhere', status: 307 };
        }
      `,
    });
    const app = buildApp(routesDir);

    const res = await app.request('/go?_data=1');

    // JSON-mode redirects come back as a 200 envelope so the client (typically
    // a TanStack loader) can decide whether to navigate, not the browser.
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body['redirect']).toBe('/elsewhere');
    expect(body['status']).toBe(307);
  });
});
