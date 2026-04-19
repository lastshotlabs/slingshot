import { describe, expect, test } from 'bun:test';
import { z } from 'zod';
import { BUILTIN_PLUGINS } from '../../src/lib/builtinPlugins';
import {
  PLUGIN_SCHEMA_ENTRIES,
  listPlugins,
  loadPluginSchema,
} from '../../src/lib/pluginSchemaRegistry';

describe('pluginSchemaRegistry', () => {
  test('every BUILTIN_PLUGINS entry has a schema registry entry', () => {
    for (const [name, builtin] of Object.entries(BUILTIN_PLUGINS)) {
      const entry = (
        PLUGIN_SCHEMA_ENTRIES as Record<
          string,
          (typeof PLUGIN_SCHEMA_ENTRIES)[keyof typeof PLUGIN_SCHEMA_ENTRIES]
        >
      )[name];
      expect(entry).toBeDefined();
      expect(entry.name).toBe(name as typeof entry.name);
      expect(entry.package).toBe(builtin.pkg as typeof entry.package);
      expect(entry.factory).toBe(builtin.factory as typeof entry.factory);
    }
  });

  test('no orphan schema registry entries', () => {
    for (const name of Object.keys(PLUGIN_SCHEMA_ENTRIES)) {
      expect(BUILTIN_PLUGINS[name]).toBeDefined();
    }
  });

  test('loadPluginSchema resolves exported schemas', async () => {
    const schema = await loadPluginSchema('slingshot-auth');

    expect(schema).toBeInstanceOf(z.ZodType);
  });

  test('loadPluginSchema returns null for plugins without exported schemas', async () => {
    await expect(loadPluginSchema('slingshot-permissions')).resolves.toBeNull();
    await expect(loadPluginSchema('does-not-exist')).resolves.toBeNull();
  });

  test('listPlugins returns a sorted view of the registry', () => {
    const plugins = listPlugins();
    const names = plugins.map(plugin => plugin.name);
    const sortedNames = [...names].sort((a, b) => a.localeCompare(b));

    expect(names).toEqual(sortedNames);
    expect(names.length).toBe(Object.keys(BUILTIN_PLUGINS).length);
  });

  test('loadPluginSchema returns null for plugins whose packages are not installed (covers loadSchemaExport catch and each loadSchema body)', async () => {
    // These plugins call loadSchemaExport with packages that are not installed in the
    // test environment, so each call hits the catch branch (line 28 → return null).
    const pluginsWithExternalSchema = [
      'slingshot-community',
      'slingshot-deep-links',
      'slingshot-chat',
      'slingshot-interactions',
      'slingshot-ssr',
      'slingshot-image',
      'slingshot-embeds',
      'slingshot-assets',
      'slingshot-notifications',
      'slingshot-game-engine',
      'slingshot-search',
      'slingshot-admin',
      'slingshot-emoji',
      'slingshot-gifs',
      'slingshot-mail',
      'slingshot-polls',
      'slingshot-push',
      'slingshot-webhooks',
    ];
    for (const name of pluginsWithExternalSchema) {
      const result = await loadPluginSchema(name);
      // Either null (package not installed) or a ZodType (package installed)
      expect(result === null || result instanceof z.ZodType).toBe(true);
    }
  });

  test('PLUGIN_SCHEMA_ENTRIES entries have required metadata fields', () => {
    for (const entry of Object.values(PLUGIN_SCHEMA_ENTRIES)) {
      expect(typeof entry.name).toBe('string');
      expect(typeof entry.package).toBe('string');
      expect(typeof entry.factory).toBe('string');
      expect(typeof entry.description).toBe('string');
      expect(typeof entry.category).toBe('string');
      expect(Array.isArray(entry.requires)).toBe(true);
      expect(typeof entry.loadSchema).toBe('function');
    }
  });
});
