import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeAll, describe, expect, it } from 'bun:test';
import { initRouteTree, invalidateRouteTree, resolveRoute } from '../../src/resolver';

const TMP = join(import.meta.dir, '__tmp_routes__');

function createRouteFile(
  relPath: string,
  content = 'export async function load() { return { data: {} } }',
) {
  const full = join(TMP, relPath);
  mkdirSync(full.replace(/[^/\\]+$/, ''), { recursive: true });
  writeFileSync(full, content);
}

beforeAll(() => {
  mkdirSync(TMP, { recursive: true });
});

afterEach(() => {
  rmSync(TMP, { recursive: true, force: true });
  mkdirSync(TMP);
  invalidateRouteTree(TMP);
});

describe('resolveRoute — static routes', () => {
  it('matches root / via index.ts', () => {
    createRouteFile('index.ts');
    initRouteTree(TMP);
    const match = resolveRoute('/', TMP);
    expect(match).not.toBeNull();
    expect(match!.params).toEqual({});
  });

  it('matches /posts via posts/index.ts', () => {
    createRouteFile('posts/index.ts');
    initRouteTree(TMP);
    expect(resolveRoute('/posts', TMP)).not.toBeNull();
  });

  it('matches /posts via posts.ts', () => {
    createRouteFile('posts.ts');
    initRouteTree(TMP);
    expect(resolveRoute('/posts', TMP)).not.toBeNull();
  });

  it('strips trailing slash before matching', () => {
    createRouteFile('posts.ts');
    initRouteTree(TMP);
    expect(resolveRoute('/posts/', TMP)).not.toBeNull();
  });
});

describe('resolveRoute — dynamic segments', () => {
  it('matches /posts/nba-finals via [slug].ts and captures param', () => {
    createRouteFile('posts/[slug].ts');
    initRouteTree(TMP);
    const match = resolveRoute('/posts/nba-finals', TMP);
    expect(match).not.toBeNull();
    expect(match!.params.slug).toBe('nba-finals');
  });

  it('matches nested segments via [cat]/[sub].ts', () => {
    createRouteFile('[cat]/[sub].ts');
    initRouteTree(TMP);
    const match = resolveRoute('/sports/nba', TMP);
    expect(match).not.toBeNull();
    expect(match!.params).toEqual({ cat: 'sports', sub: 'nba' });
  });

  it('URL-decodes param values', () => {
    createRouteFile('[slug].ts');
    initRouteTree(TMP);
    const match = resolveRoute('/hello%20world', TMP);
    expect(match?.params.slug).toBe('hello world');
  });
});

describe('resolveRoute — directory form', () => {
  it('resolves /posts/[slug]/load.ts as /posts/:slug', () => {
    createRouteFile('posts/[slug]/load.ts');
    initRouteTree(TMP);
    const match = resolveRoute('/posts/my-post', TMP);
    expect(match).not.toBeNull();
    expect(match!.params.slug).toBe('my-post');
  });

  it('sets metaFilePath when meta.ts exists alongside load.ts', () => {
    createRouteFile('posts/[slug]/load.ts');
    createRouteFile('posts/[slug]/meta.ts');
    initRouteTree(TMP);
    const match = resolveRoute('/posts/my-post', TMP);
    expect(match!.metaFilePath).toMatch(/meta\.ts$/);
  });

  it('sets metaFilePath to null when meta.ts does not exist', () => {
    createRouteFile('posts/[slug]/load.ts');
    initRouteTree(TMP);
    const match = resolveRoute('/posts/my-post', TMP);
    expect(match!.metaFilePath).toBeNull();
  });
});

describe('resolveRoute — catch-all', () => {
  it('matches any path via [...rest].ts', () => {
    createRouteFile('[...rest].ts');
    initRouteTree(TMP);
    const match = resolveRoute('/a/b/c/d', TMP);
    expect(match).not.toBeNull();
    expect(match!.params.rest).toBe('a/b/c/d');
  });

  it('specific route wins over catch-all', () => {
    createRouteFile('posts/[slug].ts');
    createRouteFile('[...rest].ts');
    initRouteTree(TMP);
    const match = resolveRoute('/posts/nba', TMP);
    expect(match!.params).toHaveProperty('slug');
    expect(match!.params).not.toHaveProperty('rest');
  });
});

describe('resolveRoute — route groups', () => {
  it('strips (group) segment from URL matching', () => {
    createRouteFile('(auth)/login.ts');
    initRouteTree(TMP);
    expect(resolveRoute('/login', TMP)).not.toBeNull();
  });

  it('does NOT match the literal (group) path', () => {
    createRouteFile('(auth)/login.ts');
    initRouteTree(TMP);
    expect(resolveRoute('/(auth)/login', TMP)).toBeNull();
  });
});

describe('resolveRoute — no match', () => {
  it('returns null for unmatched path', () => {
    createRouteFile('posts/index.ts');
    initRouteTree(TMP);
    expect(resolveRoute('/users', TMP)).toBeNull();
  });

  it('returns null when route tree not initialised', () => {
    // intentionally no initRouteTree call
    expect(resolveRoute('/posts', TMP)).toBeNull();
  });
});

describe('resolver cache', () => {
  it('initRouteTree is idempotent', () => {
    createRouteFile('posts.ts');
    initRouteTree(TMP);
    initRouteTree(TMP); // second call — should not throw
    expect(resolveRoute('/posts', TMP)).not.toBeNull();
  });

  it('invalidateRouteTree clears cache', () => {
    createRouteFile('posts.ts');
    initRouteTree(TMP);
    invalidateRouteTree(TMP);
    // Not re-initialised — should return null
    expect(resolveRoute('/posts', TMP)).toBeNull();
  });

  it('re-init after invalidate picks up new files', () => {
    createRouteFile('posts.ts');
    initRouteTree(TMP);
    invalidateRouteTree(TMP);
    createRouteFile('users.ts');
    initRouteTree(TMP);
    expect(resolveRoute('/posts', TMP)).not.toBeNull();
    expect(resolveRoute('/users', TMP)).not.toBeNull();
  });
});
