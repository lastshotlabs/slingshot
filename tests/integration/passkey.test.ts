import type { OpenAPIHono } from '@hono/zod-openapi';
import { beforeEach, describe, expect, test } from 'bun:test';
import { createTestApp } from '../setup';

let app: OpenAPIHono<any>;

beforeEach(async () => {
  app = await createTestApp(
    {},
    {
      auth: {
        mfa: {
          webauthn: {
            rpId: 'example.com',
            origin: 'https://example.com',
            rpName: 'Test App',
            allowPasswordlessLogin: true,
          },
        },
      },
    },
  );
});

const json = (body: Record<string, unknown>) => ({
  method: 'POST' as const,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

// ---------------------------------------------------------------------------
// POST /auth/passkey/login-options
// ---------------------------------------------------------------------------

describe('POST /auth/passkey/login-options', () => {
  test('returns options and passkeyToken', async () => {
    const res = await app.request('/auth/passkey/login-options', json({}));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.options).toBeDefined();
    expect(body.passkeyToken).toBeString();
    expect(body.passkeyToken.length).toBeGreaterThan(0);
  });

  test('options include rpId and userVerification=required', async () => {
    const res = await app.request('/auth/passkey/login-options', json({}));
    const { options } = await res.json();
    expect(options.rpId).toBe('example.com');
    expect(options.userVerification).toBe('required');
  });

  test('accepts optional email field without error', async () => {
    const res = await app.request(
      '/auth/passkey/login-options',
      json({ email: 'user@example.com' }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.passkeyToken).toBeString();
  });

  test('returns same response shape for unknown email (enumeration prevention)', async () => {
    const res = await app.request(
      '/auth/passkey/login-options',
      json({ email: 'ghost@example.com' }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.passkeyToken).toBeString();
    expect(body.options).toBeDefined();
  });

  test('each call returns a different passkeyToken', async () => {
    const res1 = await app.request('/auth/passkey/login-options', json({}));
    const res2 = await app.request('/auth/passkey/login-options', json({}));
    const { passkeyToken: t1 } = await res1.json();
    const { passkeyToken: t2 } = await res2.json();
    expect(t1).not.toBe(t2);
  });

  test('returns 429 after rate limit exceeded (5/min per IP)', async () => {
    for (let i = 0; i < 5; i++) {
      await app.request('/auth/passkey/login-options', json({}));
    }
    const res = await app.request('/auth/passkey/login-options', json({}));
    expect(res.status).toBe(429);
    const body = await res.json();
    expect(body.error).toContain('Too many');
  });
});

// ---------------------------------------------------------------------------
// POST /auth/passkey/login
// ---------------------------------------------------------------------------

describe('POST /auth/passkey/login', () => {
  test('returns 401 for invalid passkeyToken', async () => {
    const res = await app.request(
      '/auth/passkey/login',
      json({
        passkeyToken: 'completely-invalid-token',
        assertionResponse: { id: 'cred-id', rawId: 'cred-id', response: {}, type: 'public-key' },
      }),
    );
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toMatch(/expired|invalid/i);
  });

  test('passkeyToken is single-use — second attempt with same token returns 401', async () => {
    // Get a real token
    const optionsRes = await app.request('/auth/passkey/login-options', json({}));
    const { passkeyToken } = await optionsRes.json();

    // First attempt: token is consumed but credential lookup fails
    await app.request(
      '/auth/passkey/login',
      json({
        passkeyToken,
        assertionResponse: {
          id: 'nonexistent-cred',
          rawId: 'nonexistent-cred',
          response: {},
          type: 'public-key',
        },
      }),
    );

    // Second attempt: token is gone
    const res2 = await app.request(
      '/auth/passkey/login',
      json({
        passkeyToken,
        assertionResponse: {
          id: 'nonexistent-cred',
          rawId: 'nonexistent-cred',
          response: {},
          type: 'public-key',
        },
      }),
    );
    expect(res2.status).toBe(401);
    const body2 = await res2.json();
    expect(body2.error).toMatch(/expired|invalid/i);
  });

  test('returns 401 when credential not registered to any user', async () => {
    const optionsRes = await app.request('/auth/passkey/login-options', json({}));
    const { passkeyToken } = await optionsRes.json();

    const res = await app.request(
      '/auth/passkey/login',
      json({
        passkeyToken,
        assertionResponse: {
          id: 'nonexistent-credential-id',
          rawId: 'nonexistent-credential-id',
          response: {},
          type: 'public-key',
        },
      }),
    );
    expect(res.status).toBe(401);
  });

  test('returns 429 after rate limit exceeded (10 per 15min per IP)', async () => {
    // Fire 10 attempts with invalid token — each returns 401 but increments counter
    for (let i = 0; i < 10; i++) {
      await app.request(
        '/auth/passkey/login',
        json({
          passkeyToken: 'invalid-token',
          assertionResponse: { id: 'cred', rawId: 'cred', response: {}, type: 'public-key' },
        }),
      );
    }
    // 11th attempt is rate-limited regardless of token validity
    const res = await app.request(
      '/auth/passkey/login',
      json({
        passkeyToken: 'invalid-token',
        assertionResponse: { id: 'cred', rawId: 'cred', response: {}, type: 'public-key' },
      }),
    );
    expect(res.status).toBe(429);
    const body = await res.json();
    expect(body.error).toContain('Too many');
  });
});
