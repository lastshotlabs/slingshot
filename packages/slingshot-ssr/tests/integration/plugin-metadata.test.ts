// Plugin-level integration tests for metadata convention route registration.
//
// Regression guard: metadata routes (sitemap.xml / robots.txt / manifest)
// used to register ONLY when `serverRoutesDir` was set. Apps using a custom
// `routeSource` (e.g. the TanStack adapter) silently lost them — their
// server/sitemap.ts became dead code and GET /sitemap.xml fell through to
// the SPA fallback. Registration is now driven by a metadata directory
// resolved independently of route discovery: explicit `metadataDir`, else
// dirname(serverRoutesDir), else <cwd>/server.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'bun:test';
import { Hono } from 'hono';
import type { AppEnv } from '@lastshotlabs/slingshot-core';
import { createSsrPackage } from '../../src/plugin';
import type { SsrRouteSource } from '../../src/routeSource/types';
import { makeMockRenderer } from '../../src/testing';

const mockBus = { on: () => {}, off: () => {}, emit: () => {}, drain: async () => {} } as never;

function makeStubRouteSource(): SsrRouteSource {
  return {
    id: 'stub',
    init: () => {},
    invalidate: () => {},
    resolve: () => null,
    resolveChain: () => null,
    resolveGlobalMiddleware: () => null,
  };
}

async function bootPlugin(config: Parameters<typeof createSsrPackage>[0]) {
  const plugin = createSsrPackage(config);
  const app = new Hono() as unknown as import('hono').Hono<AppEnv>;
  const { attachContext } = await import('@lastshotlabs/slingshot-core');
  (attachContext as (...args: unknown[]) => void)(app, { app, pluginState: new Map() });
  await plugin.setupMiddleware!({ app, bus: mockBus, events: mockBus, config: {} as never });
  return app as unknown as { request: (path: string) => Promise<Response> };
}

describe('createSsrPackage — metadata routes with a custom routeSource', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  function makeMetadataDir(): string {
    const root = mkdtempSync(join(tmpdir(), 'slingshot-ssr-plugin-metadata-'));
    tempDirs.push(root);
    const serverDir = join(root, 'server');
    mkdirSync(serverDir, { recursive: true });
    writeFileSync(
      join(serverDir, 'sitemap.ts'),
      'export default () => [{ url: "https://example.com/thread/1" }]\n',
      'utf8',
    );
    writeFileSync(
      join(serverDir, 'robots.ts'),
      'export default () => ({ rules: [{ userAgent: "*", allow: "/" }] })\n',
      'utf8',
    );
    return serverDir;
  }

  it('serves sitemap.xml and robots.txt when only routeSource + metadataDir are set', async () => {
    const metadataDir = makeMetadataDir();
    const app = await bootPlugin({
      renderer: makeMockRenderer(),
      routeSource: makeStubRouteSource(),
      metadataDir,
      assetsManifest: '/fake/manifest.json',
      devMode: true,
    });

    const sitemap = await app.request('/sitemap.xml');
    expect(sitemap.status).toBe(200);
    expect(sitemap.headers.get('content-type')).toContain('application/xml');
    expect(await sitemap.text()).toContain('https://example.com/thread/1');

    const robots = await app.request('/robots.txt');
    expect(robots.status).toBe(200);
    expect(robots.headers.get('content-type')).toContain('text/plain');
    expect(await robots.text()).toContain('User-agent: *');
  });

  it('explicit metadataDir wins over dirname(serverRoutesDir)', async () => {
    const metadataDir = makeMetadataDir();
    const app = await bootPlugin({
      renderer: makeMockRenderer(),
      serverRoutesDir: '/fake/routes',
      metadataDir,
      assetsManifest: '/fake/manifest.json',
      devMode: true,
    });

    const sitemap = await app.request('/sitemap.xml');
    expect(sitemap.status).toBe(200);
    expect(await sitemap.text()).toContain('https://example.com/thread/1');
  });

  it('rejects a relative metadataDir at construction', () => {
    expect(() =>
      createSsrPackage({
        renderer: makeMockRenderer(),
        routeSource: makeStubRouteSource(),
        metadataDir: 'relative/server',
        assetsManifest: '/fake/manifest.json',
        devMode: true,
      }),
    ).toThrow();
  });
});
