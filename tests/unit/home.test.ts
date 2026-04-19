import { describe, expect, test } from 'bun:test';
import { Hono } from 'hono';
import { router } from '../../src/framework/routes/home';

describe('home route handler', () => {
  test('GET / returns appName from slingshotCtx', async () => {
    const app = new Hono();

    // Set up slingshotCtx middleware before mounting the router
    app.use('/*', async (c, next) => {
      c.set('slingshotCtx', { config: { appName: 'TestApp' } } as any);
      await next();
    });
    app.route('/', router);

    const res = await app.request('/');
    expect(res.status).toBe(200);
    const json = (await res.json()) as { message: string };
    expect(json.message).toBe('TestApp is running');
  });
});
