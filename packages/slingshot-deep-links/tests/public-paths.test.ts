/**
 * Tests that the deep-links plugin's well-known routes are declared as public
 * paths, so auth middleware skips them.
 *
 * Uses a minimal auth-guard middleware that mirrors exactly what
 * slingshot-auth's bearerAuth middleware does: calls isPublicPath() against
 * ctx.publicPaths and returns 401 for non-public routes.
 */
import { describe, expect, test } from 'bun:test';
import { Hono } from 'hono';
import { InProcessAdapter, attachContext, isPublicPath } from '@lastshotlabs/slingshot-core';
import { createDeepLinksPlugin } from '../src/plugin';
import { ANDROID_ASSETLINKS_PATH, APPLE_AASA_PATH } from '../src/routes';

const APPLE = {
  teamId: 'TEAM123456',
  bundleId: 'com.example.app',
  paths: ['/share/*'],
};

const ANDROID = {
  packageName: 'com.example.app',
  sha256Fingerprints: [
    'AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99',
  ],
};

/**
 * Boot the app with the deep-links plugin AND a minimal auth-guard middleware
 * that blocks all routes lacking a valid `Authorization` header, except those
 * declared in `ctx.publicPaths`.
 */
function bootWithAuthGuard(): Hono {
  const plugin = createDeepLinksPlugin({ apple: APPLE, android: ANDROID });
  const publicPaths = new Set(plugin.publicPaths ?? []);

  const app = new Hono();
  const bus = new InProcessAdapter();

  attachContext(app, {
    app,
    pluginState: new Map(),
    publicPaths,
    ws: null,
    wsEndpoints: {},
    wsPublish: null,
    bus,
  } as unknown as Parameters<typeof attachContext>[1]);

  // Minimal auth-guard — same pattern as slingshot-auth's bearer middleware.
  app.use('*', async (c, next) => {
    if (isPublicPath(c.req.path, publicPaths)) {
      return next();
    }
    const auth = c.req.header('authorization');
    if (!auth) {
      return c.json({ error: 'Unauthorized' }, 401);
    }
    return next();
  });

  // A protected route that requires auth.
  app.get('/api/protected', c => c.json({ data: 'secret' }));

  plugin.setupMiddleware?.({ app, config: {} as never, bus });
  plugin.setupRoutes?.({ app, config: {} as never, bus });
  plugin.setupPost?.({ app, config: {} as never, bus });

  return app;
}

describe('publicPaths declaration', () => {
  test('plugin declares APPLE_AASA_PATH in publicPaths', () => {
    const plugin = createDeepLinksPlugin({ apple: APPLE });
    expect(plugin.publicPaths).toBeDefined();
    expect(plugin.publicPaths).toContain(APPLE_AASA_PATH);
  });

  test('plugin declares ANDROID_ASSETLINKS_PATH in publicPaths', () => {
    const plugin = createDeepLinksPlugin({ android: ANDROID });
    expect(plugin.publicPaths).toBeDefined();
    expect(plugin.publicPaths).toContain(ANDROID_ASSETLINKS_PATH);
  });

  test('publicPaths contains exactly the two well-known paths', () => {
    const plugin = createDeepLinksPlugin({ apple: APPLE, android: ANDROID });
    expect(plugin.publicPaths).toHaveLength(2);
    expect(plugin.publicPaths).toContain('/.well-known/apple-app-site-association');
    expect(plugin.publicPaths).toContain('/.well-known/assetlinks.json');
  });
});

describe('isPublicPath primitive with plugin paths', () => {
  test('AASA path is recognised as public', () => {
    const plugin = createDeepLinksPlugin({ apple: APPLE });
    const paths = new Set(plugin.publicPaths ?? []);
    expect(isPublicPath(APPLE_AASA_PATH, paths)).toBe(true);
  });

  test('assetlinks path is recognised as public', () => {
    const plugin = createDeepLinksPlugin({ android: ANDROID });
    const paths = new Set(plugin.publicPaths ?? []);
    expect(isPublicPath(ANDROID_ASSETLINKS_PATH, paths)).toBe(true);
  });

  test('normal API route is NOT public', () => {
    const plugin = createDeepLinksPlugin({ apple: APPLE });
    const paths = new Set(plugin.publicPaths ?? []);
    expect(isPublicPath('/api/protected', paths)).toBe(false);
  });
});

describe('Auth guard integration — unauthenticated requests', () => {
  test('protected route without auth returns 401', async () => {
    const app = bootWithAuthGuard();
    const res = await app.request('/api/protected');
    expect(res.status).toBe(401);
  });

  test('protected route with auth header returns 200', async () => {
    const app = bootWithAuthGuard();
    const res = await app.request('/api/protected', {
      headers: { authorization: 'Bearer test-token' },
    });
    expect(res.status).toBe(200);
  });

  test('/.well-known/apple-app-site-association returns 200 without auth', async () => {
    const app = bootWithAuthGuard();
    const res = await app.request('/.well-known/apple-app-site-association');
    expect(res.status).toBe(200);
  });

  test('/.well-known/assetlinks.json returns 200 without auth', async () => {
    const app = bootWithAuthGuard();
    const res = await app.request('/.well-known/assetlinks.json');
    expect(res.status).toBe(200);
  });

  test('AASA response has correct content-type without auth', async () => {
    const app = bootWithAuthGuard();
    const res = await app.request('/.well-known/apple-app-site-association');
    expect(res.headers.get('content-type')).toContain('application/json');
  });

  test('assetlinks response has correct content-type without auth', async () => {
    const app = bootWithAuthGuard();
    const res = await app.request('/.well-known/assetlinks.json');
    expect(res.headers.get('content-type')).toContain('application/json');
  });
});
