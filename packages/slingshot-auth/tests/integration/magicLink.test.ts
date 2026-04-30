/**
 * Integration tests for the magic link authentication flow.
 *
 * Covers:
 * - POST /auth/magic-link/request (enumeration-safe, rate-limited, fire-and-forget delivery)
 * - POST /auth/magic-link/verify (token consumption, session creation, suspension check)
 */
import { beforeEach, describe, expect, test } from 'bun:test';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { HttpError } from '@lastshotlabs/slingshot-core';
import { createMagicLinkRouter } from '../../src/routes/magicLink';
import { makeEventBus, makeTestRuntime, wrapWithRuntime } from '../helpers/runtime';
import type { MutableTestRuntime } from '../helpers/runtime';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildApp(runtime: MutableTestRuntime) {
  const app = wrapWithRuntime(runtime);
  app.onError((err, c) =>
    c.json(
      { error: err.message },
      (err instanceof HttpError ? err.status : 500) as ContentfulStatusCode,
    ),
  );
  app.route(
    '/',
    createMagicLinkRouter(
      { magicLink: { ttlSeconds: 900, linkBaseUrl: 'https://app.example.com/auth/verify' } },
      runtime,
    ),
  );
  return app;
}

const jsonPost = (path: string, body: Record<string, unknown>) =>
  app.request(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

let app: ReturnType<typeof buildApp>;
let runtime: MutableTestRuntime;
let emitted: Array<{ event: string; payload: unknown }>;

// Capture the magic link token from the event bus
let capturedMagicToken: string | null;

beforeEach(() => {
  runtime = makeTestRuntime({ concealRegistration: null });
  emitted = [];
  capturedMagicToken = null;
  const eventBusOverride: ReturnType<typeof makeEventBus> = {
    ...makeEventBus(event => emitted.push({ event, payload: null })),
    emit: ((event: string, payload: unknown) => {
      emitted.push({ event, payload });
      if (event === 'auth:delivery.magic_link' && payload && typeof payload === 'object') {
        capturedMagicToken = (payload as Record<string, string>).token;
      }
    }) as ReturnType<typeof makeEventBus>['emit'],
  };
  runtime.eventBus = eventBusOverride;
  app = buildApp(runtime);
});

// ---------------------------------------------------------------------------
// POST /auth/magic-link/request
// ---------------------------------------------------------------------------

describe('POST /auth/magic-link/request', () => {
  test('returns 200 for registered email', async () => {
    const hash = await Bun.password.hash('SomePass123!');
    await runtime.adapter.create('alice@example.com', hash);

    const res = await jsonPost('/auth/magic-link/request', {
      identifier: 'alice@example.com',
    });
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.message).toContain('sign-in link');
  });

  test('returns 200 for unregistered email (enumeration-safe)', async () => {
    const res = await jsonPost('/auth/magic-link/request', {
      identifier: 'nobody@example.com',
    });
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.message).toContain('sign-in link');
  });

  test('same response shape for registered and unregistered emails', async () => {
    const hash = await Bun.password.hash('SomePass123!');
    await runtime.adapter.create('exists@example.com', hash);

    const res1 = await jsonPost('/auth/magic-link/request', {
      identifier: 'exists@example.com',
    });
    const res2 = await jsonPost('/auth/magic-link/request', {
      identifier: 'ghost@example.com',
    });

    const body1 = await res1.json();
    const body2 = await res2.json();

    expect(res1.status).toBe(res2.status);
    expect(Object.keys(body1).sort()).toEqual(Object.keys(body2).sort());
    expect(body1.message).toBe(body2.message);
  });

  test('emits auth:delivery.magic_link event for registered email', async () => {
    const hash = await Bun.password.hash('SomePass123!');
    await runtime.adapter.create('alice@example.com', hash);

    await jsonPost('/auth/magic-link/request', { identifier: 'alice@example.com' });

    // Fire-and-forget async — wait for the event to be emitted
    await new Promise(r => setTimeout(r, 200));

    const deliveryEvent = emitted.find(e => e.event === 'auth:delivery.magic_link');
    expect(deliveryEvent).toBeDefined();
    expect(capturedMagicToken).not.toBeNull();
    expect(capturedMagicToken!.length).toBeGreaterThan(0);
  });

  test('emitted event payload includes identifier, token, and link', async () => {
    const hash = await Bun.password.hash('SomePass123!');
    await runtime.adapter.create('alice@example.com', hash);

    await jsonPost('/auth/magic-link/request', { identifier: 'alice@example.com' });
    await new Promise(r => setTimeout(r, 200));

    const deliveryEvent = emitted.find(e => e.event === 'auth:delivery.magic_link');
    expect(deliveryEvent).toBeDefined();
    const payload = deliveryEvent!.payload as Record<string, string>;
    expect(payload.identifier).toBe('alice@example.com');
    expect(payload.token).toBeString();
    expect(payload.link).toContain('https://app.example.com/auth/verify#token=');
  });

  test('does NOT emit delivery event for unregistered email', async () => {
    await jsonPost('/auth/magic-link/request', { identifier: 'nobody@example.com' });
    await new Promise(r => setTimeout(r, 200));

    const deliveryEvent = emitted.find(e => e.event === 'auth:delivery.magic_link');
    expect(deliveryEvent).toBeUndefined();
    expect(capturedMagicToken).toBeNull();
  });

  test('rate-limits by IP when the bucket reaches 5 attempts', async () => {
    for (let i = 0; i < 4; i++) {
      const res = await jsonPost('/auth/magic-link/request', {
        identifier: `addr${i}@example.com`,
      });
      expect(res.status).toBe(200);
    }

    const res = await jsonPost('/auth/magic-link/request', {
      identifier: 'addr4@example.com',
    });
    expect(res.status).toBe(429);
  });

  test('rate-limits repeated requests for the same identifier even across case changes', async () => {
    for (let i = 0; i < 5; i++) {
      const identifier = i % 2 === 0 ? 'Target@example.com' : 'target@example.com';
      const res = await jsonPost('/auth/magic-link/request', { identifier });
      if (i < 4) {
        expect(res.status).toBe(200);
      } else {
        expect(res.status).toBe(429);
      }
    }
  });

  test('rate-limit response includes error message', async () => {
    for (let i = 0; i < 5; i++) {
      await jsonPost('/auth/magic-link/request', { identifier: `user${i}@example.com` });
    }

    const res = await jsonPost('/auth/magic-link/request', {
      identifier: 'extra@example.com',
    });
    expect(res.status).toBe(429);
    const body = await res.json();
    expect(body.error).toContain('Too many requests');
  });
});

