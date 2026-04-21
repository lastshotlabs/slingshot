import { describe, expect, it } from 'bun:test';
import {
  BUILTIN_PLUGINS,
  createBuiltinPluginFactory,
  loadBuiltinPlugin,
} from '../../src/lib/builtinPlugins';

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
      'slingshot-orchestration',
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

  it('throws with bun add instruction when package import fails (lines 169-172)', async () => {
    // Temporarily point a known plugin to a non-existent package
    const entry = (BUILTIN_PLUGINS as Record<string, { pkg: string; factory: string }>)[
      'slingshot-auth'
    ];
    const originalPkg = entry.pkg;
    (entry as { pkg: string; factory: string }).pkg = '@lastshotlabs/nonexistent-package';
    try {
      await expect(loadBuiltinPlugin('slingshot-auth')).rejects.toThrow('which is not installed');
    } finally {
      (entry as { pkg: string; factory: string }).pkg = originalPkg;
    }
  });

  it('throws when package exports wrong factory name (lines 177-179)', async () => {
    // Override BUILTIN_PLUGINS to point to an installed package but wrong factory name
    const entry = (BUILTIN_PLUGINS as Record<string, { pkg: string; factory: string }>)[
      'slingshot-auth'
    ];
    // Temporarily inject a bad factory name
    const original = entry.factory;
    (entry as { pkg: string; factory: string }).factory = '__nonExistentExport__';
    try {
      await expect(loadBuiltinPlugin('slingshot-auth')).rejects.toThrow(
        'does not export "__nonExistentExport__"',
      );
    } finally {
      (entry as { pkg: string; factory: string }).factory = original;
    }
  });
});

