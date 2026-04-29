// packages/slingshot-ssg/tests/renderer-batch-edge.test.ts
//
// Edge cases for batch rendering (renderSsgPages): concurrency boundary
// values, partial failure aggregation, error collection fidelity, and
// behavior with unusual page counts or asset tag payloads.
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeAll, describe, expect, it } from 'bun:test';
import type {
  SlingshotSsrRenderer,
  SsrRouteChain,
  SsrRouteMatch,
  SsrShell,
} from '@lastshotlabs/slingshot-ssr';
import { renderSsgPages } from '../src/renderer';
import type { SsgConfig } from '../src/types';

const TMP = join(import.meta.dir, '__tmp_renderer_batch_edge__');

function makeConfig(overrides?: Partial<SsgConfig>): SsgConfig {
  return Object.freeze({
    serverRoutesDir: join(TMP, 'routes'),
    assetsManifest: join(TMP, 'manifest.json'),
    outDir: join(TMP, 'out'),
    concurrency: 2,
    ...overrides,
  });
}

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

function makeOkRenderer(): SlingshotSsrRenderer {
  return {
    async resolve(url) {
      return makeRouteMatch(url);
    },
    async render() {
      return new Response('<html>ok</html>', {
        status: 200,
        headers: { 'Content-Type': 'text/html; charset=utf-8' },
      });
    },
    async renderChain() {
      return new Response('<html>ok</html>', {
        status: 200,
        headers: { 'Content-Type': 'text/html; charset=utf-8' },
      });
    },
  };
}

function makeSelectiveRenderer(failingPaths: Set<string>): SlingshotSsrRenderer {
  return {
    async resolve(url) {
      return makeRouteMatch(url);
    },
    async render(match) {
      if (failingPaths.has(match.url.pathname)) {
        throw new Error(`intentional failure for ${match.url.pathname}`);
      }
      return new Response('<html>ok</html>', {
        status: 200,
        headers: { 'Content-Type': 'text/html; charset=utf-8' },
      });
    },
    async renderChain(chain) {
      if (failingPaths.has(chain.page.url.pathname)) {
        throw new Error(`intentional failure for ${chain.page.url.pathname}`);
      }
      return new Response('<html>ok</html>', {
        status: 200,
        headers: { 'Content-Type': 'text/html; charset=utf-8' },
      });
    },
  };
}

beforeAll(() => {
  mkdirSync(TMP, { recursive: true });
});

afterEach(() => {
  rmSync(TMP, { recursive: true, force: true });
  mkdirSync(TMP);
});

describe('renderSsgPages — concurrency boundary values', () => {
  it('renders all pages with concurrency set to NaN (treated as default 4)', async () => {
    const config = makeConfig({ concurrency: NaN });
    const result = await renderSsgPages(['/a', '/b', '/c'], makeOkRenderer(), config);
    expect(result.succeeded).toBe(3);
    expect(result.failed).toBe(0);
  });

  it('renders all pages with concurrency set to Infinity (treated as default 4)', async () => {
    const config = makeConfig({ concurrency: Infinity });
    const result = await renderSsgPages(['/a', '/b'], makeOkRenderer(), config);
    expect(result.succeeded).toBe(2);
  });

  it('renders all pages with concurrency of 1 (sequential)', async () => {
    const config = makeConfig({ concurrency: 1 });
    const paths = Array.from({ length: 10 }, (_, i) => `/page-${i}`);
    const result = await renderSsgPages(paths, makeOkRenderer(), config);
    expect(result.succeeded).toBe(10);
    expect(result.failed).toBe(0);
  });

  it('renders large number of pages with moderate concurrency', async () => {
    const config = makeConfig({ concurrency: 16 });
    const paths = Array.from({ length: 200 }, (_, i) => `/p-${i}`);
    const result = await renderSsgPages(paths, makeOkRenderer(), config);
    expect(result.succeeded).toBe(200);
    expect(result.failed).toBe(0);
  });
});

