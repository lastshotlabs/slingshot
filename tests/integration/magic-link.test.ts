import type { OpenAPIHono } from '@hono/zod-openapi';
import { beforeEach, describe, expect, test } from 'bun:test';
import { getContext } from '@lastshotlabs/slingshot-core';
import { createTestApp } from '../setup';

let app: OpenAPIHono<any>;
const getBus = (targetApp: object) => getContext(targetApp).bus;

// Captured delivery event values
let capturedIdentifier: string | undefined;
let capturedToken: string | undefined;
let capturedLink: string | undefined;
let resolveToken: (token: string) => void;
let tokenPromise: Promise<string>;

function setupTokenCapture() {
  tokenPromise = new Promise<string>(r => {
    resolveToken = r;
  });
  const handler = (payload: { identifier: string; token: string; link: string }) => {
    capturedIdentifier = payload.identifier;
    capturedToken = payload.token;
    capturedLink = payload.link;
    resolveToken(payload.token);
  };
  getBus(app).on('auth:delivery.magic_link', handler);
  return () => getBus(app).off('auth:delivery.magic_link', handler);
}

beforeEach(async () => {
  app = await createTestApp(
    {},
    {
      auth: {
        enabled: true,
        roles: ['admin', 'user'],
        defaultRole: 'user',
        magicLink: {
          linkBaseUrl: 'https://app.example.com/auth/magic',
        },
      },
    },
  );
  capturedIdentifier = undefined;
  capturedToken = undefined;
  capturedLink = undefined;
  tokenPromise = new Promise<string>(r => {
    resolveToken = r;
  });
});

