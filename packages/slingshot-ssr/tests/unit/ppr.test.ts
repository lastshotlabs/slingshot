// tests/unit/ppr.test.ts
// Unit tests for slingshot-ssr PPR build-time shell pre-renderer.
// Uses bun:test; do NOT run - the full test suite runs after all phases land.
import { describe, expect, it } from 'bun:test';
import { prerenderPprShells } from '../../src/ppr/index';
import type { PprCacheShape, PprRouteDescriptor } from '../../src/ppr/index';

type MockReactElement = PprRouteDescriptor['element'];

function makeMockCache(): PprCacheShape & { stored: Map<string, unknown> } {
  const stored = new Map<string, unknown>();
  return {
    stored,
    set(path: string, shell: { shellHtml: string; ok: boolean }): void {
      if (shell.ok) {
        stored.set(path, shell);
      }
    },
    has(path: string): boolean {
      return stored.has(path);
    },
  };
}

function makeExtractShell(
  ok = true,
): (element: MockReactElement) => Promise<{ shellHtml: string; ok: boolean }> {
  return async (_element: MockReactElement) => ({
    shellHtml: ok ? '<div>shell content</div>' : '',
    ok,
  });
}

function makeRoutes(paths: string[]): PprRouteDescriptor[] {
  return paths.map(path => ({
    path,
    element: {
      type: 'div',
      props: { children: path },
      key: null,
    } as MockReactElement,
  }));
}

describe('prerenderPprShells', () => {
  it('does nothing when routes array is empty', async () => {
    const cache = makeMockCache();
    await prerenderPprShells([], cache, makeExtractShell());
    expect(cache.stored.size).toBe(0);
  });

  it('calls extractShell once per route', async () => {
    const calls: MockReactElement[] = [];
    const extractShell = async (element: MockReactElement) => {
      calls.push(element);
      return { shellHtml: '<div>shell</div>', ok: true };
    };

    const routes = makeRoutes(['/a', '/b', '/c']);
    const cache = makeMockCache();
    await prerenderPprShells(routes, cache, extractShell);

    expect(calls.length).toBe(3);
  });

  it('stores successful shells in the cache', async () => {
    const cache = makeMockCache();
    const routes = makeRoutes(['/home', '/dashboard']);
    await prerenderPprShells(routes, cache, makeExtractShell(true));

    expect(cache.has('/home')).toBe(true);
    expect(cache.has('/dashboard')).toBe(true);
  });

  it('does not store failed shells in the cache', async () => {
    const cache = makeMockCache();
    const routes = makeRoutes(['/broken']);
    await prerenderPprShells(routes, cache, makeExtractShell(false));

    expect(cache.stored.size).toBe(0);
  });

  it('handles a mix of successful and failed shells', async () => {
    let callCount = 0;
    const extractShell = async (_element: MockReactElement) => {
      callCount++;
      const ok = callCount % 2 === 1;
      return { shellHtml: ok ? '<div>ok</div>' : '', ok };
    };

    const cache = makeMockCache();
    const routes = makeRoutes(['/a', '/b', '/c', '/d']);
    await prerenderPprShells(routes, cache, extractShell);

    expect(cache.has('/a')).toBe(true);
    expect(cache.has('/c')).toBe(true);
  });

  it('resolves without throwing when extractShell rejects for one route', async () => {
    const extractShell = async (element: MockReactElement) => {
      const props = element.props as { children?: string };
      if (String(props.children) === '/explode') {
        throw new Error('extraction failed');
      }
      return { shellHtml: '<div>ok</div>', ok: true };
    };

    const cache = makeMockCache();
    const routes = makeRoutes(['/safe', '/explode', '/also-safe']);

    await expect(prerenderPprShells(routes, cache, extractShell)).resolves.toBeUndefined();
  });

  it('processes all routes concurrently (Promise.allSettled pattern)', async () => {
    const order: string[] = [];
    const extractShell = async (element: MockReactElement) => {
      const props = element.props as { children?: string };
      const path = String(props.children ?? '?');
      order.push(path);
      return { shellHtml: '<div>shell</div>', ok: true };
    };

    const routes = makeRoutes(['/one', '/two', '/three']);
    const cache = makeMockCache();
    await prerenderPprShells(routes, cache, extractShell);

    expect(order.length).toBe(3);
    expect(order).toContain('/one');
    expect(order).toContain('/two');
    expect(order).toContain('/three');
  });
});
