import { setSuspended } from '@auth/lib/suspension';
import { AUTH_RUNTIME_KEY } from '@auth/runtime';
import type { AuthRuntimeContext } from '@auth/runtime';
import type { OpenAPIHono } from '@hono/zod-openapi';
import { beforeEach, describe, expect, test } from 'bun:test';
import { getContext } from '@lastshotlabs/slingshot-core';
import { createTestApp } from '../setup';

const json = (body: Record<string, unknown>) => ({
  method: 'POST' as const,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

function getRuntime(app: OpenAPIHono<any>): AuthRuntimeContext {
  return (app as any).ctx.pluginState.get(AUTH_RUNTIME_KEY) as AuthRuntimeContext;
}

// ---------------------------------------------------------------------------
// Non-concealed mode (default behavior preserved)
// ---------------------------------------------------------------------------

describe('non-concealed mode (default)', () => {
  let app: OpenAPIHono<any>;

  beforeEach(async () => {
    app = await createTestApp();
  });

  test('new user returns 201 with token', async () => {
    const res = await app.request(
      '/auth/register',
      json({ email: 'new@example.com', password: 'password123' }),
    );
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.token).toBeString();
    expect(body.userId).toBeString();
  });

  test('existing user returns 409', async () => {
    await app.request(
      '/auth/register',
      json({ email: 'dupe@example.com', password: 'password123' }),
    );
    const res = await app.request(
      '/auth/register',
      json({ email: 'dupe@example.com', password: 'password123' }),
    );
    expect(res.status).toBe(409);
  });
});

// ---------------------------------------------------------------------------
// Concealed mode
// ---------------------------------------------------------------------------

describe('concealed mode', () => {
  let app: OpenAPIHono<any>;
  let capturedToken: string | undefined;
  let onExistingAccountCalled: string | undefined;

  beforeEach(async () => {
    capturedToken = undefined;
    onExistingAccountCalled = undefined;
    app = await createTestApp(
      {},
      {
        auth: {
          emailVerification: {},
          concealRegistration: {
            onExistingAccount: async (identifier: string) => {
              onExistingAccountCalled = identifier;
            },
          },
        },
      },
    );
    const handler = (payload: { token: string }) => {
      capturedToken = payload.token;
    };
    getContext(app).bus.on('auth:delivery.email_verification', handler);
  });

  test('new user returns 200 with generic message (no token)', async () => {
    const res = await app.request(
      '/auth/register',
      json({ email: 'new@example.com', password: 'password123' }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.message).toBeString();
    expect(body.token).toBeUndefined();
  });

  test('existing user returns 200 with same generic message (no leak)', async () => {
    // Register once
    const res1 = await app.request(
      '/auth/register',
      json({ email: 'existing@example.com', password: 'password123' }),
    );
    expect(res1.status).toBe(200);
    const body1 = await res1.json();

    // Register again with same email
    const res2 = await app.request(
      '/auth/register',
      json({ email: 'existing@example.com', password: 'password123' }),
    );
    expect(res2.status).toBe(200);
    const body2 = await res2.json();

    // Both responses must be indistinguishable
    expect(body1.message).toBe(body2.message);
    expect(body2.token).toBeUndefined();
  });

  test('existing account triggers onExistingAccount callback', async () => {
    await app.request(
      '/auth/register',
      json({ email: 'existing2@example.com', password: 'password123' }),
    );
    // Give any fire-and-forget time to run
    await new Promise(r => setTimeout(r, 50));
    onExistingAccountCalled = undefined; // reset after first registration

    await app.request(
      '/auth/register',
      json({ email: 'existing2@example.com', password: 'password123' }),
    );
    await new Promise(r => setTimeout(r, 50));
    expect(onExistingAccountCalled!).toBe('existing2@example.com');
  });

  test('POST /auth/verify-and-login with valid token returns token + sets cookie', async () => {
    await app.request(
      '/auth/register',
      json({ email: 'verify@example.com', password: 'password123' }),
    );
    const token = capturedToken!;
    expect(token).toBeString();

    const res = await app.request('/auth/verify-and-login', json({ token }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.token).toBeString();
    expect(body.userId).toBeString();
    expect(body.email).toBe('verify@example.com');
    expect(body.emailVerified).toBe(true);
    // Cookie should be set
    expect(res.headers.get('set-cookie')).toContain('token=');
  });

  test('POST /auth/verify-and-login with expired/invalid token returns 400', async () => {
    const res = await app.request('/auth/verify-and-login', json({ token: 'invalid-token-xyz' }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBeString();
  });

  test('POST /auth/verify-and-login token is single-use (second use fails)', async () => {
    await app.request(
      '/auth/register',
      json({ email: 'singleuse@example.com', password: 'password123' }),
    );
    const token = capturedToken!;

    const res1 = await app.request('/auth/verify-and-login', json({ token }));
    expect(res1.status).toBe(200);

    const res2 = await app.request('/auth/verify-and-login', json({ token }));
    expect(res2.status).toBe(400);
  });

  test('POST /auth/verify-and-login returns 403 for suspended accounts', async () => {
    await app.request(
      '/auth/register',
      json({ email: 'suspended-verify@example.com', password: 'password123' }),
    );
    const token = capturedToken!;
    const runtime = getRuntime(app);
    const user = await runtime.adapter.findByEmail('suspended-verify@example.com');
    await setSuspended(runtime.adapter, user!.id, true, 'manual suspension');

    const res = await app.request('/auth/verify-and-login', json({ token }));
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toContain('suspended');
    expect(res.headers.get('set-cookie')).toBeNull();
  });

  test('POST /auth/verify-and-login runs preLogin before issuing a session', async () => {
    const gatedApp = await createTestApp(
      {},
      {
        auth: {
          emailVerification: {},
          concealRegistration: {},
          hooks: {
            preLogin: async ({ identifier }) => {
              if (identifier === 'blocked-verify@example.com') {
                throw new Error('blocked by hook');
              }
            },
          },
        },
      },
    );

    let verificationToken: string | undefined;
    const handler = (payload: { token: string }) => {
      verificationToken = payload.token;
    };
    getContext(gatedApp).bus.on('auth:delivery.email_verification', handler);

    await gatedApp.request(
      '/auth/register',
      json({ email: 'blocked-verify@example.com', password: 'password123' }),
    );
    getContext(gatedApp).bus.off('auth:delivery.email_verification', handler);

    const res = await gatedApp.request(
      '/auth/verify-and-login',
      json({ token: verificationToken! }),
    );
    expect(res.status).toBe(500);
    expect(res.headers.get('set-cookie')).toBeNull();
  });

  test('POST /auth/verify-email stays message-only in concealed mode', async () => {
    await app.request(
      '/auth/register',
      json({ email: 'verifyonly@example.com', password: 'password123' }),
    );
    const token = capturedToken!;

    const res = await app.request('/auth/verify-email', json({ token }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    // verify-email must NOT issue a session token
    expect(body.token).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// POST /auth/verify-email stays message-only in non-concealed mode
// ---------------------------------------------------------------------------

describe('POST /auth/verify-email message-only in non-concealed mode', () => {
  let app: OpenAPIHono<any>;
  let capturedToken: string | undefined;

  beforeEach(async () => {
    capturedToken = undefined;
    app = await createTestApp(
      {},
      {
        auth: {
          emailVerification: {},
        },
      },
    );
    const handler = (payload: { token: string }) => {
      capturedToken = payload.token;
    };
    getContext(app).bus.on('auth:delivery.email_verification', handler);
  });

  test('verify-email returns message only, no token', async () => {
    await app.request(
      '/auth/register',
      json({ email: 'msgonly@example.com', password: 'password123' }),
    );
    const token = capturedToken!;

    const res = await app.request('/auth/verify-email', json({ token }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.token).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Startup validation: concealRegistration requires primaryField === "email"
// ---------------------------------------------------------------------------

describe('startup validation', () => {
  test('throws when concealRegistration used with primaryField: username', async () => {
    expect(
      createTestApp(
        {},
        {
          auth: {
            primaryField: 'username',
            concealRegistration: {},
          },
        },
      ),
    ).rejects.toThrow(/concealRegistration/);
  });

  test('does not throw when concealRegistration used with primaryField: email', async () => {
    expect(
      createTestApp(
        {},
        {
          auth: {
            primaryField: 'email',
            emailVerification: {},
            concealRegistration: {},
          },
        },
      ),
    ).resolves.toBeDefined();
  });
});
