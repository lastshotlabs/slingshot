import { describe, expect, it, beforeEach } from 'bun:test';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
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
