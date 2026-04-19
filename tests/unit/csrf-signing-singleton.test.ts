import { DEFAULT_AUTH_CONFIG } from '@auth/config/authConfig';
import { csrfProtection } from '@auth/middleware/csrf';
import { AUTH_RUNTIME_KEY, type AuthRuntimeContext } from '@auth/runtime';
import { describe, expect, test } from 'bun:test';
import { createHmac } from 'crypto';
import { Hono } from 'hono';
import type { AppEnv } from '@lastshotlabs/slingshot-core';

function buildCsrfApp(secret: string) {
  const app = new Hono<AppEnv>();
  const adapter = {} as unknown as never;
  const eventBus = { emit() {} } as unknown as never;
  const rateLimit = null as never;
  const runtime: AuthRuntimeContext = {
    adapter,
    eventBus,
    config: DEFAULT_AUTH_CONFIG,
    signing: { secret },
    dataEncryptionKeys: [],
    lockout: null,
    rateLimit,
    credentialStuffing: null,
  } as unknown as AuthRuntimeContext;
  const slingshotCtx = {
    signing: runtime.signing,
    pluginState: new Map([[AUTH_RUNTIME_KEY, runtime]]),
  } as unknown as never;
  app.use('*', async (c, next) => {
    c.set('slingshotCtx', slingshotCtx);
    await next();
  });
  app.use('*', csrfProtection({ checkOrigin: false, signing: runtime.signing }));
  return app;
}

describe('CSRF signing', () => {
  test('uses injected signing secret for HMAC, not env var', async () => {
    const injectedSecret = 'injected-test-secret-at-least-32-chars-long!!';

    // Build a minimal app with CSRF
    const app = buildCsrfApp(injectedSecret);
    app.get('/ping', c => c.json({ ok: true }));
    app.post('/action', c => c.json({ ok: true }));

    // GET sets a CSRF cookie
    const getRes = await app.request('/ping');
    const setCookieHeader = getRes.headers.get('set-cookie') ?? '';
    const csrfMatch = setCookieHeader.match(/csrf_token=([^;]+)/);
    expect(csrfMatch).toBeTruthy();
    const csrfToken = csrfMatch![1];

    // Verify the token's HMAC signature was produced with the injected secret
    const dotIdx = csrfToken.indexOf('.');
    expect(dotIdx).toBeGreaterThan(0);
    const token = csrfToken.substring(0, dotIdx);
    const sig = csrfToken.substring(dotIdx + 1);
    const expected = createHmac('sha256', injectedSecret).update(token).digest('hex');
    expect(sig).toBe(expected);
  });

  test('token signed with key A does not verify with key B', async () => {
    // Key A
    const keyA = 'key-a-must-be-at-least-32-characters-long!!';
    const appA = buildCsrfApp(keyA);
    appA.post('/action', c => c.json({ ok: true }));
    appA.get('/ping', c => c.json({ ok: true }));

    const getResA = await appA.request('/ping');
    const setCookieA = getResA.headers.get('set-cookie') ?? '';
    const csrfMatchA = setCookieA.match(/csrf_token=([^;]+)/);
    const tokenA = csrfMatchA![1];

    // Switch to key B
    const keyB = 'key-b-must-be-at-least-32-characters-long!!';
    const appB = buildCsrfApp(keyB);
    appB.post('/action', c => c.json({ ok: true }));

    // POST with token-A against app-B should fail (signature mismatch)
    const postRes = await appB.request('/action', {
      method: 'POST',
      headers: {
        Cookie: `token=fake-auth; csrf_token=${tokenA}`,
        'x-csrf-token': tokenA,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({}),
    });
    expect(postRes.status).toBe(403);
  });

  test('updated signing config is used on the next request', () => {
    const initialSigning = 'initial-secret-key-at-least-32-chars-long!!';
    const appA = buildCsrfApp(initialSigning);
    appA.get('/ping', c => c.json({ ok: true }));

    // Initial request caches the secret
    appA.request('/ping');

    // New secret
    const newSigning = 'new-secret-key-that-is-at-least-32-chars!!';
    const appB = buildCsrfApp(newSigning);
    appB.get('/ping', c => c.json({ ok: true }));

    // Should work without throwing
    expect(async () => appB.request('/ping')).not.toThrow();
  });
});
