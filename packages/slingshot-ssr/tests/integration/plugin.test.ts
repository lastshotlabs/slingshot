import { describe, expect, it } from 'bun:test';
import type { AppEnv } from '@lastshotlabs/slingshot-core';
import { ssrPluginConfigSchema } from '../../src/config.schema';
import { createSsrPlugin } from '../../src/plugin';
import { createTestSsrConfig } from '../../src/testing';

describe('createSsrPlugin', () => {
  it('returns a SlingshotPlugin with name slingshot-ssr', () => {
    const plugin = createSsrPlugin(createTestSsrConfig());
    expect(plugin.name).toBe('slingshot-ssr');
  });

  it('has setupMiddleware lifecycle method', () => {
    const plugin = createSsrPlugin(createTestSsrConfig());
    expect(typeof plugin.setupMiddleware).toBe('function');
  });

  it('registers route and middleware lifecycle methods', () => {
    const plugin = createSsrPlugin(createTestSsrConfig());
    expect(typeof plugin.setupRoutes).toBe('function');
    expect(typeof plugin.setupPost).toBe('function');
  });
});

describe('createSsrPlugin — config validation', () => {
  it('throws ZodError when serverRoutesDir is missing', () => {
    expect(() => createSsrPlugin(createTestSsrConfig({ serverRoutesDir: '' }))).toThrow();
  });

  it('throws ZodError when assetsManifest is missing', () => {
    expect(() => createSsrPlugin(createTestSsrConfig({ assetsManifest: '' }))).toThrow();
  });

  it('throws ZodError when renderer is not an object', () => {
    expect(() =>
      createSsrPlugin({
        renderer: 'not-an-object' as never,
        serverRoutesDir: '/fake/routes',
        assetsManifest: '/fake/manifest.json',
        devMode: true,
      }),
    ).toThrow();
  });
});

describe('ssrPluginConfigSchema', () => {
  it('accepts valid config shape', () => {
    const result = ssrPluginConfigSchema.safeParse({
      renderer: { resolve: () => {}, render: () => {}, renderChain: () => {} },
      serverRoutesDir: '/app/server/routes',
      assetsManifest: '/app/dist/.vite/manifest.json',
      devMode: true,
    });
    expect(result.success).toBe(true);
  });

  it('rejects empty serverRoutesDir', () => {
    const result = ssrPluginConfigSchema.safeParse({
      renderer: { resolve: () => {}, render: () => {}, renderChain: () => {} },
      serverRoutesDir: '',
      assetsManifest: '/app/dist/.vite/manifest.json',
    });
    expect(result.success).toBe(false);
  });

  it('accepts optional fields', () => {
    const result = ssrPluginConfigSchema.safeParse({
      renderer: { resolve: () => {}, render: () => {}, renderChain: () => {} },
      serverRoutesDir: '/routes',
      assetsManifest: '/manifest.json',
      entryPoint: 'app.html',
      cacheControl: { default: 'no-store', routes: { '/': 'public, max-age=300' } },
      exclude: ['/admin', '/webhooks'],
      devMode: false,
    });
    expect(result.success).toBe(true);
  });

  it('rejects relative serverRoutesDir', () => {
    const result = ssrPluginConfigSchema.safeParse({
      renderer: { resolve: () => {}, render: () => {}, renderChain: () => {} },
      serverRoutesDir: 'server/routes',
      assetsManifest: '/manifest.json',
    });
    expect(result.success).toBe(false);
    expect(JSON.stringify(result.error?.issues)).toMatch(/absolute/i);
  });

  it('rejects relative serverActionsDir', () => {
    const result = ssrPluginConfigSchema.safeParse({
      renderer: { resolve: () => {}, render: () => {}, renderChain: () => {} },
      serverRoutesDir: '/routes',
      assetsManifest: '/manifest.json',
      serverActionsDir: 'server/actions',
    });
    expect(result.success).toBe(false);
    expect(JSON.stringify(result.error?.issues)).toMatch(/absolute/i);
  });

  it('rejects bare-hostname trustedOrigins', () => {
    const result = ssrPluginConfigSchema.safeParse({
      renderer: { resolve: () => {}, render: () => {}, renderChain: () => {} },
      serverRoutesDir: '/routes',
      assetsManifest: '/manifest.json',
      trustedOrigins: ['example.com'],
    });
    expect(result.success).toBe(false);
    expect(JSON.stringify(result.error?.issues)).toMatch(/origin/i);
  });

  it('accepts full HTTP/HTTPS origins in trustedOrigins', () => {
    const result = ssrPluginConfigSchema.safeParse({
      renderer: { resolve: () => {}, render: () => {}, renderChain: () => {} },
      serverRoutesDir: '/routes',
      assetsManifest: '/manifest.json',
      trustedOrigins: ['https://app.example.com', 'http://localhost:3001'],
    });
    expect(result.success).toBe(true);
  });
});

describe('createSsrPlugin — production mode manifest check', () => {
  it('throws at setupMiddleware time when manifest is missing in production', async () => {
    const plugin = createSsrPlugin(
      createTestSsrConfig({
        assetsManifest: '/nonexistent/manifest.json',
        devMode: false,
      }),
    );

    const { Hono } = await import('hono');
    const app = new Hono() as unknown as import('hono').Hono<AppEnv>;

    const mockBus = {
      on: () => {},
      emit: () => {},
      drain: async () => {},
    };

    expect(() =>
      plugin.setupMiddleware!({
        app,
        bus: mockBus as any,
        events: mockBus as any,
        config: {} as any,
      }),
    ).toThrow('[slingshot-ssr]');
  });

  it('does NOT throw at setupMiddleware time in dev mode', async () => {
    const plugin = createSsrPlugin(
      createTestSsrConfig({
        assetsManifest: '/nonexistent/manifest.json',
        devMode: true,
      }),
    );

    const { Hono } = await import('hono');
    const app = new Hono() as unknown as import('hono').Hono<AppEnv>;

    const mockBus = {
      on: () => {},
      emit: () => {},
      drain: async () => {},
    };

    expect(() =>
      plugin.setupMiddleware!({
        app,
        bus: mockBus as any,
        events: mockBus as any,
        config: {} as any,
      }),
    ).not.toThrow();
  });
});
