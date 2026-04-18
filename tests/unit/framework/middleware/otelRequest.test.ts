import { trace } from '@opentelemetry/api';
import { describe, expect, test } from 'bun:test';
import { Hono } from 'hono';
import type { AppEnv } from '@lastshotlabs/slingshot-core';
import { otelRequestMiddleware } from '../../../../src/framework/middleware/otelRequest';
import { requestId } from '../../../../src/framework/middleware/requestId';

function createApp() {
  const app = new Hono<AppEnv>();
  const tracer = trace.getTracer('test');

  app.use(requestId);
  app.use(otelRequestMiddleware({ tracer }));

  return { app, tracer };
}

describe('otelRequestMiddleware', () => {
  test('sets otelSpan on context when tracing is enabled', async () => {
    const { app } = createApp();
    let hasSpan = false;

    app.get('/test', c => {
      hasSpan = c.get('otelSpan') !== undefined;
      return c.json({ ok: true });
    });

    await app.request('/test');
    expect(hasSpan).toBe(true);
  });

  test('span has correct http.method attribute', async () => {
    const { app } = createApp();
    let spanExists = false;

    app.post('/api/users', c => {
      const span = c.get('otelSpan');
      spanExists = span !== undefined;
      return c.json({ created: true }, 201);
    });

    const res = await app.request('/api/users', { method: 'POST' });
    expect(res.status).toBe(201);
    expect(spanExists).toBe(true);
  });

  test('returns 200 for successful requests', async () => {
    const { app } = createApp();
    app.get('/health', c => c.json({ ok: true }));

    const res = await app.request('/health');
    expect(res.status).toBe(200);
  });

  test('returns error status for failing requests', async () => {
    const { app } = createApp();
    app.get('/fail', () => {
      throw new Error('handler error');
    });

    app.onError((_err, c) => c.json({ error: 'failed' }, 500));

    const res = await app.request('/fail');
    expect(res.status).toBe(500);
  });

  test('otelSpan is undefined when middleware is not mounted', async () => {
    const app = new Hono<AppEnv>();
    let spanValue: unknown = 'not-checked';

    app.use(requestId);
    app.get('/test', c => {
      spanValue = c.get('otelSpan');
      return c.json({ ok: true });
    });

    await app.request('/test');
    expect(spanValue).toBeUndefined();
  });
});