describe('renderSsgPages — partial failure and aggregation', () => {
  it('aggregates correctly when half the pages fail', async () => {
    const failing = new Set<string>(['/fail1', '/fail2', '/fail3', '/fail4', '/fail5']);
    const paths = [
      '/ok1',
      '/fail1',
      '/ok2',
      '/fail2',
      '/ok3',
      '/fail3',
      '/ok4',
      '/fail4',
      '/ok5',
      '/fail5',
    ];
    const result = await renderSsgPages(paths, makeSelectiveRenderer(failing), makeConfig({ concurrency: 4 }));
    expect(result.succeeded).toBe(5);
    expect(result.failed).toBe(5);
    expect(result.pages).toHaveLength(10);
  });

  it('aggregates correctly when only one page fails out of many', async () => {
    const failing = new Set<string>(['/only-fail']);
    const paths = ['/a', '/b', '/c', '/only-fail', '/d', '/e'];
    const result = await renderSsgPages(paths, makeSelectiveRenderer(failing), makeConfig());
    expect(result.succeeded).toBe(5);
    expect(result.failed).toBe(1);
  });

  it('error collection contains all failure details', async () => {
    const failing = new Set<string>(['/err-a', '/err-b']);
    const paths = ['/err-a', '/ok', '/err-b'];
    const result = await renderSsgPages(paths, makeSelectiveRenderer(failing), makeConfig({ concurrency: 2 }));
    const failedPages = result.pages.filter(p => p.error);
    expect(failedPages).toHaveLength(2);
    expect(failedPages[0].error?.message).toContain('intentional failure');
    expect(failedPages[1].error?.message).toContain('intentional failure');
    // Each failed page should have errorDetail with the route
    expect(failedPages.every(p => p.errorDetail?.route === p.path)).toBe(true);
  });

  it('durationMs increases with more pages', async () => {
    const start = Date.now();
    const resultShort = await renderSsgPages(['/a'], makeOkRenderer(), makeConfig());
    const shortDuration = resultShort.durationMs;

    // Let a tick pass so wall clock advances
    await new Promise(r => setTimeout(r, 5));

    const resultLong = await renderSsgPages(
      Array.from({ length: 25 }, (_, i) => `/p-${i}`),
      makeOkRenderer(),
      makeConfig({ concurrency: 1 }), // sequential = slower
    );
    const longDuration = resultLong.durationMs;

    expect(shortDuration).toBeGreaterThanOrEqual(0);
    expect(longDuration).toBeGreaterThan(shortDuration);
  });
});

describe('renderSsgPages — asset tags edge cases', () => {
  it('works with empty asset tags', async () => {
    const result = await renderSsgPages(['/page'], makeOkRenderer(), makeConfig(), '');
    expect(result.succeeded).toBe(1);
    expect(result.failed).toBe(0);
  });

  it('works with very long asset tags', async () => {
    const longTags = `<link rel="stylesheet" href="/assets/${'a'.repeat(5000)}.css">`;
    const result = await renderSsgPages(['/page'], makeOkRenderer(), makeConfig(), longTags);
    expect(result.succeeded).toBe(1);
    expect(result.failed).toBe(0);
  });

  it('works with multiple asset tags', async () => {
    const manyTags = Array.from({ length: 50 }, (_, i) =>
      `<link rel="stylesheet" href="/assets/style-${i}.css">`,
    ).join('\n');
    const result = await renderSsgPages(['/page'], makeOkRenderer(), makeConfig(), manyTags);
    expect(result.succeeded).toBe(1);
    expect(result.failed).toBe(0);
  });
});

describe('renderSsgPages — empty and single-page edge cases', () => {
  it('returns empty result for zero pages with any concurrency', async () => {
    const result = await renderSsgPages([], makeOkRenderer(), makeConfig({ concurrency: 10 }));
    expect(result.pages).toHaveLength(0);
    expect(result.succeeded).toBe(0);
    expect(result.failed).toBe(0);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('handles single page correctly', async () => {
    const result = await renderSsgPages(['/single'], makeOkRenderer(), makeConfig());
    expect(result.pages).toHaveLength(1);
    expect(result.succeeded).toBe(1);
    expect(result.failed).toBe(0);
    expect(existsSync(join(makeConfig().outDir, 'single', 'index.html'))).toBe(true);
  });
});