const json = (body: Record<string, unknown>) => ({
  method: 'POST' as const,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

// ---------------------------------------------------------------------------
// POST /auth/magic-link/request
// ---------------------------------------------------------------------------

describe('POST /auth/magic-link/request', () => {
  test('returns 200 for existing user and emits magic_link delivery event with token', async () => {
    await app.request(
      '/auth/register',
      json({ email: 'magic@example.com', password: 'password123' }),
    );

    const cleanup = setupTokenCapture();
    const res = await app.request(
      '/auth/magic-link/request',
      json({ identifier: 'magic@example.com' }),
    );
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.message).toBeString();

    // Wait for fire-and-forget emit to complete
    await tokenPromise;
    cleanup();
    expect(capturedToken).toBeString();
    expect(capturedIdentifier).toBe('magic@example.com');
    expect(capturedLink).toContain('https://app.example.com/auth/magic#token=');
    expect(capturedLink).toContain(capturedToken!);
  });

  test('returns 200 for non-existent user (enumeration-safe) and does NOT emit delivery event', async () => {
    let emitted = false;
    const handler = () => {
      emitted = true;
    };
    getBus(app).on('auth:delivery.magic_link', handler);
    const res = await app.request(
      '/auth/magic-link/request',
      json({ identifier: 'nobody@example.com' }),
    );
    expect(res.status).toBe(200);

    // Give fire-and-forget time to run — it should not
    await Bun.sleep(50);
    getBus(app).off('auth:delivery.magic_link', handler);
    expect(emitted).toBe(false);
  });

  test('response message is the same for both existing and non-existing accounts', async () => {
    await app.request(
      '/auth/register',
      json({ email: 'exists@example.com', password: 'password123' }),
    );

    const resExists = await app.request(
      '/auth/magic-link/request',
      json({ identifier: 'exists@example.com' }),
    );
    const resNotExists = await app.request(
      '/auth/magic-link/request',
      json({ identifier: 'ghost@example.com' }),
    );

    const bodyExists = (await resExists.json()) as any;
    const bodyNotExists = (await resNotExists.json()) as any;

    expect(bodyExists.message).toBe(bodyNotExists.message);
  });
});

// ---------------------------------------------------------------------------
// POST /auth/magic-link/verify
// ---------------------------------------------------------------------------

describe('POST /auth/magic-link/verify', () => {
  test('valid token returns 200 with session token and sets cookie', async () => {
    await app.request(
      '/auth/register',
      json({ email: 'verify@example.com', password: 'password123' }),
    );
    const cleanup = setupTokenCapture();
    await app.request('/auth/magic-link/request', json({ identifier: 'verify@example.com' }));
    const token = await tokenPromise;
    cleanup();

    const res = await app.request('/auth/magic-link/verify', json({ token }));
    expect(res.status).toBe(200);

    const body = (await res.json()) as any;
    expect(body.token).toBeString();
    expect(body.userId).toBeString();

    // Cookie should be set
    const setCookieHeader = res.headers.get('set-cookie');
    expect(setCookieHeader).toContain('token=');
  });

  test('invalid token returns 400', async () => {
    const res = await app.request(
      '/auth/magic-link/verify',
      json({ token: 'invalid-token-that-does-not-exist' }),
    );
    expect(res.status).toBe(400);

    const body = (await res.json()) as any;
    expect(body.error).toBeString();
  });

  test('token is single-use (second verify returns 400)', async () => {
    await app.request(
      '/auth/register',
      json({ email: 'singleuse@example.com', password: 'password123' }),
    );
    const cleanup = setupTokenCapture();
    await app.request('/auth/magic-link/request', json({ identifier: 'singleuse@example.com' }));
    const token = await tokenPromise;
    cleanup();

    const res1 = await app.request('/auth/magic-link/verify', json({ token }));
    expect(res1.status).toBe(200);

    const res2 = await app.request('/auth/magic-link/verify', json({ token }));
    expect(res2.status).toBe(400);
  });

  test('magic-link verify runs preLogin hook before issuing a session', async () => {
    const gatedApp = await createTestApp(
      {},
      {
        auth: {
          enabled: true,
          roles: ['user'],
          defaultRole: 'user',
          magicLink: {
            linkBaseUrl: 'https://app.example.com/auth/magic',
          },
          hooks: {
            preLogin: async ({ identifier }) => {
              if (identifier === 'blocked@example.com') {
                throw new Error('blocked by hook');
              }
            },
          },
        },
      },
    );

    let gatedResolve!: (token: string) => void;
    const gatedPromise = new Promise<string>(resolve => {
      gatedResolve = resolve;
    });
    const handler = (payload: { token: string }) => gatedResolve(payload.token);
    getBus(gatedApp).on('auth:delivery.magic_link', handler);

    await gatedApp.request(
      '/auth/register',
      json({ email: 'blocked@example.com', password: 'password123' }),
    );
    await gatedApp.request('/auth/magic-link/request', json({ identifier: 'blocked@example.com' }));
    const token = await gatedPromise;
    getBus(gatedApp).off('auth:delivery.magic_link', handler);

    const res = await gatedApp.request('/auth/magic-link/verify', json({ token }));
    expect(res.status).toBe(500);
    expect(res.headers.get('set-cookie')).toBeNull();
  });

  test('expired token returns 400', async () => {
    // Create an app with very short TTL
    const shortTtlApp = await createTestApp(
      {},
      {
        auth: {
          enabled: true,
          roles: ['user'],
          defaultRole: 'user',
          magicLink: {
            ttlSeconds: 1, // 1 second TTL
          },
        },
      },
    );

    let shortResolve: (t: string) => void;
    const shortPromise = new Promise<string>(r => {
      shortResolve = r;
    });
    const handler = (payload: { token: string }) => {
      shortResolve(payload.token);
    };
    getBus(shortTtlApp).on('auth:delivery.magic_link', handler);

    await shortTtlApp.request(
      '/auth/register',
      json({ email: 'expire@example.com', password: 'password123' }),
    );
    await shortTtlApp.request(
      '/auth/magic-link/request',
      json({ identifier: 'expire@example.com' }),
    );
    const shortToken = await shortPromise;
    getBus(shortTtlApp).off('auth:delivery.magic_link', handler);

    // Wait for token to expire
    await Bun.sleep(1200);

    const res = await shortTtlApp.request('/auth/magic-link/verify', json({ token: shortToken }));
    expect(res.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// Token link format
// ---------------------------------------------------------------------------

describe('magic link URL construction', () => {
  test('link contains token when linkBaseUrl is set', async () => {
    await app.request(
      '/auth/register',
      json({ email: 'linkurl@example.com', password: 'password123' }),
    );
    const cleanup = setupTokenCapture();
    await app.request('/auth/magic-link/request', json({ identifier: 'linkurl@example.com' }));
    const token = await tokenPromise;
    cleanup();

    expect(capturedLink).toBe(`https://app.example.com/auth/magic#token=${token}`);
  });

  test('legacy query token placement is explicit and preserves existing query params', async () => {
    const queryTokenApp = await createTestApp(
      {},
      {
        auth: {
          enabled: true,
          roles: ['user'],
          defaultRole: 'user',
          magicLink: {
            linkBaseUrl: 'https://app.example.com/auth/magic?source=email',
            tokenLocation: 'query',
          },
        },
      },
    );

    let queryToken: string | undefined;
    let queryLink: string | undefined;
    let queryResolve: (t: string) => void;
    const queryPromise = new Promise<string>(r => {
      queryResolve = r;
    });
    const handler = (payload: { token: string; link: string }) => {
      queryToken = payload.token;
      queryLink = payload.link;
      queryResolve(payload.token);
    };
    getBus(queryTokenApp).on('auth:delivery.magic_link', handler);

    await queryTokenApp.request(
      '/auth/register',
      json({ email: 'querylink@example.com', password: 'password123' }),
    );
    await queryTokenApp.request(
      '/auth/magic-link/request',
      json({ identifier: 'querylink@example.com' }),
    );
    await queryPromise;
    getBus(queryTokenApp).off('auth:delivery.magic_link', handler);

    expect(queryLink).toBe(`https://app.example.com/auth/magic?source=email&token=${queryToken}`);
  });

  test('link equals token when linkBaseUrl is not set', async () => {
    const noBaseUrlApp = await createTestApp(
      {},
      {
        auth: {
          enabled: true,
          roles: ['user'],
          defaultRole: 'user',
          magicLink: {
            // no linkBaseUrl
          },
        },
      },
    );

    let noBaseToken: string | undefined;
    let noBaseLink: string | undefined;
    let noBaseResolve: (t: string) => void;
    const noBasePromise = new Promise<string>(r => {
      noBaseResolve = r;
    });
    const handler = (payload: { token: string; link: string }) => {
      noBaseToken = payload.token;
      noBaseLink = payload.link;
      noBaseResolve(payload.token);
    };
    getBus(noBaseUrlApp).on('auth:delivery.magic_link', handler);

    await noBaseUrlApp.request(
      '/auth/register',
      json({ email: 'nobase@example.com', password: 'password123' }),
    );
    await noBaseUrlApp.request(
      '/auth/magic-link/request',
      json({ identifier: 'nobase@example.com' }),
    );
    await noBasePromise;
    getBus(noBaseUrlApp).off('auth:delivery.magic_link', handler);

    expect(noBaseLink).toBe(noBaseToken);
  });
});
