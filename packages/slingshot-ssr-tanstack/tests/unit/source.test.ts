import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'bun:test';
import { createTanStackRouteSource } from '../../src/source';

function mkRoutes(files: Record<string, string>): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'tanstack-source-'));
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(dir, rel);
    mkdirSync(path.dirname(full), { recursive: true });
    writeFileSync(full, content);
  }
  return dir;
}

const ROUTE = (label: string) => `
export const Route = {
  options: { component: function ${label}() { return null; } },
};
`;

const SERVER = (label: string) => `
export async function load() {
  return { data: { from: 'server', label: '${label}' } };
}
`;

const ROUTE_NO_COMPANION = `
export const Route = {
  options: { component: () => null },
};
`;

describe('createTanStackRouteSource (companion-file convention)', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkRoutes({
      '__root.tsx': ROUTE_NO_COMPANION,
      '_app.tsx': ROUTE_NO_COMPANION,
      '_app/_feed/index.tsx': ROUTE('Home'),
      '_app/_feed/index.server.ts': SERVER('home'),
      '_app/c/$slug/$threadId.tsx': ROUTE('Thread'),
      '_app/c/$slug/$threadId.server.ts': SERVER('thread'),
      '_app/user.$handle.tsx': ROUTE('Profile'),
      '_app/user.$handle.server.ts': SERVER('profile'),
      // CSR-only — no companion
      '_app/settings.tsx': ROUTE_NO_COMPANION,
      '_app/settings/index.tsx': ROUTE_NO_COMPANION,
    });
  });

  it('only resolves leaves with a companion .server.ts', () => {
    const source = createTanStackRouteSource({ routesDirectory: dir });
    source.init();

    expect(source.id).toBe('tanstack');
    expect(source.resolve('/')).not.toBeNull();
    expect(source.resolve('/c/test/abc')).not.toBeNull();
    expect(source.resolve('/user/jdd')).not.toBeNull();

    // CSR-only — should NOT match.
    expect(source.resolve('/settings')).toBeNull();
  });

  it('returns null before init() runs', () => {
    const source = createTanStackRouteSource({ routesDirectory: dir });
    expect(source.resolve('/')).toBeNull();
  });

  it('extracts params correctly', () => {
    const source = createTanStackRouteSource({ routesDirectory: dir });
    source.init();
    const m = source.resolve('/c/foo/bar');
    expect(m).not.toBeNull();
    expect(m!.params).toEqual({ slug: 'foo', threadId: 'bar' });
  });

  it('throws RouteParamTooLargeError for oversized params', () => {
    const source = createTanStackRouteSource({
      routesDirectory: dir,
      maxRouteParamBytes: 16,
    });
    source.init();
    const huge = 'a'.repeat(64);
    expect(() => source.resolve(`/user/${huge}`)).toThrow(/exceeding/);
  });

  it('match.loadModule stitches Route.component + companion.load', async () => {
    const source = createTanStackRouteSource({ routesDirectory: dir });
    source.init();
    const m = source.resolve('/');
    expect(m?.loadModule).toBeDefined();
    const mod = await m!.loadModule!();
    expect(typeof mod.load).toBe('function');
    expect(typeof mod.default).toBe('function');
    const result = (await mod.load({} as never)) as {
      data: { from: string; label: string };
    };
    expect(result.data.from).toBe('server');
    expect(result.data.label).toBe('home');
  });

  it('resolveChain returns layouts outermost-first', () => {
    const source = createTanStackRouteSource({ routesDirectory: dir });
    source.init();
    const chain = source.resolveChain('/');
    expect(chain).not.toBeNull();
    expect(chain!.layouts).toHaveLength(2);
    expect(chain!.layouts[0]?.filePath.endsWith('__root.tsx')).toBe(true);
    expect(chain!.layouts[1]?.filePath.endsWith('_app.tsx')).toBe(true);
    expect(chain!.page.filePath.endsWith('_app/_feed/index.tsx')).toBe(true);
  });

  it('invalidate forces re-scan on next request', () => {
    const source = createTanStackRouteSource({ routesDirectory: dir });
    source.init();
    expect(source.resolve('/')).not.toBeNull();
    source.invalidate();
    expect(source.resolve('/')).toBeNull();
    source.init();
    expect(source.resolve('/')).not.toBeNull();
  });
});

