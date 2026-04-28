import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it, mock } from 'bun:test';
import { Hono } from 'hono';
import { type SlingshotContext, attachContext } from '@lastshotlabs/slingshot-core';
import { buildSsrMiddleware } from '../../src/middleware';
import { initRouteTree, invalidateRouteTree } from '../../src/resolver';
import type { SlingshotSsrRenderer, SsrRouteChain } from '../../src/types';

const TMP = join(import.meta.dir, '__tmp_middleware_runtime__');

function setupRoutes(files: Record<string, string>): string {
  if (existsSync(TMP)) rmSync(TMP, { recursive: true });
  const serverDir = join(TMP, 'server');
  const routesDir = join(serverDir, 'routes');
  mkdirSync(routesDir, { recursive: true });

  for (const [rel, content] of Object.entries(files)) {
    const full = rel.startsWith('server/') ? join(TMP, rel) : join(routesDir, rel);
    mkdirSync(join(full, '..'), { recursive: true });
    writeFileSync(full, content, 'utf8');
  }

  initRouteTree(routesDir);
  return routesDir;
}

function cleanupRoutes(routesDir?: string): void {
  if (routesDir) {
    invalidateRouteTree(routesDir);
  }
  if (existsSync(TMP)) rmSync(TMP, { recursive: true });
}

function makeRenderer(
  renderChain?: (chain: SsrRouteChain) => Response | Promise<Response>,
): SlingshotSsrRenderer {
  return {
    resolve: async () => null,
    render: async () => new Response('<html>render</html>'),
    renderChain: async chain =>
      renderChain?.(chain) ??
      new Response(`<html>${chain.page.url.pathname}?${chain.page.url.searchParams}</html>`, {
        headers: { 'content-type': 'text/html; charset=utf-8' },
      }),
  };
}

function buildApp(
  renderer: SlingshotSsrRenderer,
  routesDir: string,
  options: {
    authUserId?: string;
  } = {},
): Hono {
  const app = new Hono();
  attachContext(app, {
    app,
    pluginState: new Map(),
    auth: {
      getUser: async () =>
        options.authUserId ? { id: options.authUserId, roles: ['reader'] } : null,
    },
  } as unknown as SlingshotContext);

  app.use(
    '*',
    buildSsrMiddleware(
      {
        renderer,
        serverRoutesDir: routesDir,
        assetsManifest: '/fake/manifest.json',
        devMode: true,
      },
      null,
      app,
    ),
  );
  app.get('*', c => c.text('fallback'));
  return app;
}

describe('SSR middleware runtime request paths', () => {
  let routesDir: string | undefined;

  afterAll(() => cleanupRoutes(routesDir));

  it('serves static HTML through the configured runtime before resolving SSR context', async () => {
    const readFile = mock(async (filePath: string) =>
      filePath.endsWith('/docs/index.html') ? '<html>static docs</html>' : null,
    );
    const renderer = makeRenderer(() => {
      throw new Error('renderer should not run for static hit');
    });
    const app = new Hono();

    app.use(
      '*',
      buildSsrMiddleware(
        {
          renderer,
          serverRoutesDir: '/fake/routes',
          assetsManifest: '/fake/manifest.json',
          devMode: true,
          staticDir: '/var/www/static',
          runtime: { readFile } as never,
        },
        null,
        app,
      ),
    );
    app.get('*', c => c.text('fallback'));

    const res = await app.request('/docs');

    expect(res.status).toBe(200);
    expect(await res.text()).toBe('<html>static docs</html>');
    expect(res.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
    expect(readFile).toHaveBeenCalledWith('/var/www/static/docs/index.html');
  });

  it('executes route and global middleware redirects, headers, rewrites, and auth lookup', async () => {
    routesDir = setupRoutes({
      'headers/page.ts': 'export async function load() { return { data: {} }; }',
      'rewritten/page.ts': 'export async function load() { return { data: {} }; }',
      'server/middleware.ts': `
        export async function middleware(ctx) {
          if (ctx.pathname === '/redirect') {
            return { redirect: '/login', status: 307 };
          }
          if (ctx.pathname === '/rewrite-me') {
            const user = await ctx.getUser();
            return {
              rewrite: '/rewritten?via=middleware',
              headers: { 'x-global-user': user?.id ?? 'anonymous' },
            };
          }
          if (ctx.pathname === '/headers') {
            return { headers: { 'x-route-middleware': 'applied' } };
          }
          return {};
        }
      `,
    });

    const rendered: string[] = [];
    const app = buildApp(
      makeRenderer(chain => {
        rendered.push(`${chain.page.url.pathname}${chain.page.url.search}`);
        return new Response(`<html>${chain.page.url.pathname}${chain.page.url.search}</html>`, {
          headers: { 'content-type': 'text/html; charset=utf-8' },
        });
      }),
      routesDir,
      { authUserId: 'user-1' },
    );

    const headerRes = await app.request('/headers');
    expect(headerRes.status).toBe(200);
    expect(headerRes.headers.get('x-route-middleware')).toBe('applied');
    expect(await headerRes.text()).toContain('/headers');

    const redirectRes = await app.request('/redirect');
    expect(redirectRes.status).toBe(307);
    expect(redirectRes.headers.get('location')).toBe('/login');

    const rewriteRes = await app.request('/rewrite-me?from=request');
    expect(rewriteRes.status).toBe(200);
    expect(rewriteRes.headers.get('x-global-user')).toBe('user-1');
    expect(await rewriteRes.text()).toContain('/rewritten?via=middleware');
    expect(rendered).toContain('/rewritten?via=middleware');
  });

  it('does not read static files outside staticDir for traversal pathnames', async () => {
    // Track every path the runtime is asked to read. The hardened middleware
    // must never call readFile() with a path that escapes staticDir.
    const reads: string[] = [];
    const readFile = mock(async (filePath: string) => {
      reads.push(filePath);
      return null;
    });
    const renderer = makeRenderer(() => new Response('<html>fallback render</html>'));
    const app = new Hono();
    app.use(
      '*',
      buildSsrMiddleware(
        {
          renderer,
          serverRoutesDir: '/fake/routes',
          assetsManifest: '/fake/manifest.json',
          devMode: true,
          staticDir: '/var/www/static',
          runtime: { readFile } as never,
        },
        null,
        app,
      ),
    );
    app.get('*', c => c.text('fallback'));

    // Hono normalises `..` in some routing decisions but `path.join` does not
    // — the legacy code would have asked the runtime for `/var/www/etc/passwd`.
    // The hardened middleware skips the static lookup entirely instead.
    await app.request('/../../../etc/passwd');
    await app.request('/foo/../../bar');

    for (const p of reads) {
      expect(p.startsWith('/var/www/static/')).toBe(true);
    }
  });
});
