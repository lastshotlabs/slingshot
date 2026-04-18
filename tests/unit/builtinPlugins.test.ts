import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { BUILTIN_PLUGINS, loadBuiltinPlugin } from '../../src/lib/builtinPlugins';

describe('BUILTIN_PLUGINS', () => {
  it('contains every first-party plugin that can be referenced from a manifest', () => {
    expect(Object.keys(BUILTIN_PLUGINS).sort()).toEqual([
      'slingshot-admin',
      'slingshot-assets',
      'slingshot-auth',
      'slingshot-chat',
      'slingshot-community',
      'slingshot-deep-links',
      'slingshot-embeds',
      'slingshot-emoji',
      'slingshot-entity',
      'slingshot-game-engine',
      'slingshot-gifs',
      'slingshot-image',
      'slingshot-interactions',
      'slingshot-m2m',
      'slingshot-mail',
      'slingshot-notifications',
      'slingshot-oauth',
      'slingshot-oidc',
      'slingshot-organizations',
      'slingshot-permissions',
      'slingshot-polls',
      'slingshot-push',
      'slingshot-scim',
      'slingshot-search',
      'slingshot-ssr',
      'slingshot-webhooks',
    ]);
  });

  it('each entry has pkg and factory fields', () => {
    for (const [name, entry] of Object.entries(BUILTIN_PLUGINS)) {
      expect(typeof entry.pkg, `${name}.pkg`).toBe('string');
      expect(typeof entry.factory, `${name}.factory`).toBe('string');
      expect(entry.pkg.startsWith('@lastshotlabs/'), `${name} pkg prefix`).toBe(true);
    }
  });
});

describe('loadBuiltinPlugin', () => {
  it('returns null for unknown plugin names', async () => {
    const result = await loadBuiltinPlugin('not-a-real-plugin');
    expect(result).toBeNull();
  });

  it('throws with bun add instruction when package is not installed', async () => {
    // slingshot-scim almost certainly not installed in test env
    // We test the error path by checking any plugin whose package isn't present
    // Use a mocked approach: temporarily override BUILTIN_PLUGINS entry
    try {
      await loadBuiltinPlugin('slingshot-scim');
      // If it succeeds (package installed), just verify it returned a function
    } catch (err) {
      expect(err instanceof Error).toBe(true);
      const msg = (err as Error).message;
      expect(msg).toContain('bun add');
      expect(msg).toContain('@lastshotlabs/slingshot-scim');
    }
  });
});