describe('convention components (loading / error / not-found / forbidden / unauthorized)', () => {
  const CONVENTION = `export default function NotFound() { return null; }`;

  it('resolves a co-located not-found file onto the match', () => {
    const dir = mkRoutes({
      '__root.tsx': ROUTE_NO_COMPANION,
      'u/$handle.tsx': ROUTE('Profile'),
      'u/$handle.server.ts': SERVER('profile'),
      'u/not-found.tsx': CONVENTION,
    });
    const source = createTanStackRouteSource({ routesDirectory: dir });
    source.init();
    const match = source.resolve('/u/jdd');
    expect(match).not.toBeNull();
    expect(match!.notFoundFilePath?.endsWith('u/not-found.tsx')).toBe(true);
  });

  it('INHERITS a not-found file from an ancestor directory', () => {
    // The whole point: one 404 at the routes root covers every leaf. Before
    // this the adapter reported null and the renderer fell back to a
    // plain-text `Not Found` body no matter what the app shipped.
    const dir = mkRoutes({
      '__root.tsx': ROUTE_NO_COMPANION,
      'not-found.tsx': CONVENTION,
      'c/$slug/$threadId.tsx': ROUTE('Thread'),
      'c/$slug/$threadId.server.ts': SERVER('thread'),
    });
    const source = createTanStackRouteSource({ routesDirectory: dir });
    source.init();
    const match = source.resolve('/c/general/abc');
    expect(match!.notFoundFilePath?.endsWith('not-found.tsx')).toBe(true);
  });

  it('a nearer convention file wins over an ancestor', () => {
    const dir = mkRoutes({
      '__root.tsx': ROUTE_NO_COMPANION,
      'not-found.tsx': CONVENTION,
      'c/not-found.tsx': CONVENTION,
      'c/$slug/$threadId.tsx': ROUTE('Thread'),
      'c/$slug/$threadId.server.ts': SERVER('thread'),
    });
    const source = createTanStackRouteSource({ routesDirectory: dir });
    source.init();
    const match = source.resolve('/c/general/abc');
    expect(match!.notFoundFilePath?.endsWith('c/not-found.tsx')).toBe(true);
  });

  it('resolves all five signal conventions, and the index form', () => {
    const dir = mkRoutes({
      '__root.tsx': ROUTE_NO_COMPANION,
      'loading.tsx': CONVENTION,
      'error.tsx': CONVENTION,
      'not-found/index.tsx': CONVENTION,
      'forbidden.tsx': CONVENTION,
      'unauthorized.tsx': CONVENTION,
      'index.tsx': ROUTE('Home'),
      'index.server.ts': SERVER('home'),
    });
    const source = createTanStackRouteSource({ routesDirectory: dir });
    source.init();
    const m = source.resolve('/')!;
    expect(m.loadingFilePath).not.toBeNull();
    expect(m.errorFilePath).not.toBeNull();
    expect(m.notFoundFilePath?.endsWith(path.join('not-found', 'index.tsx'))).toBe(true);
    expect(m.forbiddenFilePath).not.toBeNull();
    expect(m.unauthorizedFilePath).not.toBeNull();
  });

  it('stays null when the app ships no convention files, and never escapes the routes root', () => {
    const dir = mkRoutes({
      '__root.tsx': ROUTE_NO_COMPANION,
      'index.tsx': ROUTE('Home'),
      'index.server.ts': SERVER('home'),
    });
    const source = createTanStackRouteSource({ routesDirectory: dir });
    source.init();
    const m = source.resolve('/')!;
    expect(m.notFoundFilePath).toBeNull();
    expect(m.errorFilePath).toBeNull();
  });
});
