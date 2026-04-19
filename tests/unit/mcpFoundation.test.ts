import { describe, expect, test } from 'bun:test';
import { createMcpFoundation } from '../../src/lib/mcpFoundation';

describe('mcpFoundation', () => {
  test('lists built-in plugins as stable summaries', () => {
    const foundation = createMcpFoundation();
    const plugins = foundation.listPlugins();
    const names = plugins.map(plugin => plugin.name);

    expect(names).toContain('slingshot-auth');
    expect(names).toContain('slingshot-ssr');
    expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b)));
  });

  test('returns plugin metadata by name', () => {
    const foundation = createMcpFoundation();
    const plugin = foundation.getPlugin('slingshot-auth');

    expect(plugin).not.toBeNull();
    expect(plugin?.package).toBe('@lastshotlabs/slingshot-auth');
    expect(plugin?.factory).toBe('createAuthPlugin');
  });

  test('creates fresh manifest registries', () => {
    const foundation = createMcpFoundation();
    const first = foundation.createRegistry();
    const second = foundation.createRegistry();

    first.registerHandler('example', () => 'first');

    expect(first.hasHandler('example')).toBe(true);
    expect(second.hasHandler('example')).toBe(false);
  });

  test('validates manifest input', () => {
    const foundation = createMcpFoundation();
    const result = foundation.validateManifest({
      manifestVersion: 1,
      routesDir: '/app/src/routes',
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.manifest.routesDir).toBe('/app/src/routes');
    }
  });

  test('returns validation errors for invalid manifests', () => {
    const foundation = createMcpFoundation();
    const result = foundation.validateManifest({
      manifestVersion: 99,
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.errors.some(error => error.includes('manifestVersion'))).toBe(true);
    }
  });

  test('generates runtime config from a valid manifest', () => {
    const foundation = createMcpFoundation({
      baseDir: process.platform === 'win32' ? 'C:\\workspace' : '/workspace',
    });
    const result = foundation.generateConfig({
      manifestVersion: 1,
      routesDir: '${importMetaDir}/routes',
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.config.routesDir).toContain('routes');
      expect(result.manifest.routesDir).toBe('${importMetaDir}/routes');
    }
  });

  test('loads plugin schemas when a built-in schema is exported', async () => {
    const foundation = createMcpFoundation();
    const schema = await foundation.getPluginSchema('slingshot-auth');

    expect(schema).not.toBeNull();
  });

  test('generateConfig returns validation error for invalid manifest', () => {
    const foundation = createMcpFoundation();
    // Invalid manifest (missing required routesDir, wrong manifestVersion) triggers
    // the early-return validation-failure path inside generateConfig.
    const result = foundation.generateConfig({ manifestVersion: 99 });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.errors.length).toBeGreaterThan(0);
    }
  });

  test('getPlugin returns null for an unknown plugin name', () => {
    const foundation = createMcpFoundation();
    expect(foundation.getPlugin('non-existent-plugin-xyz')).toBeNull();
  });
});
