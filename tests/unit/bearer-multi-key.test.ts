import type { BearerAuthClient } from '@auth/config/authConfig';
import { createBearerAuth } from '@auth/middleware/bearerAuth';
import { OpenAPIHono } from '@hono/zod-openapi';
import { describe, expect, test } from 'bun:test';

/**
 * Build a minimal Hono app with bearerAuth applied globally,
 * and a GET /check route that returns the bearerClientId from context.
 */
function makeApp(config: Parameters<typeof createBearerAuth>[0]) {
  const app = new OpenAPIHono<any>();
  app.use(createBearerAuth(config));
  app.get('/check', c => {
    const actor = c.get('actor') as { kind: string; id: string | null } | undefined;
    const bearerClientId = actor?.kind === 'api-key' ? actor.id : null;
    return c.json({ ok: true, bearerClientId });
  });
  return app;
}
// ---------------------------------------------------------------------------
// Single string token (env-var-less, explicit string config)
// ---------------------------------------------------------------------------

describe('createBearerAuth — single string token', () => {
  const app = makeApp('explicit-token-abc');

  test('valid token passes', async () => {
    const res = await app.request('/check', {
      headers: { Authorization: 'Bearer explicit-token-abc' },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; bearerClientId: string | null };
    expect(body.ok).toBe(true);
  });

  test('wrong token returns 401', async () => {
    const res = await app.request('/check', {
      headers: { Authorization: 'Bearer wrong-token' },
    });
    expect(res.status).toBe(401);
  });

  test('missing header returns 401', async () => {
    const res = await app.request('/check');
    expect(res.status).toBe(401);
  });

  test('malformed header (no Bearer prefix) returns 401', async () => {
    const res = await app.request('/check', {
      headers: { Authorization: 'Token explicit-token-abc' },
    });
    expect(res.status).toBe(401);
  });

  test('no clientId is set for plain string config', async () => {
    const res = await app.request('/check', {
      headers: { Authorization: 'Bearer explicit-token-abc' },
    });
    const body = (await res.json()) as { bearerClientId: string | null };
    expect(body.bearerClientId).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// string[] — multiple tokens
// ---------------------------------------------------------------------------

describe('createBearerAuth — string[] tokens', () => {
  const app = makeApp(['token-alpha', 'token-beta', 'token-gamma']);

  test('first token passes', async () => {
    const res = await app.request('/check', {
      headers: { Authorization: 'Bearer token-alpha' },
    });
    expect(res.status).toBe(200);
  });

  test('middle token passes', async () => {
    const res = await app.request('/check', {
      headers: { Authorization: 'Bearer token-beta' },
    });
    expect(res.status).toBe(200);
  });

  test('last token passes', async () => {
    const res = await app.request('/check', {
      headers: { Authorization: 'Bearer token-gamma' },
    });
    expect(res.status).toBe(200);
  });

  test('unknown token returns 401', async () => {
    const res = await app.request('/check', {
      headers: { Authorization: 'Bearer token-unknown' },
    });
    expect(res.status).toBe(401);
  });

  test('no clientId set for string[] config', async () => {
    const res = await app.request('/check', {
      headers: { Authorization: 'Bearer token-alpha' },
    });
    const body = (await res.json()) as { bearerClientId: string | null };
    expect(body.bearerClientId).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// BearerAuthClient[] — named clients with revocation
// ---------------------------------------------------------------------------

describe('createBearerAuth — BearerAuthClient[]', () => {
  const clients: BearerAuthClient[] = [
    { clientId: 'ci-pipeline', token: 'token-ci-12345', description: 'CI/CD pipeline' },
    { clientId: 'mobile-app', token: 'token-mobile-99999' },
    { clientId: 'revoked-client', token: 'token-revoked-xyz', revoked: true },
  ];
  const app = makeApp(clients);

  test('valid client token passes and sets clientId on context', async () => {
    const res = await app.request('/check', {
      headers: { Authorization: 'Bearer token-ci-12345' },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; bearerClientId: string | null };
    expect(body.ok).toBe(true);
    expect(body.bearerClientId).toBe('ci-pipeline');
  });

  test('second valid client token passes with correct clientId', async () => {
    const res = await app.request('/check', {
      headers: { Authorization: 'Bearer token-mobile-99999' },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { bearerClientId: string | null };
    expect(body.bearerClientId).toBe('mobile-app');
  });

  test('revoked client token is rejected even when correct token', async () => {
    const res = await app.request('/check', {
      headers: { Authorization: 'Bearer token-revoked-xyz' },
    });
    expect(res.status).toBe(401);
  });

  test('unknown token returns 401', async () => {
    const res = await app.request('/check', {
      headers: { Authorization: 'Bearer completely-unknown-token' },
    });
    expect(res.status).toBe(401);
  });

  test('missing header returns 401', async () => {
    const res = await app.request('/check');
    expect(res.status).toBe(401);
  });

  test('all clients are checked — last non-revoked client matches', async () => {
    // token-mobile-99999 is the 2nd entry (index 1)
    const res = await app.request('/check', {
      headers: { Authorization: 'Bearer token-mobile-99999' },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { bearerClientId: string | null };
    // Confirms iteration past the first entry
    expect(body.bearerClientId).toBe('mobile-app');
  });
});

// ---------------------------------------------------------------------------
// Empty BearerAuthClient[] — edge case
// ---------------------------------------------------------------------------

describe('createBearerAuth — empty array', () => {
  const app = makeApp([]);

  test('any token returns 401 when client list is empty', async () => {
    const res = await app.request('/check', {
      headers: { Authorization: 'Bearer any-token' },
    });
    expect(res.status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// All clients revoked — nothing passes
// ---------------------------------------------------------------------------

describe('createBearerAuth — all clients revoked', () => {
  const clients: BearerAuthClient[] = [
    { clientId: 'revoked-a', token: 'token-a', revoked: true },
    { clientId: 'revoked-b', token: 'token-b', revoked: true },
  ];
  const app = makeApp(clients);

  test('matching revoked token is rejected', async () => {
    const res = await app.request('/check', {
      headers: { Authorization: 'Bearer token-a' },
    });
    expect(res.status).toBe(401);
  });
});