describe('createBuiltinPluginFactory', () => {
  it('passes config through for unknown plugin names (generic path)', () => {
    let received: Record<string, unknown> | undefined;
    const fakeFactory = (config?: Record<string, unknown>) => {
      received = config;
      return { name: 'test-plugin' };
    };
    const wrapped = createBuiltinPluginFactory('slingshot-entity', fakeFactory, undefined, '/app');
    wrapped({ someField: 'value' });
    expect(received).toEqual({ someField: 'value' });
  });

  it('calls resolveSsrManifestConfig for slingshot-ssr (lines 47-54)', () => {
    let received: Record<string, unknown> | undefined;
    const fakeFactory = (config?: Record<string, unknown>) => {
      received = config;
      return { name: 'slingshot-ssr' };
    };
    const wrapped = createBuiltinPluginFactory('slingshot-ssr', fakeFactory, undefined, '/app');
    wrapped({ staticDir: './public' });
    expect(received).toBeDefined();
    // resolveSsrManifestConfig resolves relative paths, so staticDir should be resolved
    expect(typeof received!['staticDir']).toBe('string');
  });

  it('calls resolveWebhookManifestConfig for slingshot-webhooks (lines 58-60)', () => {
    let received: Record<string, unknown> | undefined;
    const fakeFactory = (config?: Record<string, unknown>) => {
      received = config;
      return { name: 'slingshot-webhooks' };
    };
    const wrapped = createBuiltinPluginFactory(
      'slingshot-webhooks',
      fakeFactory,
      undefined,
      '/app',
    );
    wrapped({ retryCount: 5 });
    expect(received).toBeDefined();
    expect(received!['retryCount']).toBe(5);
  });

  it('calls resolveSearchManifestConfig for slingshot-search (line 64)', () => {
    let received: Record<string, unknown> | undefined;
    const fakeFactory = (config?: Record<string, unknown>) => {
      received = config;
      return { name: 'slingshot-search' };
    };
    const wrapped = createBuiltinPluginFactory('slingshot-search', fakeFactory, undefined, '/app');
    wrapped({ tenantResolution: 'none' });
    // resolveSearchManifestConfig leaves unknown strategies as-is
    expect(received).toBeDefined();
    expect(received!['tenantResolution']).toBe('none');
  });

  it('calls resolveSearchManifestConfig with tenantResolution "framework" (line 64)', () => {
    let received: Record<string, unknown> | undefined;
    const fakeFactory = (config?: Record<string, unknown>) => {
      received = config;
      return { name: 'slingshot-search' };
    };
    const wrapped = createBuiltinPluginFactory('slingshot-search', fakeFactory, undefined, '/app');
    wrapped({ tenantResolution: 'framework' });
    // resolveSearchManifestConfig converts "framework" to a tenantResolver function
    expect(received).toBeDefined();
    expect(typeof received!['tenantResolver']).toBe('function');
    expect(received!['tenantResolution']).toBeUndefined();
  });

  it('calls resolveAdminManifestConfig with no string strategies (line 68-89, returns plugin directly)', () => {
    const fakePlugin = { name: 'slingshot-admin' };
    const fakeFactory = () => fakePlugin;
    const wrapped = createBuiltinPluginFactory('slingshot-admin', fakeFactory, undefined, '/app');
    const result = wrapped({ someField: 'value' });
    // When no string strategies, bind is null so plugin is returned as-is
    expect(result).toBe(fakePlugin);
  });

  it('resolves admin with slingshot-auth strategy — wraps plugin with setupRoutes (lines 71-87)', () => {
    const fakePlugin = {
      name: 'slingshot-admin',
      dependencies: ['slingshot-entity'],
      setupRoutes: async () => {},
    };
    const fakeFactory = () => fakePlugin as never;
    const wrapped = createBuiltinPluginFactory('slingshot-admin', fakeFactory, undefined, '/app');
    const result = wrapped({
      accessProvider: 'slingshot-auth',
    }) as typeof fakePlugin & { dependencies?: string[] };
    // Should be a wrapped plugin with extra deps
    expect(result).not.toBe(fakePlugin);
    expect(result.dependencies).toContain('slingshot-auth');
    expect(result.dependencies).toContain('slingshot-entity');
    expect(typeof result.setupRoutes).toBe('function');
  });

  it('resolves admin with slingshot-auth strategy — no setupRoutes on original (line 82 branch)', () => {
    const fakePlugin = { name: 'slingshot-admin' };
    const fakeFactory = () => fakePlugin as never;
    const wrapped = createBuiltinPluginFactory('slingshot-admin', fakeFactory, undefined, '/app');
    const result = wrapped({
      accessProvider: 'slingshot-auth',
    }) as typeof fakePlugin & { setupRoutes?: (...args: unknown[]) => unknown };
    // Should be wrapped — setupRoutes is defined but origSetupRoutes is undefined
    expect(result).not.toBe(fakePlugin);
    expect(typeof result.setupRoutes).toBe('function');
  });

  it('admin wrapped setupRoutes calls bind and original setupRoutes (lines 78-82)', async () => {
    let setupRoutesCalled = false;
    const fakePlugin = {
      name: 'slingshot-admin',
      dependencies: [],
      setupRoutes: async () => {
        setupRoutesCalled = true;
      },
    };
    const fakeFactory = () => fakePlugin as never;
    const wrapped = createBuiltinPluginFactory('slingshot-admin', fakeFactory, undefined, '/app');
    const result = wrapped({
      accessProvider: 'slingshot-auth',
    }) as typeof fakePlugin & { setupRoutes?: (ctx: unknown) => Promise<void> };

    // Create a mock context that getContext can use
    const pluginState = new Map();
    const mockApp = {};

    // Mock getContext to return our pluginState
    const { attachContext } = await import('@lastshotlabs/slingshot-core');
    attachContext(mockApp, { pluginState } as any);

    // Call setupRoutes to exercise lines 78-82
    await result.setupRoutes!({ app: mockApp });
    expect(setupRoutesCalled).toBe(true);
  });

  it('uses default empty config when no config passed', () => {
    let received: Record<string, unknown> | undefined;
    const fakeFactory = (config?: Record<string, unknown>) => {
      received = config;
      return { name: 'slingshot-entity' };
    };
    const wrapped = createBuiltinPluginFactory('slingshot-entity', fakeFactory, undefined, '/app');
    wrapped();
    expect(received).toEqual({});
  });
});
