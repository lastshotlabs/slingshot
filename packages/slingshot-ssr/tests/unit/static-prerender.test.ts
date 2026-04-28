import { describe, expect, mock, test } from 'bun:test';
import type { StaticRoute } from '../../src/static-params/index';
import {
  buildConcreteUrl,
  createPrerenderedCache,
  getPrerenderedHtml,
  prerenderStaticRoutes,
} from '../../src/static-params/prerender';

describe('static route prerendering', () => {
  test('creates isolated caches with immutable entry snapshots', () => {
    const first = createPrerenderedCache();
    const second = createPrerenderedCache();

    first.set('/posts/1', '<html>one</html>');

    expect(first.get('/posts/1')).toBe('<html>one</html>');
    expect(second.get('/posts/1')).toBeUndefined();
    expect(first.entries()).toEqual([{ path: '/posts/1', html: '<html>one</html>' }]);
    expect(Object.isFrozen(first.entries()[0])).toBe(true);
  });

  test('builds concrete paths from dynamic and catch-all params', () => {
    expect(buildConcreteUrl('/posts/[id]', { id: 'hello world' })).toBe('/posts/hello%20world');
    expect(buildConcreteUrl('/docs/[...slug]', { slug: 'guide/setup' })).toBe('/docs/guide/setup');
  });

  test('renders static routes into the provided cache and skips failed paths', async () => {
    const cache = createPrerenderedCache();
    const manifest: StaticRoute[] = [
      {
        routePath: '/posts/[id]',
        filePath: '/tmp/posts/[id]/page.ts',
        paramSets: [{ id: '1' }, { id: '2' }],
      },
    ];
    const renderer = mock(async (path: string) => {
      if (path === '/posts/2') {
        throw new Error('render failed');
      }
      return `<html>${path}</html>`;
    });
    const originalWarn = console.warn;
    console.warn = mock(() => {});

    try {
      await prerenderStaticRoutes(manifest, renderer, cache);
    } finally {
      console.warn = originalWarn;
    }

    expect(renderer).toHaveBeenCalledTimes(2);
    expect(getPrerenderedHtml(cache, '/posts/1')).toBe('<html>/posts/1</html>');
    expect(getPrerenderedHtml(cache, '/posts/2')).toBeUndefined();
  });
});
