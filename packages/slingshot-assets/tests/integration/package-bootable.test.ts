/**
 * JSON-bootability test for slingshot-assets.
 *
 * Verifies that the package can be instantiated from a JSON-serializable
 * config object — no function references, no class instances — so
 * config-driven bootstrap succeeds for any tooling that loads package
 * configs from a serialized blob.
 */
import { describe, expect, test } from 'bun:test';
import { createAssetsPackage } from '../../src/plugin';
import type { AssetsPluginConfig } from '../../src/types';

describe('slingshot-assets package bootability', () => {
  const config: AssetsPluginConfig = {
    storage: { adapter: 'memory' },
  };

  test('createAssetsPackage returns a package object without errors', () => {
    const pkg = createAssetsPackage(config);
    expect(pkg).toBeDefined();
    expect(typeof pkg).toBe('object');
  });

  test('pkg.name is slingshot-assets', () => {
    const pkg = createAssetsPackage(config);
    expect(pkg.name).toBe('slingshot-assets');
  });

  test('config survives JSON round-trip (no function references)', () => {
    const roundTripped = JSON.parse(JSON.stringify(config)) as AssetsPluginConfig;
    expect(roundTripped).toEqual(config);
  });

  test('pkg.dependencies includes auth and permissions', () => {
    const pkg = createAssetsPackage(config);
    // slingshot-assets depends on slingshot-auth and slingshot-permissions.
    expect(pkg.dependencies).toBeDefined();
    expect(pkg.dependencies).toContain('slingshot-auth');
    expect(pkg.dependencies).toContain('slingshot-permissions');
  });

  test('rejects mountPath values without a leading slash', () => {
    expect(() =>
      createAssetsPackage({
        storage: { adapter: 'memory' },
        mountPath: 'assets',
      } as AssetsPluginConfig),
    ).toThrow(/mountPath must start with '\//i);
  });
});

describe('slingshot-assets image cache fallback', () => {
  test('logs warning when image.cache is not a valid ImageCacheAdapter', () => {
    const warnings: string[] = [];
    const logger = {
      debug() {},
      info() {},
      warn(msg: string) {
        warnings.push(msg);
      },
      error() {},
      child() {
        return logger;
      },
    };
    createAssetsPackage(
      {
        storage: { adapter: 'memory' },
        image: { cache: { notAnAdapter: true } as unknown },
      } as AssetsPluginConfig,
      { logger },
    );

    expect(
      warnings.some(m =>
        m.includes('[slingshot-assets] image.cache is not a valid ImageCacheAdapter'),
      ),
    ).toBe(true);
    expect(warnings.some(m => m.includes('falling back to in-memory cache'))).toBe(true);
  });

  test('does not warn when image.cache is a valid ImageCacheAdapter', () => {
    const warnings: string[] = [];
    const logger = {
      debug() {},
      info() {},
      warn(msg: string) {
        warnings.push(msg);
      },
      error() {},
      child() {
        return logger;
      },
    };
    createAssetsPackage(
      {
        storage: { adapter: 'memory' },
        image: {
          cache: {
            async get() {
              return null;
            },
            async set() {},
          },
        },
      } as AssetsPluginConfig,
      { logger },
    );

    expect(warnings.some(m => m.includes('[slingshot-assets] image.cache'))).toBe(false);
  });

  test('does not warn when image is configured but cache is omitted', () => {
    const warnings: string[] = [];
    const logger = {
      debug() {},
      info() {},
      warn(msg: string) {
        warnings.push(msg);
      },
      error() {},
      child() {
        return logger;
      },
    };
    createAssetsPackage(
      {
        storage: { adapter: 'memory' },
        image: { maxWidth: 800, maxHeight: 600 },
      } as AssetsPluginConfig,
      { logger },
    );

    expect(warnings.some(m => m.includes('[slingshot-assets] image.cache'))).toBe(false);
  });
});
