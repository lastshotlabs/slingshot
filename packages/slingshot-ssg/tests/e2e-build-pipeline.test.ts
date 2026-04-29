// packages/slingshot-ssg/tests/e2e-build-pipeline.test.ts
//
// Full end-to-end build pipeline integration test that exercises the complete
// crawl -> render -> output flow for a small test site with both static and
// dynamic routes.
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeAll, describe, expect, it } from 'bun:test';
import type { SlingshotSsrRenderer, SsrRouteMatch } from '@lastshotlabs/slingshot-ssr';
import { collectSsgRoutes } from '../src/crawler';
import { renderSsgPages } from '../src/renderer';
import type { SsgConfig } from '../src/types';

// ─── Fixture setup ────────────────────────────────────────────────────────────

const TMP = join(import.meta.dir, '__tmp_e2e__');

interface Fixtures {
  config: SsgConfig;
  routesDir: string;
  outDir: string;
  renderer: SlingshotSsrRenderer;
}

/**
 * Create a small test site with:
 *
 *   routes/about.ts       — static SSG route (revalidate: false)
 *   routes/posts/[slug].ts — dynamic SSG route (staticPaths export)
 *   routes/contact.ts     — non-SSG route (no revalidate, no staticPaths)
 */
function createFixtureSite(): Fixtures {
  const routesDir = join(TMP, 'routes');
  const outDir = join(TMP, 'out');
  const assetsManifest = join(TMP, 'manifest.json');

  mkdirSync(`${routesDir}/posts/[slug]`, { recursive: true });

  // Static route: explicit revalidate: false
  writeFileSync(
    join(routesDir, 'about.ts'),
    `export async function load() { return { data: { title: 'About' }, revalidate: false }; }\n`,
    'utf8',
  );

  // Dynamic route: staticPaths without explicit revalidate (isDynamic due to [slug])
  writeFileSync(
    join(routesDir, 'posts/[slug]/page.ts'),
    `
export async function staticPaths() {
  return [
    { slug: 'hello-world' },
    { slug: 'another-post' },
  ];
}

export async function load() { return { data: {} }; }
`.trim(),
    'utf8',
  );

  // Non-SSG route: no revalidate: false and no staticPaths — should be skipped
  writeFileSync(
    join(routesDir, 'contact.ts'),
    `export async function load() { return { data: { title: 'Contact' } }; }\n`,
    'utf8',
  );

  // Write a minimal Vite manifest
  writeFileSync(
    assetsManifest,
    JSON.stringify({
      'src/client/main.ts': {
        file: 'assets/app.js',
        isEntry: true,
      },
    }),
    'utf8',
  );

  // Create a mock renderer that returns HTML based on the requested path
  const renderer: SlingshotSsrRenderer = {
    async resolve(url: URL): Promise<SsrRouteMatch> {
      return {
        filePath: `/virtual${url.pathname}.ts`,
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
    },
    async render(match: SsrRouteMatch): Promise<Response> {
      const html = `<html><body><h1>${match.url.pathname}</h1></body></html>`;
      return new Response(html, {
        status: 200,
        headers: { 'Content-Type': 'text/html; charset=utf-8' },
      });
    },
    async renderChain(): Promise<Response> {
      return new Response('<html><body>chain</body></html>', {
        status: 200,
        headers: { 'Content-Type': 'text/html; charset=utf-8' },
      });
    },
  };

  const config: SsgConfig = Object.freeze({
    serverRoutesDir: routesDir,
    assetsManifest,
    outDir,
    concurrency: 4,
  });

  return { config, routesDir, outDir, renderer };
}

beforeAll(() => {
  mkdirSync(TMP, { recursive: true });
});

afterEach(() => {
  rmSync(TMP, { recursive: true, force: true });
  mkdirSync(TMP);
});

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('e2e build pipeline', () => {
  it('crawls, renders, and writes output for a mixed static/dynamic route site', async () => {
    const { config, outDir, renderer } = createFixtureSite();

    // Step 1: Crawl — discover SSG routes
    const paths = await collectSsgRoutes(config);
    expect(paths).toContain('/about');
    expect(paths).toContain('/posts/hello-world');
    expect(paths).toContain('/posts/another-post');
    // contact.ts has no revalidate:false and no staticPaths — should be excluded
    expect(paths).not.toContain('/contact');
    expect(paths).toHaveLength(3);

    // Step 2: Render — batch-render all discovered pages
    const assetTags = '<link rel="stylesheet" href="/assets/app.css">';
    const result = await renderSsgPages(paths, renderer, config, assetTags);

    // Step 3: Verify aggregate result
    expect(result.succeeded).toBe(3);
    expect(result.failed).toBe(0);
    expect(result.pages).toHaveLength(3);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);

    // Step 4: Verify output files exist
    const aboutHtml = join(outDir, 'about', 'index.html');
    const helloWorldHtml = join(outDir, 'posts', 'hello-world', 'index.html');
    const anotherPostHtml = join(outDir, 'posts', 'another-post', 'index.html');

    expect(existsSync(aboutHtml)).toBe(true);
    expect(existsSync(helloWorldHtml)).toBe(true);
    expect(existsSync(anotherPostHtml)).toBe(true);

    // Step 5: Verify HTML content
    const aboutContent = readFileSync(aboutHtml, 'utf8');
    expect(aboutContent).toContain('/about');

    const helloWorldContent = readFileSync(helloWorldHtml, 'utf8');
    expect(helloWorldContent).toContain('/posts/hello-world');

    const anotherPostContent = readFileSync(anotherPostHtml, 'utf8');
    expect(anotherPostContent).toContain('/posts/another-post');

  });

  it('handles an empty route set gracefully', async () => {
    // Routes directory exists but has no SSG-eligible routes
    const routesDir = join(TMP, 'empty-routes');
    const outDir = join(TMP, 'empty-out');

    mkdirSync(routesDir, { recursive: true });
    writeFileSync(
      join(routesDir, 'server-side.ts'),
      `export async function load() { return { data: {} }; }\n`,
      'utf8',
    );

    const config: SsgConfig = Object.freeze({
      serverRoutesDir: routesDir,
      assetsManifest: join(TMP, 'manifest.json'),
      outDir,
      concurrency: 2,
    });

    writeFileSync(config.assetsManifest, '{}', 'utf8');

    const paths = await collectSsgRoutes(config);
    expect(paths).toHaveLength(0);

    const renderer: SlingshotSsrRenderer = {
      async resolve() {
        return null;
      },
      async render(): Promise<Response> {
        return new Response('', { status: 200 });
      },
      async renderChain(): Promise<Response> {
        return new Response('', { status: 200 });
      },
    };

    const result = await renderSsgPages(paths, renderer, config);
    expect(result.succeeded).toBe(0);
    expect(result.failed).toBe(0);
    expect(result.pages).toHaveLength(0);
  });

  it('collects only routes with revalidate: false or staticPaths', async () => {
    const routesDir = join(TMP, 'mixed-routes');
    mkdirSync(`${routesDir}/blog/[id]`, { recursive: true });

    // SSG route
    writeFileSync(
      join(routesDir, 'static.ts'),
      `export async function load() { return { data: {}, revalidate: false }; }\n`,
      'utf8',
    );

    // SSG route with generateStaticParams
    writeFileSync(
      join(routesDir, 'blog/[id]/page.ts'),
      `
export async function generateStaticParams() {
  return [{ id: '1' }, { id: '2' }, { id: '3' }];
}
`.trim(),
      'utf8',
    );

    // Not SSG (SSR-only)
    writeFileSync(
      join(routesDir, 'dynamic.ts'),
      `export async function load() { return { data: {} }; }\n`,
      'utf8',
    );

    // Convention file
    writeFileSync(
      join(routesDir, 'layout.ts'),
      `export async function load() { return { data: {} }; }\n`,
      'utf8',
    );

    const config: SsgConfig = Object.freeze({
      serverRoutesDir: routesDir,
      assetsManifest: join(TMP, 'manifest.json'),
      outDir: join(TMP, 'mixed-out'),
      concurrency: 2,
    });

    writeFileSync(config.assetsManifest, '{}', 'utf8');

    const paths = await collectSsgRoutes(config);
    expect(paths).toContain('/static');
    expect(paths).toContain('/blog/1');
    expect(paths).toContain('/blog/2');
    expect(paths).toContain('/blog/3');
    expect(paths).not.toContain('/dynamic');
    expect(paths).not.toContain('/layout');
  });

  it('includes errorDetail on failed pages in batch results', async () => {
    const routesDir = join(TMP, 'error-routes');
    mkdirSync(routesDir, { recursive: true });

    writeFileSync(
      join(routesDir, 'good.ts'),
      `export async function load() { return { data: {}, revalidate: false }; }\n`,
      'utf8',
    );
    writeFileSync(
      join(routesDir, 'bad.ts'),
      `export async function load() { return { data: {}, revalidate: false }; }\n`,
      'utf8',
    );

    const config: SsgConfig = Object.freeze({
      serverRoutesDir: routesDir,
      assetsManifest: join(TMP, 'manifest.json'),
      outDir: join(TMP, 'error-out'),
      concurrency: 2,
    });

    writeFileSync(config.assetsManifest, '{}', 'utf8');

    const renderer: SlingshotSsrRenderer = {
      async resolve(url: URL): Promise<SsrRouteMatch | null> {
        if (url.pathname === '/bad') return null;
        return {
          filePath: `/virtual${url.pathname}.ts`,
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
      },
      async render(match: SsrRouteMatch): Promise<Response> {
        return new Response(`<html>${match.url.pathname}</html>`, { status: 200 });
      },
      async renderChain(): Promise<Response> {
        return new Response('<html>chain</html>', { status: 200 });
      },
    };

    const paths = await collectSsgRoutes(config);
    expect(paths).toHaveLength(2);

    const result = await renderSsgPages(paths, renderer, config);
    expect(result.succeeded).toBe(1);
    expect(result.failed).toBe(1);

    const failedPages = result.pages.filter(p => p.error);
    expect(failedPages).toHaveLength(1);
    expect(failedPages[0].path).toBe('/bad');
    expect(failedPages[0].errorDetail).toBeDefined();
    expect(failedPages[0].errorDetail?.route).toBe('/bad');
    expect(failedPages[0].errorDetail?.message).toContain('No route matched');
  });
});
