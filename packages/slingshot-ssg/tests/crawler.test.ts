// packages/slingshot-ssg/tests/crawler.test.ts
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeAll, describe, expect, it } from 'bun:test';
import { collectSsgRoutes } from '../src/crawler';
import type { SsgConfig } from '../src/types';

const TMP = join(import.meta.dir, '__tmp_routes__');

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

describe('collectSsgRoutes — empty dir', () => {
  it('returns [] when dir is empty', async () => {
    const paths = await collectSsgRoutes(makeConfig());
    expect(paths).toEqual([]);
  });

  it('returns [] when dir does not exist', async () => {
    const paths = await collectSsgRoutes(makeConfig({ serverRoutesDir: join(TMP, 'nonexistent') }));
    expect(paths).toEqual([]);
  });
});

describe('collectSsgRoutes — static routes', () => {
  it('detects revalidate: false in a static route and returns its URL', async () => {
    writeRoute(
      'about.ts',
      `export async function load() { return { data: {}, revalidate: false } }`,
    );
    const paths = await collectSsgRoutes(makeConfig());
    expect(paths).toContain('/about');
  });

  it('ignores routes without revalidate: false or staticPaths', async () => {
    writeRoute('posts.ts', `export async function load() { return { data: {} } }`);
    const paths = await collectSsgRoutes(makeConfig());
    expect(paths).toEqual([]);
  });

  it('handles index.ts as root path /', async () => {
    writeRoute(
      'index.ts',
      `export async function load() { return { data: {}, revalidate: false } }`,
    );
    const paths = await collectSsgRoutes(makeConfig());
    expect(paths).toContain('/');
  });

  it('handles nested static routes', async () => {
    writeRoute(
      'docs/intro.ts',
      `export async function load() { return { data: {}, revalidate: false } }`,
    );
    const paths = await collectSsgRoutes(makeConfig());
    expect(paths).toContain('/docs/intro');
  });

  it('treats page.ts as the route root rather than a literal /page segment', async () => {
    writeRoute(
      'docs/page.ts',
      `export async function load() { return { data: {}, revalidate: false } }`,
    );
    const paths = await collectSsgRoutes(makeConfig());
    expect(paths).toContain('/docs');
    expect(paths).not.toContain('/docs/page');
  });

  it('ignores meta.ts files', async () => {
    writeRoute(
      'about.ts',
      `export async function load() { return { data: {}, revalidate: false } }`,
    );
    writeRoute('meta.ts', `export function meta() { return { title: 'test' } }`);
    const paths = await collectSsgRoutes(makeConfig());
    expect(paths).toContain('/about');
    // meta.ts should never produce a URL
    expect(paths.every(p => p !== '/meta')).toBe(true);
  });

  it('ignores non-page SSR convention files', async () => {
    writeRoute(
      'about.ts',
      `export async function load() { return { data: {}, revalidate: false } }`,
    );
    writeRoute(
      'forbidden.ts',
      `export async function load() { return { data: {}, revalidate: false } }`,
    );
    writeRoute(
      'unauthorized.ts',
      `export async function load() { return { data: {}, revalidate: false } }`,
    );
    writeRoute(
      'template.ts',
      `export async function load() { return { data: {}, revalidate: false } }`,
    );

    const paths = await collectSsgRoutes(makeConfig());
    expect(paths).toContain('/about');
    expect(paths).not.toContain('/forbidden');
    expect(paths).not.toContain('/unauthorized');
    expect(paths).not.toContain('/template');
  });

  it('strips route group segments from URL', async () => {
    writeRoute(
      '(marketing)/landing.ts',
      `export async function load() { return { data: {}, revalidate: false } }`,
    );
    const paths = await collectSsgRoutes(makeConfig());
    expect(paths).toContain('/landing');
  });

  it('deduplicates paths', async () => {
    // Two files that both resolve to /about shouldn't produce duplicate URLs
    writeRoute(
      'about.ts',
      `export async function load() { return { data: {}, revalidate: false } }`,
    );
    const paths = await collectSsgRoutes(makeConfig());
    const aboutPaths = paths.filter(p => p === '/about');
    expect(aboutPaths).toHaveLength(1);
  });

  it('returns sorted paths', async () => {
    writeRoute(
      'zebra.ts',
      `export async function load() { return { data: {}, revalidate: false } }`,
    );
    writeRoute(
      'apple.ts',
      `export async function load() { return { data: {}, revalidate: false } }`,
    );
    const paths = await collectSsgRoutes(makeConfig());
    const sorted = [...paths].sort();
    expect(paths).toEqual(sorted);
  });
});

