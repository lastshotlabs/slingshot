import { describe, expect, test } from 'bun:test';
import { getSlingshotCtx } from '@lastshotlabs/slingshot-core';
import { createRouter } from '@lastshotlabs/slingshot-core';
import { createApp } from '../../src/app';

const baseConfig = {
  routesDir: import.meta.dir + '/../fixtures/routes',
  db: {
    mongo: false as const,
    redis: false,
    sessions: 'memory' as const,
    cache: 'memory' as const,
    auth: 'memory' as const,
  },
  security: { rateLimit: { windowMs: 60_000, max: 100 } },
  logging: { onLog: () => {} },
};

describe('SlingshotContext middleware', () => {
  test("c.get('slingshotCtx') returns the SlingshotContext in a route handler", async () => {
    const { app, ctx } = await createApp(baseConfig);

    // Add a test route that reads the context
    const router = createRouter();
    router.get('/test-ctx', c => {
      const slingshotCtx = c.get('slingshotCtx');
      return c.json({ hasCtx: !!slingshotCtx, hasConfig: !!slingshotCtx?.config });
    });
    app.route('/', router);

    const res = await app.request('/test-ctx');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.hasCtx).toBe(true);
    expect(body.hasConfig).toBe(true);
  });

  test('getSlingshotCtx(c) returns the same context as createApp', async () => {
    const { app, ctx } = await createApp(baseConfig);

    let capturedCtx: unknown = null;
    const router = createRouter();
    router.get('/test-helper', c => {
      capturedCtx = getSlingshotCtx(c);
      return c.json({ ok: true });
    });
    app.route('/', router);

    const res = await app.request('/test-helper');
    expect(res.status).toBe(200);
    expect(capturedCtx).toBe(ctx);
  });

  test('slingshotCtx exposes resolved config properties', async () => {
    const { app } = await createApp(baseConfig);

    let stores: unknown = null;
    const router = createRouter();
    router.get('/test-config', c => {
      const slingshotCtx = getSlingshotCtx(c);
      stores = slingshotCtx.config.resolvedStores;
      return c.json({ ok: true });
    });
    app.route('/', router);

    const res = await app.request('/test-config');
    expect(res.status).toBe(200);
    expect(stores).toEqual({
      sessions: 'memory',
      oauthState: 'memory',
      cache: 'memory',
      authStore: 'memory',
      sqlite: undefined,
    });
  });
});
