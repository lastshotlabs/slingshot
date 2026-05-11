import { describe, expect, test } from 'bun:test';
import * as entry from '../src/index';
import { createSearchPackage } from '../src/plugin';
import { SEARCH_ROUTES } from '../src/routes/index';
import { createTestSearchPackage, createTestSearchProvider } from '../src/testing';
import { searchPluginConfigSchema } from '../src/types/config';

describe('slingshot-search public api', () => {
  test('entrypoint re-exports plugin and route ids', () => {
    expect(entry.createSearchPackage).toBe(createSearchPackage);
    expect(entry.SEARCH_ROUTES).toBe(SEARCH_ROUTES);
  });

  test('testing helpers provide a db-native provider and plugin surface', () => {
    const provider = createTestSearchProvider();
    const pkg = createTestSearchPackage({
      disableRoutes: [SEARCH_ROUTES.ADMIN],
    });

    expect(typeof provider.connect).toBe('function');
    expect(typeof provider.teardown).toBe('function');
    expect(typeof provider.search).toBe('function');
    expect(pkg.kind).toBe('package');
    expect(pkg.name).toBe('slingshot-search');
    expect(typeof pkg.setupRoutes).toBe('function');
    expect(typeof pkg.setupPost).toBe('function');
  });

  test('createSearchPackage validates adminGate adapters at construction time', () => {
    expect(() =>
      createSearchPackage({
        providers: {
          default: { provider: 'db-native' },
        },
        adminGate: {} as never,
      }),
    ).toThrow(/verifyRequest/);
  });

  test('createSearchPackage rejects mountPath values without a leading slash', () => {
    expect(() =>
      createSearchPackage({
        providers: {
          default: { provider: 'db-native' },
        },
        mountPath: 'search',
      }),
    ).toThrow(/mountPath must start with '\//i);
  });

  test('searchPluginConfigSchema normalizes and rejects unsafe mount paths', () => {
    expect(
      searchPluginConfigSchema.parse({
        providers: { default: { provider: 'db-native' } },
        mountPath: ' /tenant-search/// ',
      }).mountPath,
    ).toBe('/tenant-search');

    expect(() =>
      searchPluginConfigSchema.parse({
        providers: { default: { provider: 'db-native' } },
        mountPath: '/',
      }),
    ).toThrow(/mountPath must not be '\//i);
  });
});