describe('collectSsgRoutes — dynamic routes with staticPaths', () => {
  it('calls staticPaths() and expands to concrete URLs', async () => {
    // Write a dynamic route that exports staticPaths returning two slugs
    writeRoute(
      '[slug].ts',
      `
export async function staticPaths() {
  return [{ slug: 'hello' }, { slug: 'world' }];
}
export async function load() { return { data: {}, revalidate: false } }
`,
    );
    const paths = await collectSsgRoutes(makeConfig());
    expect(paths).toContain('/hello');
    expect(paths).toContain('/world');
  });

  it('handles nested dynamic routes', async () => {
    writeRoute(
      'posts/[slug].ts',
      `
export async function staticPaths() {
  return [{ slug: 'post-a' }, { slug: 'post-b' }];
}
export async function load() { return { data: {}, revalidate: false } }
`,
    );
    const paths = await collectSsgRoutes(makeConfig());
    expect(paths).toContain('/posts/post-a');
    expect(paths).toContain('/posts/post-b');
  });

  it('skips dynamic routes without staticPaths even when revalidate: false', async () => {
    writeRoute(
      '[id].ts',
      `export async function load() { return { data: {}, revalidate: false } }`,
    );
    // Should warn and skip — no staticPaths
    const paths = await collectSsgRoutes(makeConfig());
    // The [id] placeholder should not appear literally in paths
    expect(paths.every(p => !p.includes('['))).toBe(true);
  });

  it('returns [] when staticPaths() returns empty array', async () => {
    // Use a distinct file name to avoid Bun's module cache serving the previous test's module
    writeRoute(
      '[emptyslug].ts',
      `
export async function staticPaths() { return []; }
export async function load() { return { data: {}, revalidate: false } }
`,
    );
    const paths = await collectSsgRoutes(makeConfig());
    expect(paths).toEqual([]);
  });

  it('detects staticPaths as arrow function export', async () => {
    writeRoute(
      '[id].ts',
      `
export const staticPaths = async () => [{ id: 'item-1' }];
export async function load() { return { data: {}, revalidate: false } }
`,
    );
    const paths = await collectSsgRoutes(makeConfig());
    expect(paths).toContain('/item-1');
  });

  it('supports generateStaticParams(ctx) for dynamic routes', async () => {
    writeRoute(
      'players/[id].ts',
      `
export async function generateStaticParams(ctx) {
  void ctx.url;
  return [{ id: '42' }, { id: '99' }];
}
export async function load() { return { data: {}, revalidate: false } }
`,
    );
    const paths = await collectSsgRoutes(makeConfig());
    expect(paths).toContain('/players/42');
    expect(paths).toContain('/players/99');
  });

  it('detects generateStaticParams via destructured const export (defineRoute pattern)', async () => {
    writeRoute(
      'destructured-route/[slug].ts',
      `
const route = {
  load: async () => ({ data: {}, revalidate: false }),
  generateStaticParams: async () => [{ slug: 'a' }, { slug: 'b' }],
};
export const { load, generateStaticParams } = route;
`,
    );
    const paths = await collectSsgRoutes(makeConfig());
    expect(paths).toContain('/destructured-route/a');
    expect(paths).toContain('/destructured-route/b');
  });

  it('detects generateStaticParams via named re-export', async () => {
    writeRoute(
      'reexport-route/[name].ts',
      `
const generateStaticParamsImpl = async () => [{ name: 'react' }];
const loadImpl = async () => ({ data: {}, revalidate: false });
export { generateStaticParamsImpl as generateStaticParams, loadImpl as load };
`,
    );
    const paths = await collectSsgRoutes(makeConfig());
    expect(paths).toContain('/reexport-route/react');
  });

  it('prefers the callable generateStaticParams export when staticPaths is present but not callable', async () => {
    writeRoute(
      'authors/[id].ts',
      `
export const staticPaths = undefined;
export async function generateStaticParams(ctx) {
  void ctx.url;
  return [{ id: 'alice' }];
}
export async function load() { return { data: {}, revalidate: false } }
`,
    );
    const paths = await collectSsgRoutes(makeConfig());
    expect(paths).toContain('/authors/alice');
  });
});

describe('collectSsgRoutes — directory form routes', () => {
  it('detects SSG in directory-form load.ts', async () => {
    writeRoute(
      'docs/intro/load.ts',
      `export async function load() { return { data: {}, revalidate: false } }`,
    );
    const paths = await collectSsgRoutes(makeConfig());
    expect(paths).toContain('/docs/intro');
  });
});

describe('collectSsgRoutes — staticPathsTimeoutMs config', () => {
  it('uses custom staticPathsTimeoutMs from config when calling staticPaths()', async () => {
    writeRoute(
      'articles/[slug].ts',
      `
export async function staticPaths() {
  return [{ slug: 'hello' }];
}
export async function load() { return { data: {}, revalidate: false } }
`,
    );

    // Custom short timeout should still work for fast functions
    const paths = await collectSsgRoutes(makeConfig({ staticPathsTimeoutMs: 5_000 }));
    expect(paths).toContain('/articles/hello');
  });

  it('fails the build when staticPaths() times out', async () => {
    writeRoute(
      'slow/[id].ts',
      `
export async function staticPaths() {
  // This would hang forever without a timeout
  await new Promise(() => {});
  return [{ id: '1' }];
}
export async function load() { return { data: {}, revalidate: false } }
`,
    );

    await expect(collectSsgRoutes(makeConfig({ staticPathsTimeoutMs: 1 }))).rejects.toThrow(
      /staticPaths\(\) failed/,
    );
  });

  it('fails the build when staticPaths() returns too many params', async () => {
    writeRoute(
      'many/[id].ts',
      `
export async function staticPaths() {
  return [{ id: '1' }, { id: '2' }];
}
export async function load() { return { data: {}, revalidate: false } }
`,
    );

    await expect(collectSsgRoutes(makeConfig({ maxStaticPathsPerRoute: 1 }))).rejects.toThrow(
      /maxStaticPathsPerRoute is 1/,
    );
  });
});
