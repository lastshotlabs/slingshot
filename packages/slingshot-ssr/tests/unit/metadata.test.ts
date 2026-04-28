import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'bun:test';
import { registerMetadataRoutes } from '../../src/metadata';

type Handler = (ctx: {
  body(data: string, status: number, headers: Record<string, string>): Response;
}) => unknown;

function createHarness() {
  const routes = new Map<string, Handler>();
  const app = {
    get(path: string, handler: Handler) {
      routes.set(path, handler);
    },
  };
  return { app, routes };
}

async function invoke(handler: Handler): Promise<Response> {
  return (await handler({
    body: (data, status, headers) => new Response(data, { status, headers }),
  })) as Response;
}

describe('metadata convention routes', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  function makeServerDir(): { serverDir: string; routesDir: string } {
    const root = mkdtempSync(join(tmpdir(), 'slingshot-ssr-metadata-'));
    tempDirs.push(root);
    const serverDir = join(root, 'server');
    const routesDir = join(serverDir, 'routes');
    mkdirSync(routesDir, { recursive: true });
    return { serverDir, routesDir };
  }

  test('registers no routes when convention files are absent', () => {
    const { routesDir } = makeServerDir();
    const { app, routes } = createHarness();

    registerMetadataRoutes(app, routesDir);

    expect(routes.size).toBe(0);
  });

  test('renders sitemap, robots, and manifest convention files', async () => {
    const { serverDir, routesDir } = makeServerDir();
    writeFileSync(
      join(serverDir, 'sitemap.ts'),
      [
        'export default () => [',
        '  { url: "https://example.com/a&b", lastModified: new Date("2026-01-02T03:04:05Z"), changeFrequency: "daily", priority: 0.8, alternates: { languages: { fr: "https://example.com/fr/a" } } },',
        '  { url: "https://example.com/raw", lastModified: "not-a-date" },',
        ']',
      ].join('\n'),
      'utf8',
    );
    writeFileSync(
      join(serverDir, 'robots.ts'),
      [
        'export const robots = () => ({',
        '  rules: [{ userAgent: ["Googlebot", "Bingbot"], allow: "/", disallow: ["/admin", "/api"], crawlDelay: 5 }, { disallow: "/private" }],',
        '  sitemap: ["https://example.com/sitemap.xml", "https://example.com/news.xml"],',
        '  host: "example.com",',
        '})',
      ].join('\n'),
      'utf8',
    );
    writeFileSync(
      join(serverDir, 'manifest.js'),
      'export const manifest = () => ({ name: "Example", start_url: "/" })\n',
      'utf8',
    );
    const { app, routes } = createHarness();

    registerMetadataRoutes(app, routesDir);

    expect([...routes.keys()].sort()).toEqual([
      '/manifest.json',
      '/manifest.webmanifest',
      '/robots.txt',
      '/sitemap.xml',
    ]);

    const sitemap = await invoke(routes.get('/sitemap.xml')!);
    expect(sitemap.status).toBe(200);
    expect(sitemap.headers.get('content-type')).toContain('application/xml');
    const sitemapText = await sitemap.text();
    expect(sitemapText).toContain('&amp;');
    expect(sitemapText).toContain('<lastmod>2026-01-02</lastmod>');
    expect(sitemapText).toContain('<lastmod>not-a-date</lastmod>');
    expect(sitemapText).toContain('hreflang="fr"');

    const robots = await invoke(routes.get('/robots.txt')!);
    expect(robots.status).toBe(200);
    const robotsText = await robots.text();
    expect(robotsText).toContain('User-agent: Googlebot');
    expect(robotsText).toContain('User-agent: *');
    expect(robotsText).toContain('Disallow: /api');
    expect(robotsText).toContain('Crawl-delay: 5');
    expect(robotsText).toContain('Sitemap: https://example.com/news.xml');
    expect(robotsText).toContain('Host: example.com');

    const manifest = await invoke(routes.get('/manifest.webmanifest')!);
    expect(manifest.status).toBe(200);
    expect(manifest.headers.get('content-type')).toContain('application/manifest+json');
    expect(await manifest.json()).toEqual({ name: 'Example', start_url: '/' });
  });

  test('returns 404 when a convention file does not export a handler', async () => {
    const { serverDir, routesDir } = makeServerDir();
    writeFileSync(join(serverDir, 'sitemap.ts'), 'export const value = 1\n', 'utf8');
    const { app, routes } = createHarness();

    registerMetadataRoutes(app, routesDir);
    const response = await invoke(routes.get('/sitemap.xml')!);

    expect(response.status).toBe(404);
    expect(await response.text()).toBe('Not Found');
  });

  test('returns 500 when a convention handler throws', async () => {
    const { serverDir, routesDir } = makeServerDir();
    writeFileSync(
      join(serverDir, 'robots.ts'),
      'export default () => { throw new Error("boom") }\n',
      'utf8',
    );
    const { app, routes } = createHarness();

    registerMetadataRoutes(app, routesDir);
    const response = await invoke(routes.get('/robots.txt')!);

    expect(response.status).toBe(500);
    expect(await response.text()).toBe('Internal Server Error');
  });
});
