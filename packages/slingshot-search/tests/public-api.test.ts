import { describe, expect, test } from 'bun:test';
import * as entry from '../src/index';
import { SEARCH_CLIENT_SAFE_KEYS } from '../src/events';
import { createSearchPlugin } from '../src/plugin';
import { SEARCH_ROUTES } from '../src/routes/index';
import { createTestSearchPlugin, createTestSearchProvider } from '../src/testing';

describe('slingshot-search public api', () => {
  test('entrypoint re-exports plugin, client-safe events, and route ids', () => {
    expect(entry.createSearchPlugin).toBe(createSearchPlugin);
    expect(entry.SEARCH_CLIENT_SAFE_KEYS).toBe(SEARCH_CLIENT_SAFE_KEYS);
    expect(entry.SEARCH_ROUTES).toBe(SEARCH_ROUTES);
  });

  test('testing helpers provide a db-native provider and plugin surface', () => {
    const provider = createTestSearchProvider();
    const plugin = createTestSearchPlugin({
      disableRoutes: [SEARCH_ROUTES.ADMIN],
    });

    expect(typeof provider.connect).toBe('function');
    expect(typeof provider.teardown).toBe('function');
    expect(typeof provider.search).toBe('function');
    expect(plugin.name).toBe('slingshot-search');
    expect(typeof plugin.setupRoutes).toBe('function');
    expect(typeof plugin.setupPost).toBe('function');
  });

  test('createSearchPlugin validates adminGate adapters at construction time', () => {
    expect(() =>
      createSearchPlugin({
        providers: {
          default: { provider: 'db-native' },
        },
        adminGate: {} as never,
      }),
    ).toThrow(/verifyRequest/);
  });
});
