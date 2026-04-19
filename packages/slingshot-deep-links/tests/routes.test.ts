/**
 * Integration tests for deep-links routes.
 *
 * Tests Apple AASA, Android assetlinks, and fallback redirect routes.
 * Boots a Hono app with createDeepLinksPlugin and uses app.request().
 */
import { describe, expect, test } from 'bun:test';
import { Hono } from 'hono';
import { InProcessAdapter, attachContext } from '@lastshotlabs/slingshot-core';
import { createDeepLinksPlugin } from '../src/plugin';

const APPLE = {
  teamId: 'TEAM123456',
  bundleId: 'com.example.app',
  paths: ['/share/*', '/posts/*'],
};

const ANDROID = {
  packageName: 'com.example.app',
  sha256Fingerprints: [
    'AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99',
  ],
};

function bootApp(config: Parameters<typeof createDeepLinksPlugin>[0]): Hono {
  const app = new Hono();
  const bus = new InProcessAdapter();

  attachContext(app, {
    app,
    pluginState: new Map(),
    ws: null,
    wsEndpoints: {},
    wsPublish: null,
    bus,
  } as unknown as Parameters<typeof attachContext>[1]);

  const plugin = createDeepLinksPlugin(config);
  // Deep-links is setup-only — just call setupMiddleware + setupRoutes
  const emptyConfigRaw = {};
  const emptyConfig = emptyConfigRaw as unknown as never;
  plugin.setupMiddleware?.({ app, config: emptyConfig, bus });
  plugin.setupRoutes?.({ app, config: emptyConfig, bus });
  plugin.setupPost?.({ app, config: emptyConfig, bus });

  return app;
}

describe('Apple AASA route', () => {
  test('GET /.well-known/apple-app-site-association returns 200', async () => {
    const app = bootApp({ apple: APPLE });
    const res = await app.request('/.well-known/apple-app-site-association');
    expect(res.status).toBe(200);
  });

  test('responds with Content-Type: application/json', async () => {
    const app = bootApp({ apple: APPLE });
    const res = await app.request('/.well-known/apple-app-site-association');
    expect(res.headers.get('content-type')).toContain('application/json');
  });

  test('body has applinks.apps = [] and applinks.details', async () => {
    const app = bootApp({ apple: APPLE });
    const res = await app.request('/.well-known/apple-app-site-association');
    const body = (await res.json()) as { applinks: { apps: unknown[]; details: unknown[] } };
    expect(body.applinks.apps).toEqual([]);
    expect(Array.isArray(body.applinks.details)).toBe(true);
    expect(body.applinks.details).toHaveLength(1);
  });

  test('does not mount AASA route when apple config absent', async () => {
    const app = bootApp({
      android: ANDROID,
    });
    const res = await app.request('/.well-known/apple-app-site-association');
    expect(res.status).toBe(404);
  });

  test('multi-bundle config produces multiple details entries', async () => {
    const app = bootApp({
      apple: [
        { teamId: 'TEAM123456', bundleId: 'com.example.app', paths: ['/share/*'] },
        { teamId: 'TEAM123456', bundleId: 'com.example.clips', paths: ['/clip/*'] },
      ],
    });
    const res = await app.request('/.well-known/apple-app-site-association');
    const body = (await res.json()) as { applinks: { details: unknown[] } };
    expect(body.applinks.details).toHaveLength(2);
  });
});

describe('Android assetlinks route', () => {
  test('GET /.well-known/assetlinks.json returns 200', async () => {
    const app = bootApp({ android: ANDROID });
    const res = await app.request('/.well-known/assetlinks.json');
    expect(res.status).toBe(200);
  });

  test('responds with Content-Type: application/json', async () => {
    const app = bootApp({ android: ANDROID });
    const res = await app.request('/.well-known/assetlinks.json');
    expect(res.headers.get('content-type')).toContain('application/json');
  });

  test('body is array with delegate_permission relation', async () => {
    const app = bootApp({ android: ANDROID });
    const res = await app.request('/.well-known/assetlinks.json');
    const body = (await res.json()) as Array<{ relation: string[]; target: { namespace: string } }>;
    expect(Array.isArray(body)).toBe(true);
    expect(body[0]!.relation).toContain('delegate_permission/common.handle_all_urls');
    expect(body[0]!.target.namespace).toBe('android_app');
  });

  test('does not mount assetlinks route when android config absent', async () => {
    const app = bootApp({ apple: APPLE });
    const res = await app.request('/.well-known/assetlinks.json');
    expect(res.status).toBe(404);
  });
});

describe('Fallback redirect routes', () => {
  test('redirects /share/123 to configured target', async () => {
    const app = bootApp({
      apple: APPLE,
      fallbackBaseUrl: 'https://example.com',
      fallbackRedirects: { '/share/*': '/posts/:id' },
    });
    const res = await app.request('/share/123');
    expect([301, 302]).toContain(res.status);
    expect(res.headers.get('location')).toContain('/posts/123');
  });

  test('fallback redirect includes fallbackBaseUrl as prefix', async () => {
    const app = bootApp({
      apple: APPLE,
      fallbackBaseUrl: 'https://myapp.example.com',
      fallbackRedirects: { '/share/*': '/posts/:id' },
    });
    const res = await app.request('/share/abc');
    expect(res.headers.get('location')).toContain('https://myapp.example.com');
  });

  test('does not mount fallback when fallbackRedirects absent', async () => {
    const app = bootApp({ apple: APPLE });
    const res = await app.request('/share/123');
    // No fallback route — returns 404
    expect(res.status).toBe(404);
  });
});

describe('Public paths — no auth interference', () => {
  test('well-known paths are declared in plugin publicPaths', () => {
    const plugin = createDeepLinksPlugin({ apple: APPLE });
    expect(plugin.publicPaths).toBeDefined();
    expect(plugin.publicPaths).toContain('/.well-known/apple-app-site-association');
    expect(plugin.publicPaths).toContain('/.well-known/assetlinks.json');
  });
});
