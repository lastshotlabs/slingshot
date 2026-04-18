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
});
