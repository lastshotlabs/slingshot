/**
 * Manifest-bootability test for slingshot-assets.
 *
 * Verifies that the plugin can be instantiated from a JSON-serializable
 * config object — no function references, no class instances — so
 * manifest-mode bootstrap succeeds.
 */
import { describe, expect, test } from 'bun:test';
import { createAssetsPlugin } from '../../src/plugin';
import type { AssetsPluginConfig } from '../../src/types';

describe('slingshot-assets manifest bootability', () => {
  const config: AssetsPluginConfig = {
    storage: { adapter: 'memory' },
  };

  test('createAssetsPlugin returns a plugin object without errors', () => {
    const plugin = createAssetsPlugin(config);
    expect(plugin).toBeDefined();
    expect(typeof plugin).toBe('object');
  });

  test('plugin.name is slingshot-assets', () => {
    const plugin = createAssetsPlugin(config);
    expect(plugin.name).toBe('slingshot-assets');
  });

  test('config survives JSON round-trip (no function references)', () => {
    const roundTripped = JSON.parse(JSON.stringify(config)) as AssetsPluginConfig;
    expect(roundTripped).toEqual(config);
  });

  test('plugin.dependencies includes slingshot-entity dependency chain', () => {
    const plugin = createAssetsPlugin(config);
    // slingshot-assets depends on slingshot-auth and slingshot-permissions,
    // which transitively require slingshot-entity via the schema registry.
    expect(plugin.dependencies).toBeDefined();
    expect(plugin.dependencies).toContain('slingshot-auth');
    expect(plugin.dependencies).toContain('slingshot-permissions');
  });

  test('rejects mountPath values without a leading slash', () => {
    expect(() =>
      createAssetsPlugin({
        storage: { adapter: 'memory' },
        mountPath: 'assets',
      } as AssetsPluginConfig),
    ).toThrow(/mountPath must start with '\//i);
  });
});
