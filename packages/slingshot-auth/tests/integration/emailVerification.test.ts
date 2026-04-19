/**
 * Integration tests for the email verification flow.
 *
 * Covers:
 * - POST /auth/verify-email (token consumption, email verified flag)
 * - POST /auth/resend-verification (enumeration-safe, timing-safe, rate-limited)
 */
import { beforeEach, describe, expect, test } from 'bun:test';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { HttpError } from '@lastshotlabs/slingshot-core';
import { createVerificationToken } from '../../src/lib/emailVerification';
import { createEmailVerificationRouter } from '../../src/routes/emailVerification';
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
    createEmailVerificationRouter(
      { primaryField: 'email', emailVerification: { required: true } },
      runtime,
    ),
  );
  return app;
}

let app: ReturnType<typeof buildApp>;
let runtime: MutableTestRuntime;
let emitted: string[];

beforeEach(() => {
  runtime = makeTestRuntime({ concealRegistration: null });
  emitted = [];
  runtime.eventBus = makeEventBus(event => emitted.push(event));
  app = buildApp(runtime);
});

const jsonPost = (path: string, body: Record<string, unknown>) =>
  app.request(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

// ---------------------------------------------------------------------------
// POST /auth/verify-email
// ---------------------------------------------------------------------------

describe('POST /auth/verify-email', () => {
  test('verifies email with valid token', async () => {
    const hash = await Bun.password.hash('Pass1234!');
    const { id: userId } = await runtime.adapter.create('alice@example.com', hash);

    const token = await createVerificationToken(
      runtime.repos.verificationToken,
      userId,
      'alice@example.com',
      runtime.config,
    );

    const res = await jsonPost('/auth/verify-email', { token });
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.ok).toBe(true);
  });

  test('sets emailVerified flag on adapter', async () => {
    const hash = await Bun.password.hash('Pass1234!');
    const { id: userId } = await runtime.adapter.create('alice@example.com', hash);

    // Verify it's initially false
    const before = await runtime.adapter.getEmailVerified!(userId);
    expect(before).toBe(false);

    const token = await createVerificationToken(
      runtime.repos.verificationToken,
      userId,
      'alice@example.com',
      runtime.config,
    );

    await jsonPost('/auth/verify-email', { token });

    const after = await runtime.adapter.getEmailVerified!(userId);
    expect(after).toBe(true);
  });

  test('emits email.verified event', async () => {
    const hash = await Bun.password.hash('Pass1234!');
    const { id: userId } = await runtime.adapter.create('alice@example.com', hash);

    const token = await createVerificationToken(
      runtime.repos.verificationToken,
      userId,
      'alice@example.com',
      runtime.config,
    );

    await jsonPost('/auth/verify-email', { token });

    expect(emitted).toContain('auth:email.verified');
  });

  test('invalid token returns 400', async () => {
    const res = await jsonPost('/auth/verify-email', { token: 'bogus-token' });
    expect(res.status).toBe(400);

    const body = await res.json();
    expect(body.error).toContain('Invalid or expired');
  });

  test('token can only be used once', async () => {
    const hash = await Bun.password.hash('Pass1234!');
    const { id: userId } = await runtime.adapter.create('alice@example.com', hash);

    const token = await createVerificationToken(
      runtime.repos.verificationToken,
      userId,
      'alice@example.com',
      runtime.config,
    );

    const res1 = await jsonPost('/auth/verify-email', { token });
    expect(res1.status).toBe(200);

    const res2 = await jsonPost('/auth/verify-email', { token });
    expect(res2.status).toBe(400);
  });

  test('rate-limits by IP after 10 attempts', async () => {
    for (let i = 0; i < 10; i++) {
      await jsonPost('/auth/verify-email', { token: `bogus-${i}` });
    }

    const res = await jsonPost('/auth/verify-email', { token: 'one-more' });
    expect(res.status).toBe(429);
  });
});

// ---------------------------------------------------------------------------
// POST /auth/resend-verification
// ---------------------------------------------------------------------------

describe('POST /auth/resend-verification', () => {
  test('sends verification email with valid credentials', async () => {
    const hash = await Bun.password.hash('Pass1234!');
    await runtime.adapter.create('alice@example.com', hash);

    const res = await jsonPost('/auth/resend-verification', {
      email: 'alice@example.com',
      password: 'Pass1234!',
    });
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(typeof body.message).toBe('string');

    expect(emitted).toContain('auth:delivery.email_verification');
  });

  test('returns 401 for wrong password', async () => {
    const hash = await Bun.password.hash('Pass1234!');
    await runtime.adapter.create('alice@example.com', hash);

    const res = await jsonPost('/auth/resend-verification', {
      email: 'alice@example.com',
      password: 'WrongPassword!',
    });
    expect(res.status).toBe(401);
  });

  test('returns 401 for non-existent user (enumeration-safe)', async () => {
    const res = await jsonPost('/auth/resend-verification', {
      email: 'nobody@example.com',
      password: 'SomePass123!',
    });
    // Uses getDummyHash() to verify against a real hash — timing-safe rejection
    expect(res.status).toBe(401);
  });

  test('returns 200 even when already verified (no status leak)', async () => {
    const hash = await Bun.password.hash('Pass1234!');
    const { id: userId } = await runtime.adapter.create('alice@example.com', hash);
    await runtime.adapter.setEmailVerified!(userId, true);

    const res = await jsonPost('/auth/resend-verification', {
      email: 'alice@example.com',
      password: 'Pass1234!',
    });
    // Returns 200 — NOT 400 or 409 — to prevent revealing verification status
    expect(res.status).toBe(200);

    // But does NOT emit delivery event (no need to re-send)
    expect(emitted).not.toContain('auth:delivery.email_verification');
  });

  test('rate-limits by identifier after 3 attempts', async () => {
    const hash = await Bun.password.hash('Pass1234!');
    await runtime.adapter.create('alice@example.com', hash);

    for (let i = 0; i < 3; i++) {
      await jsonPost('/auth/resend-verification', {
        email: 'alice@example.com',
        password: 'Pass1234!',
      });
    }

    const res = await jsonPost('/auth/resend-verification', {
      email: 'alice@example.com',
      password: 'Pass1234!',
    });
    expect(res.status).toBe(429);
  });

  // Note: timing safety is enforced by the dummy hash in the route handler,
  // but testing timing in CI is unreliable. The route always calls password.verify()
  // even for non-existent users to equalize response time.
});
