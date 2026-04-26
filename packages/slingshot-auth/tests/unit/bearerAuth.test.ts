import { describe, expect, test } from 'bun:test';
import { Hono } from 'hono';
import { createBearerAuth } from '../../src/middleware/bearerAuth';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Builds a minimal Hono app with bearerAuth on /protected/* */
function buildApp(config: Parameters<typeof createBearerAuth>[0]) {
  const app = new Hono();
  app.use('/protected/*', createBearerAuth(config));
  app.get('/protected/resource', c => {
    const actor = (c as any).get('actor');
    const clientId = actor?.kind === 'api-key' ? actor.id : undefined;
    return c.json({ ok: true, ...(clientId ? { clientId } : {}) });
  });
  return app;
}

function req(app: Hono, token?: string) {
  const headers: Record<string, string> = {};
  if (token !== undefined) {
    headers['Authorization'] = token;
  }
  return app.request('/protected/resource', { headers });
}

// ---------------------------------------------------------------------------
// 1. Static secret (string config)
// ---------------------------------------------------------------------------

describe('createBearerAuth — static secret', () => {
  const app = buildApp('my-secret-token');

  test('valid token grants access (200)', async () => {
    const res = await req(app, 'Bearer my-secret-token');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  test('invalid token is rejected (401)', async () => {
    const res = await req(app, 'Bearer wrong-token');
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'Unauthorized' });
  });

  test('missing Authorization header returns 401', async () => {
    const res = await req(app);
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'Unauthorized' });
  });

  test('malformed header without "Bearer " prefix returns 401', async () => {
    const res = await req(app, 'Basic my-secret-token');
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'Unauthorized' });
  });

  test('empty Authorization header returns 401', async () => {
    const res = await req(app, '');
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'Unauthorized' });
  });

  test('"Bearer " with no token value returns 401', async () => {
    const res = await req(app, 'Bearer ');
    expect(res.status).toBe(401);
    // Empty string after "Bearer " — timingSafeEqual("", "my-secret-token") should fail
    expect(await res.json()).toEqual({ error: 'Unauthorized' });
  });

  test('token with extra whitespace is not trimmed (rejected)', async () => {
    const res = await req(app, 'Bearer  my-secret-token');
    // Double space means the extracted token starts with a space
    expect(res.status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// 2. Rotating secrets (string[] config)
// ---------------------------------------------------------------------------

describe('createBearerAuth — rotating secrets (string[])', () => {
  const app = buildApp(['new-secret', 'old-secret']);

  test('first token in array grants access', async () => {
    const res = await req(app, 'Bearer new-secret');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  test('second token in array grants access', async () => {
    const res = await req(app, 'Bearer old-secret');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  test('unknown token is rejected', async () => {
    const res = await req(app, 'Bearer unknown-token');
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'Unauthorized' });
  });

  test('missing header returns 401', async () => {
    const res = await req(app);
    expect(res.status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// 3. Named clients (BearerAuthClient[] config)
// ---------------------------------------------------------------------------

describe('createBearerAuth — named clients (BearerAuthClient[])', () => {
  const app = buildApp([
    { clientId: 'service-a', token: 'token-a' },
    { clientId: 'service-b', token: 'token-b', revoked: false },
    { clientId: 'legacy', token: 'legacy-token', revoked: true },
  ]);

  test('valid client token grants access and sets apiKeyId', async () => {
    const res = await req(app, 'Bearer token-a');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.clientId).toBe('service-a');
  });

  test('second non-revoked client also grants access with correct clientId', async () => {
    const res = await req(app, 'Bearer token-b');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.clientId).toBe('service-b');
  });

  test('revoked client token is rejected (401)', async () => {
    const res = await req(app, 'Bearer legacy-token');
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'Unauthorized' });
  });

  test('unknown token not matching any client is rejected', async () => {
    const res = await req(app, 'Bearer totally-unknown');
    expect(res.status).toBe(401);
  });

  test('missing Authorization header returns 401', async () => {
    const res = await req(app);
    expect(res.status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// 4. Edge cases
// ---------------------------------------------------------------------------

describe('createBearerAuth — edge cases', () => {
  test('empty string[] config always rejects', async () => {
    const app = buildApp([]);
    const res = await req(app, 'Bearer any-token');
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'Unauthorized' });
  });

  test('empty BearerAuthClient[] config always rejects', async () => {
    const app = buildApp([] as { clientId: string; token: string }[]);
    const res = await req(app, 'Bearer any-token');
    expect(res.status).toBe(401);
  });

  test('only "Bearer" keyword without space and token returns 401', async () => {
    const app = buildApp('secret');
    const res = await req(app, 'Bearer');
    expect(res.status).toBe(401);
  });

  test('case-sensitive: "bearer " (lowercase) prefix is rejected', async () => {
    const app = buildApp('my-secret');
    const res = await req(app, 'bearer my-secret');
    expect(res.status).toBe(401);
  });

  test('handler is not called on auth failure', async () => {
    let handlerCalled = false;
    const app = new Hono();
    app.use('/protected/*', createBearerAuth('secret'));
    app.get('/protected/resource', c => {
      handlerCalled = true;
      return c.json({ ok: true });
    });

    await req(app, 'Bearer wrong');
    expect(handlerCalled).toBe(false);
  });

  test('handler is called on auth success', async () => {
    let handlerCalled = false;
    const app = new Hono();
    app.use('/protected/*', createBearerAuth('secret'));
    app.get('/protected/resource', c => {
      handlerCalled = true;
      return c.json({ ok: true });
    });

    await req(app, 'Bearer secret');
    expect(handlerCalled).toBe(true);
  });

  test('all-revoked client list rejects everything', async () => {
    const app = buildApp([
      { clientId: 'a', token: 'token-a', revoked: true },
      { clientId: 'b', token: 'token-b', revoked: true },
    ]);
    const res = await req(app, 'Bearer token-a');
    expect(res.status).toBe(401);
  });
});
