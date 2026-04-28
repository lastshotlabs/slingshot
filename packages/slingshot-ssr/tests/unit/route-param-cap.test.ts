// packages/slingshot-ssr/tests/unit/route-param-cap.test.ts
//
// Tests for the route-param byte-length cap.
//
// The resolver throws RouteParamTooLargeError when a decoded route param
// exceeds the configured `maxRouteParamBytes` cap (default 2048). The SSR
// middleware catches this and returns 414 URI Too Long before invoking the
// renderer.
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { Hono } from 'hono';
import { type SlingshotContext, attachContext } from '@lastshotlabs/slingshot-core';
import { buildSsrMiddleware } from '../../src/middleware';
import {
  DEFAULT_MAX_ROUTE_PARAM_BYTES,
  RouteParamTooLargeError,
  initRouteTree,
  invalidateRouteTree,
  resolveRoute,
} from '../../src/resolver';
import type { SlingshotSsrRenderer, SsrRouteMatch } from '../../src/types';

const TMP = join(import.meta.dir, '__tmp_param_cap__');

beforeAll(() => {
  rmSync(TMP, { recursive: true, force: true });
  mkdirSync(TMP, { recursive: true });
  writeFileSync(join(TMP, '[slug].ts'), 'export async function load() { return { data: {} } }');
  invalidateRouteTree(TMP);
  initRouteTree(TMP);
});

afterAll(() => {
  invalidateRouteTree(TMP);
  rmSync(TMP, { recursive: true, force: true });
});

// ─── resolver-level checks ────────────────────────────────────────────────────

describe('route param cap — resolveRoute throws when exceeded', () => {
  it('throws RouteParamTooLargeError when the decoded param exceeds the configured cap', () => {
    // Build a value that occupies exactly 2049 UTF-8 bytes (over the default cap)
    const oversized = 'a'.repeat(DEFAULT_MAX_ROUTE_PARAM_BYTES + 1);
    expect(() => resolveRoute(`/${oversized}`, TMP)).toThrow(RouteParamTooLargeError);
  });

  it('throws when the byte length exceeds an explicit lower cap (1KB)', () => {
    const value = 'a'.repeat(1025); // 1025 bytes, over 1024 cap
    expect(() => resolveRoute(`/${value}`, TMP, { maxRouteParamBytes: 1024 })).toThrow(
      RouteParamTooLargeError,
    );
  });

  it('does not throw when param is at or below the configured cap', () => {
    const value = 'a'.repeat(1024); // exactly at the cap
    const match = resolveRoute(`/${value}`, TMP, { maxRouteParamBytes: 1024 });
    expect(match).not.toBeNull();
    expect(match!.params.slug).toBe(value);
  });

  it('counts bytes, not chars: rejects multi-byte UTF-8 that exceeds the cap', () => {
    // '𠮷' is 4 bytes in UTF-8 — 600 of these is 2400 bytes (over 2048 cap)
    const value = '𠮷'.repeat(600);
    expect(() => resolveRoute(`/${encodeURIComponent(value)}`, TMP)).toThrow(
      RouteParamTooLargeError,
    );
  });
});

// ─── middleware integration: 414 response ─────────────────────────────────────

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

function buildAppForCap(maxRouteParamBytes?: number): {
  app: Hono;
  rendered: { count: number };
} {
  const rendered = { count: 0 };
  const renderer: SlingshotSsrRenderer = {
    resolve: async (url): Promise<SsrRouteMatch> => makeRouteMatch(url),
    render: async () => {
      rendered.count++;
      return new Response('<html><body>render</body></html>', {
        headers: { 'Content-Type': 'text/html; charset=utf-8' },
      });
    },
    renderChain: async () => {
      rendered.count++;
      return new Response('<html><body>render</body></html>', {
        headers: { 'Content-Type': 'text/html; charset=utf-8' },
      });
    },
  };

  const app = new Hono();
  attachContext(app, { app, pluginState: new Map() } as unknown as SlingshotContext);

  const middleware = buildSsrMiddleware(
    {
      renderer,
      serverRoutesDir: TMP,
      assetsManifest: '/fake/manifest.json',
      devMode: true,
      maxRouteParamBytes,
    },
    null,
    app,
  );

  app.use('*', middleware);
  app.get('*', c => c.text('SPA fallback'));
  return { app, rendered };
}

describe('route param cap — middleware returns 414 for oversize params', () => {
  it('returns 414 URI Too Long when param exceeds the default 2KB cap (4KB param)', async () => {
    const { app, rendered } = buildAppForCap();
    const oversized = 'a'.repeat(4096); // ~4KB, > 2KB default cap

    const res = await app.request(`/${oversized}`);
    expect(res.status).toBe(414);
    // Renderer must NOT be reached.
    expect(rendered.count).toBe(0);
  });

  it('passes through (200) when param is within cap (1KB param)', async () => {
    const { app, rendered } = buildAppForCap();
    const ok = 'a'.repeat(1024); // 1KB — well under default 2KB cap

    const res = await app.request(`/${ok}`);
    // Without a renderer.resolve fallback (file resolver matched), renderChain runs
    expect(res.status).toBe(200);
    expect(rendered.count).toBe(1);
  });

  it('honors custom maxRouteParamBytes config — 1KB param exceeds 512-byte cap', async () => {
    const { app, rendered } = buildAppForCap(512);
    const value = 'a'.repeat(1024); // > 512 cap

    const res = await app.request(`/${value}`);
    expect(res.status).toBe(414);
    expect(rendered.count).toBe(0);
  });
});
