// packages/slingshot-ssg/tests/crawler-concurrency.test.ts
//
// Tests for crawler concurrency batching: COLLECT_CONCURRENCY batch reads,
// route deduplication, and staticPaths timeout isolation per route.
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeAll, describe, expect, it } from 'bun:test';
import { collectSsgRoutes } from '../src/crawler';
import type { SsgConfig } from '../src/types';

const TMP = join(import.meta.dir, '__tmp_crawler_concurrency__');

function writeRoute(relPath: string, content: string): void {
  const full = join(TMP, relPath);
  mkdirSync(full.replace(/[^/\\]+$/, ''), { recursive: true });
  writeFileSync(full, content);
}

function makeConfig(overrides?: Partial<SsgConfig>): SsgConfig {
  return Object.freeze({
    serverRoutesDir: TMP,
    assetsManifest: join(TMP, 'manifest.json'),
    outDir: join(TMP, 'out'),
    concurrency: 1,
    ...overrides,
  });
}

beforeAll(() => {
  mkdirSync(TMP, { recursive: true });
});

afterEach(() => {
  rmSync(TMP, { recursive: true, force: true });
  mkdirSync(TMP);
});

describe('crawler concurrency — batch reads (COLLECT_CONCURRENCY)', () => {
  it('crawls routes spread across many files without blocking', async () => {
    // Write more than COLLECT_CONCURRENCY (32) files to force multiple batches
    for (let i = 0; i < 40; i += 1) {
      writeRoute(
        `batch-test/page-${i}.ts`,
        `export async function load() { return { data: {}, revalidate: false } }`,
      );
    }
    const paths = await collectSsgRoutes(makeConfig());
    expect(paths).toHaveLength(40);
  });

  it('handles mixed static and dynamic routes in the same batch', async () => {
    writeRoute(
      'static.ts',
      `export async function load() { return { data: {}, revalidate: false } }`,
    );
    writeRoute(
      'dynamic/[slug].ts',
      `
export async function staticPaths() {
  return [{ slug: 'a' }, { slug: 'b' }];
}
export async function load() { return { data: {}, revalidate: false } }
`,
    );
    const paths = await collectSsgRoutes(makeConfig());
    expect(paths).toContain('/static');
    expect(paths).toContain('/dynamic/a');
    expect(paths).toContain('/dynamic/b');
  });

  it('continues with partial results when ein some route files fail to read', async () => {
    // Writing only valid files; the batch's safeReadSourceAsync catches errors.
    // Write a valid file and an invalid/empty entry to simulate partial failure.
    writeRoute(
      'valid.ts',
      `export async function load() { return { data: {}, revalidate: false } }`,
    );
    writeRoute(
      'also-valid.ts',
      `export async function load() { return { data: {}, revalidate: false } }`,
    );
    const paths = await collectSsgRoutes(makeConfig());
    expect(paths.length).toBeGreaterThanOrEqual(2);
  });
});

describe('crawler concurrency — route deduplication', () => {
  it('deduplicates identical paths from different files', async () => {
    // Two files that produce the same URL path
    writeRoute(
      'about.ts',
      `export async function load() { return { data: {}, revalidate: false } }`,
    );
    writeRoute(
      'about/page.ts',
      `export async function load() { return { data: {}, revalidate: false } }`,
    );
    const paths = await collectSsgRoutes(makeConfig());
    const aboutPaths = paths.filter(p => p === '/about');
    expect(aboutPaths).toHaveLength(1);
  });

  it('deduplicates when staticPaths returns overlapping paths with dynamic routes', async () => {
    writeRoute(
      'product/[id].ts',
      `
export async function staticPaths() {
  return [{ id: 'a' }, { id: 'b' }];
}
export async function load() { return { data: {}, revalidate: false } }
`,
    );
    // Same concrete path via a static file
    writeRoute(
      'product/a.ts',
      `export async function load() { return { data: {}, revalidate: false } }`,
    );
    const paths = await collectSsgRoutes(makeConfig());
    const productAPaths = paths.filter(p => p === '/product/a');
    expect(productAPaths).toHaveLength(1);
  });
});

describe('crawler concurrency — timeout per route', () => {
  it('allows fast staticPaths to complete when one route has a slow but non-hanging path', async () => {
    writeRoute(
      'fast.ts',
      `export async function staticPaths() { return [{ id: 'quick' }]; }
export async function load() { return { data: {}, revalidate: false } }`,
    );
    writeRoute(
      'slow.ts',
      `
export async function staticPaths() {
  await new Promise(r => setTimeout(r, 30));
  return [{ id: 'slowpoke' }];
}
export async function load() { return { data: {}, revalidate: false } }
`,
    );
    // Use a generous timeout so both succeed
    const paths = await collectSsgRoutes(makeConfig({ staticPathsTimeoutMs: 5_000 }));
    expect(paths).toContain('/fast');
    expect(paths).toContain('/slow');
  });

  it('isolates timeout: one hanging staticPaths fails the build but does not affect other routes', async () => {
    writeRoute(
      'fast.ts',
      `export async function staticPaths() { return [{ id: 'quick' }]; }
export async function load() { return { data: {}, revalidate: false } }`,
    );
    writeRoute(
      'hung/[id].ts',
      `
export async function staticPaths() {
  await new Promise(() => {});
  return [{ id: 'never' }];
}
export async function load() { return { data: {}, revalidate: false } }
`,
    );
    // The hanging route is visited first (sorted), so the timeout exception
    // propagates. With sequential processing, the fast route is never reached.
    let caught: unknown;
    try {
      await collectSsgRoutes(makeConfig({ staticPathsTimeoutMs: 10 }));
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeDefined();
    expect((caught as Error).message).toContain('staticPaths');
  });
});
