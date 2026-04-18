import { describe, expect, test } from 'bun:test';
import { createHmac } from 'crypto';
import { Hono } from 'hono';
import { HttpError, attachContext } from '@lastshotlabs/slingshot-core';
import type { SlingshotContext } from '@lastshotlabs/slingshot-core';
import { requireSignedRequest } from '../../src/framework/middleware/requestSigning';

const SECRET = 'test-signing-secret-32-chars-xxxxx';

function buildCanonical(
  method: string,
  path: string,
  query: string,
  timestamp: string,
  body: string,
): string {
  return `${method}\n${path}\n${query}\n${timestamp}\n${body}`;
}

function sign(canonical: string): string {
  return createHmac('sha256', SECRET).update(canonical).digest('hex');
}

function createMinimalContext(app: object, signing: unknown): void {
  const ctx = {
    app,
    config: {
      appName: 'test',
      resolvedStores: {
        sessions: 'memory',
        oauthState: 'memory',
        cache: 'memory',
        authStore: 'memory',
        sqlite: undefined,
      },
      security: { cors: '*' },
      signing,
      dataEncryptionKeys: [],
      redis: undefined,
      mongo: undefined,
      captcha: null,
    },
    redis: null,
    mongo: null,
    sqlite: null,
    signing,
    dataEncryptionKeys: [],
    ws: null,
    persistence: null as any,
    pluginState: new Map(),
    async clear() {},
    async destroy() {},
  } as unknown as SlingshotContext;
  attachContext(app, ctx);
}

function buildApp(signing: unknown = { requestSigning: { tolerance: 300_000 }, secret: SECRET }) {
  const app = new Hono();
  createMinimalContext(app, signing);
  app.use(async (c, next) => {
    const { getContext } = await import('@lastshotlabs/slingshot-core');
    (c as any).set('slingshotCtx', getContext(app));
    await next();
  });
  app.onError((err, c) => {
    if (err instanceof HttpError) {
      const body: Record<string, unknown> = { error: err.message };
      if (err.code !== undefined) body.code = err.code;
      return c.json(body, err.status as 400 | 401 | 403 | 404 | 409 | 418 | 429 | 500);
    }
    return c.json({ error: 'Internal Server Error' }, 500);
  });
  app.use('/*', requireSignedRequest());
  app.post('/data', async c => {
    return c.json({ ok: true });
  });
  return app;
}

describe('requireSignedRequest', () => {
  test('valid signature passes', async () => {
    const app = buildApp();
    const timestamp = String(Math.floor(Date.now() / 1000));
    const body = JSON.stringify({ hello: 'world' });
    const canonical = buildCanonical('POST', '/data', '', timestamp, body);
    const sig = sign(canonical);

    const res = await app.request('/data', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-signature': sig,
        'x-timestamp': timestamp,
      },
      body,
    });
    expect(res.status).toBe(200);
  });

  test('tampered body returns 401 INVALID_SIGNATURE', async () => {
    const app = buildApp();
    const timestamp = String(Math.floor(Date.now() / 1000));
    const body = JSON.stringify({ hello: 'world' });
    const canonical = buildCanonical('POST', '/data', '', timestamp, body);
    const sig = sign(canonical);

    const res = await app.request('/data', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-signature': sig,
        'x-timestamp': timestamp,
      },
      body: JSON.stringify({ hello: 'TAMPERED' }), // different body
    });
    expect(res.status).toBe(401);
    const json = await res.json();
    expect(json.code).toBe('INVALID_SIGNATURE');
  });

  test('expired timestamp returns 401 EXPIRED_TIMESTAMP', async () => {
    const app = buildApp();
    const oldTimestamp = String(Math.floor((Date.now() - 600_000) / 1000)); // 10 min ago
    const body = '';
    const canonical = buildCanonical('POST', '/data', '', oldTimestamp, body);
    const sig = sign(canonical);

    const res = await app.request('/data', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-signature': sig,
        'x-timestamp': oldTimestamp,
      },
      body,
    });
    expect(res.status).toBe(401);
    const json = await res.json();
    expect(json.code).toBe('EXPIRED_TIMESTAMP');
  });

  test('missing signature header returns 401', async () => {
    const app = buildApp();
    const timestamp = String(Math.floor(Date.now() / 1000));

    const res = await app.request('/data', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-timestamp': timestamp,
      },
      body: '{}',
    });
    expect(res.status).toBe(401);
  });

  test('HMAC off: all requests pass through', async () => {
    const app = buildApp({ requestSigning: false });

    const res = await app.request('/data', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    expect(res.status).toBe(200);
  });

  test('signing not configured: all requests pass through', async () => {
    const app = buildApp(null);

    const res = await app.request('/data', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    expect(res.status).toBe(200);
  });

  test('?b=2&a=1 and ?a=1&b=2 produce same canonical signature (through middleware)', async () => {
    const app = buildApp();
    const ts = String(Math.floor(Date.now() / 1000));

    // Canonical query for sorted ?a=1&b=2 is "a=1&b=2"
    const canonical = buildCanonical('POST', '/data', 'a=1&b=2', ts, '{}');
    const sig = sign(canonical);

    // Send with reversed order — middleware must canonicalize to the same string
    const res = await app.request('/data?b=2&a=1', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-signature': sig, 'x-timestamp': ts },
      body: '{}',
    });
    expect(res.status).toBe(200);
  });

  test('percent-encoding normalized: %20 and + produce same signature (through middleware)', async () => {
    const app = buildApp();
    const ts = String(Math.floor(Date.now() / 1000));

    // Canonical form of "hello world" is encodeURIComponent("hello world") = "hello%20world"
    const canonical = buildCanonical('POST', '/data', 'q=hello%20world', ts, '{}');
    const sig = sign(canonical);

    // Send with + encoding — middleware must normalize to %20
    const res = await app.request('/data?q=hello+world', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-signature': sig, 'x-timestamp': ts },
      body: '{}',
    });
    expect(res.status).toBe(200);
  });

  test('empty query string — canonical query is empty string, not omitted', async () => {
    const app = buildApp();
    const ts = String(Math.floor(Date.now() / 1000));

    // Without query params the canonical query line is "" — still present
    const canonical = buildCanonical('POST', '/data', '', ts, '{}');
    const sig = sign(canonical);

    const res = await app.request('/data', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-signature': sig, 'x-timestamp': ts },
      body: '{}',
    });
    expect(res.status).toBe(200);
  });

  test('repeated key: sorted by value (?tag=b&tag=a canonicalizes to tag=a&tag=b)', async () => {
    const app = buildApp();
    const ts = String(Math.floor(Date.now() / 1000));

    const canonical = buildCanonical('POST', '/data', 'tag=a&tag=b', ts, '{}');
    const sig = sign(canonical);

    // Send reversed — middleware must sort by value too
    const res = await app.request('/data?tag=b&tag=a', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-signature': sig, 'x-timestamp': ts },
      body: '{}',
    });
    expect(res.status).toBe(200);
  });
});