// ---------------------------------------------------------------------------
// POST /auth/magic-link/verify
// ---------------------------------------------------------------------------

describe('POST /auth/magic-link/verify', () => {
  test('returns 200 with valid token and creates a session', async () => {
    const hash = await Bun.password.hash('SomePass123!');
    await runtime.adapter.create('alice@example.com', hash);

    await jsonPost('/auth/magic-link/request', { identifier: 'alice@example.com' });
    await new Promise(r => setTimeout(r, 200));
    expect(capturedMagicToken).not.toBeNull();

    const res = await jsonPost('/auth/magic-link/verify', { token: capturedMagicToken! });
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.token).toBeString();
    expect(body.token.length).toBeGreaterThan(0);
    expect(body.userId).toBeString();
    expect(body.userId.length).toBeGreaterThan(0);
  });

  test('returned token is a valid JWT with correct sub claim', async () => {
    const hash = await Bun.password.hash('SomePass123!');
    const { id: userId } = await runtime.adapter.create('alice@example.com', hash);

    await jsonPost('/auth/magic-link/request', { identifier: 'alice@example.com' });
    await new Promise(r => setTimeout(r, 200));

    const res = await jsonPost('/auth/magic-link/verify', { token: capturedMagicToken! });
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.userId).toBe(userId);

    // Decode JWT payload
    const [, payloadB64] = body.token.split('.');
    const payload = JSON.parse(atob(payloadB64.replace(/-/g, '+').replace(/_/g, '/')));
    expect(payload.sub).toBe(userId);
    expect(payload.exp).toBeNumber();
    expect(payload.iat).toBeNumber();
  });

  test('token can only be used once (atomic consumption)', async () => {
    const hash = await Bun.password.hash('SomePass123!');
    await runtime.adapter.create('alice@example.com', hash);

    await jsonPost('/auth/magic-link/request', { identifier: 'alice@example.com' });
    await new Promise(r => setTimeout(r, 200));
    const token = capturedMagicToken!;

    // First use succeeds
    const res1 = await jsonPost('/auth/magic-link/verify', { token });
    expect(res1.status).toBe(200);

    // Second use fails — token consumed
    const res2 = await jsonPost('/auth/magic-link/verify', { token });
    expect(res2.status).toBe(400);
    const body2 = await res2.json();
    expect(body2.error).toContain('Invalid or expired');
  });

  test('invalid token returns 400', async () => {
    const res = await jsonPost('/auth/magic-link/verify', { token: 'totally-bogus-token' });
    expect(res.status).toBe(400);

    const body = await res.json();
    expect(body.error).toContain('Invalid or expired');
  });

  test('rate-limits verify attempts by IP after 10 attempts', async () => {
    for (let i = 0; i < 10; i++) {
      await jsonPost('/auth/magic-link/verify', { token: `bogus-${i}` });
    }

    const res = await jsonPost('/auth/magic-link/verify', { token: 'one-more' });
    expect(res.status).toBe(429);
    const body = await res.json();
    expect(body.error).toContain('Too many attempts');
  });

  test('sets session cookie on successful verify', async () => {
    const hash = await Bun.password.hash('SomePass123!');
    await runtime.adapter.create('alice@example.com', hash);

    await jsonPost('/auth/magic-link/request', { identifier: 'alice@example.com' });
    await new Promise(r => setTimeout(r, 200));

    const res = await jsonPost('/auth/magic-link/verify', { token: capturedMagicToken! });
    expect(res.status).toBe(200);

    const setCookieHeader = res.headers.get('set-cookie');
    expect(setCookieHeader).toBeString();
    expect(setCookieHeader!).toContain('token=');
  });

  test('emits login success event on successful verify', async () => {
    const hash = await Bun.password.hash('SomePass123!');
    await runtime.adapter.create('alice@example.com', hash);

    await jsonPost('/auth/magic-link/request', { identifier: 'alice@example.com' });
    await new Promise(r => setTimeout(r, 200));

    await jsonPost('/auth/magic-link/verify', { token: capturedMagicToken! });

    const loginEvent = emitted.find(e => e.event === 'security.auth.login.success');
    expect(loginEvent).toBeDefined();
  });

  test('returns email in response body', async () => {
    const hash = await Bun.password.hash('SomePass123!');
    await runtime.adapter.create('alice@example.com', hash);

    await jsonPost('/auth/magic-link/request', { identifier: 'alice@example.com' });
    await new Promise(r => setTimeout(r, 200));

    const res = await jsonPost('/auth/magic-link/verify', { token: capturedMagicToken! });
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.email).toBe('alice@example.com');
  });

  test('successful verify marks the account email as verified for email-primary apps', async () => {
    runtime.config = {
      ...runtime.config,
      primaryField: 'email',
      emailVerification: { required: true, tokenExpiry: 86400 },
    };
    app = buildApp(runtime);

    const hash = await Bun.password.hash('SomePass123!');
    const { id: userId } = await runtime.adapter.create('verify-state@example.com', hash);
    await runtime.adapter.setEmailVerified?.(userId, false);

    await jsonPost('/auth/magic-link/request', { identifier: 'verify-state@example.com' });
    await new Promise(r => setTimeout(r, 200));

    const res = await jsonPost('/auth/magic-link/verify', { token: capturedMagicToken! });
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.emailVerified).toBe(true);
    expect(await runtime.adapter.getEmailVerified?.(userId)).toBe(true);
  });

  test('suspended account returns 403 on verify', async () => {
    const hash = await Bun.password.hash('SomePass123!');
    const { id: userId } = await runtime.adapter.create('alice@example.com', hash);

    await jsonPost('/auth/magic-link/request', { identifier: 'alice@example.com' });
    await new Promise(r => setTimeout(r, 200));

    // Suspend the account
    await runtime.adapter.setSuspended!(userId, true, 'test suspension');

    const res = await jsonPost('/auth/magic-link/verify', { token: capturedMagicToken! });
    expect(res.status).toBe(403);

    const body = await res.json();
    expect(body.error).toContain('suspended');
  });

  test('emits login blocked event for suspended account', async () => {
    const hash = await Bun.password.hash('SomePass123!');
    const { id: userId } = await runtime.adapter.create('alice@example.com', hash);

    await jsonPost('/auth/magic-link/request', { identifier: 'alice@example.com' });
    await new Promise(r => setTimeout(r, 200));

    await runtime.adapter.setSuspended!(userId, true, 'test suspension');

    await jsonPost('/auth/magic-link/verify', { token: capturedMagicToken! });

    const blockedEvent = emitted.find(e => e.event === 'security.auth.login.blocked');
    expect(blockedEvent).toBeDefined();
  });
});
