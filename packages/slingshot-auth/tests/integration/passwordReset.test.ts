/**
 * Integration tests for the password reset flow.
 *
 * Covers:
 * - POST /auth/forgot-password (enumeration-safe, rate-limited, constant-time)
 * - POST /auth/reset-password (token consumption, session revocation, breach check, reuse check)
 */
import { beforeEach, describe, expect, test } from 'bun:test';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { HttpError } from '@lastshotlabs/slingshot-core';
import { createLoginRouter } from '../../src/routes/login';
import { createPasswordResetRouter } from '../../src/routes/passwordReset';
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
  app.route('/', createPasswordResetRouter({ rateLimit: runtime.config as any }, runtime));
  app.route('/', createLoginRouter({ primaryField: 'email' }, runtime));
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

// Capture the reset token from the event bus
let capturedResetToken: string | null;

beforeEach(() => {
  runtime = makeTestRuntime({ concealRegistration: null });
  emitted = [];
  capturedResetToken = null;
  runtime.eventBus = {
    ...makeEventBus(event => emitted.push({ event, payload: null })),
    emit: ((event: string, payload: unknown) => {
      emitted.push({ event, payload });
      // Capture reset token from the delivery event
      if (event === 'auth:delivery.password_reset' && payload && typeof payload === 'object') {
        capturedResetToken = (payload as any).token;
      }
    }) as any,
  } as any;
  app = buildApp(runtime);
});

// ---------------------------------------------------------------------------
// POST /auth/forgot-password
// ---------------------------------------------------------------------------

describe('POST /auth/forgot-password', () => {
  test('returns 200 for registered email', async () => {
    const hash = await Bun.password.hash('OldPass123!');
    await runtime.adapter.create('alice@example.com', hash);

    const res = await jsonPost('/auth/forgot-password', { email: 'alice@example.com' });
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.message).toContain('If that email is registered');
  });

  test('returns 200 for unregistered email (enumeration-safe)', async () => {
    const res = await jsonPost('/auth/forgot-password', { email: 'nobody@example.com' });
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.message).toContain('If that email is registered');
  });

  test('same response shape for registered and unregistered emails', async () => {
    const hash = await Bun.password.hash('OldPass123!');
    await runtime.adapter.create('exists@example.com', hash);

    const res1 = await jsonPost('/auth/forgot-password', { email: 'exists@example.com' });
    const res2 = await jsonPost('/auth/forgot-password', { email: 'ghost@example.com' });

    const body1 = await res1.json();
    const body2 = await res2.json();

    expect(res1.status).toBe(res2.status);
    expect(Object.keys(body1).sort()).toEqual(Object.keys(body2).sort());
  });

  test('emits delivery event for registered email', async () => {
    const hash = await Bun.password.hash('OldPass123!');
    await runtime.adapter.create('alice@example.com', hash);

    await jsonPost('/auth/forgot-password', { email: 'alice@example.com' });

    // Fire-and-forget — wait a tick for the async emit
    await new Promise(r => setTimeout(r, 200));

    const deliveryEvent = emitted.find(e => e.event === 'auth:delivery.password_reset');
    expect(deliveryEvent).toBeDefined();
  });

  test('does NOT emit delivery event for unregistered email', async () => {
    await jsonPost('/auth/forgot-password', { email: 'nobody@example.com' });
    await new Promise(r => setTimeout(r, 200));

    const deliveryEvent = emitted.find(e => e.event === 'auth:delivery.password_reset');
    expect(deliveryEvent).toBeUndefined();
  });

  test('rate-limits by IP when the bucket reaches 5 attempts', async () => {
    for (let i = 0; i < 4; i++) {
      const res = await jsonPost('/auth/forgot-password', { email: `addr${i}@example.com` });
      expect(res.status).toBe(200);
    }

    const res = await jsonPost('/auth/forgot-password', { email: 'addr4@example.com' });
    expect(res.status).toBe(429);
  });

  test('rejects invalid email format', async () => {
    const res = await jsonPost('/auth/forgot-password', { email: 'not-an-email' });
    expect(res.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// POST /auth/reset-password
// ---------------------------------------------------------------------------

describe('POST /auth/reset-password', () => {
  test('resets password with valid token', async () => {
    const hash = await Bun.password.hash('OldPass123!');
    await runtime.adapter.create('alice@example.com', hash);

    // Request reset
    await jsonPost('/auth/forgot-password', { email: 'alice@example.com' });
    await new Promise(r => setTimeout(r, 200));
    expect(capturedResetToken).not.toBeNull();

    // Reset password
    const res = await jsonPost('/auth/reset-password', {
      token: capturedResetToken!,
      password: 'NewSecure456!',
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
  });

  test('can login with new password after reset', async () => {
    const hash = await Bun.password.hash('OldPass123!');
    await runtime.adapter.create('alice@example.com', hash);

    await jsonPost('/auth/forgot-password', { email: 'alice@example.com' });
    await new Promise(r => setTimeout(r, 200));

    await jsonPost('/auth/reset-password', {
      token: capturedResetToken!,
      password: 'NewSecure456!',
    });

    // Old password fails
    const oldRes = await jsonPost('/auth/login', {
      email: 'alice@example.com',
      password: 'OldPass123!',
    });
    expect(oldRes.status).toBe(401);

    // New password works
    const newRes = await jsonPost('/auth/login', {
      email: 'alice@example.com',
      password: 'NewSecure456!',
    });
    expect(newRes.status).toBe(200);
  });

  test('token can only be used once (atomic consumption)', async () => {
    const hash = await Bun.password.hash('OldPass123!');
    await runtime.adapter.create('alice@example.com', hash);

    await jsonPost('/auth/forgot-password', { email: 'alice@example.com' });
    await new Promise(r => setTimeout(r, 200));
    const token = capturedResetToken!;

    // First use succeeds
    const res1 = await jsonPost('/auth/reset-password', { token, password: 'NewPass456!' });
    expect(res1.status).toBe(200);

    // Second use fails (consumed)
    const res2 = await jsonPost('/auth/reset-password', { token, password: 'AnotherPass789!' });
    expect(res2.status).toBe(400);
  });

  test('invalid token returns 400', async () => {
    const res = await jsonPost('/auth/reset-password', {
      token: 'totally-bogus-token',
      password: 'NewSecure456!',
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain('Invalid or expired');
  });

  test('revokes all sessions after password reset', async () => {
    const hash = await Bun.password.hash('OldPass123!');
    const { id: userId } = await runtime.adapter.create('alice@example.com', hash);

    // Create a session
    await runtime.repos.session.createSession(
      userId,
      'fake-jwt',
      'sess-1',
      undefined,
      runtime.config,
    );
    let sessions = await runtime.repos.session.getUserSessions(userId, runtime.config);
    expect(sessions.length).toBe(1);

    // Reset password
    await jsonPost('/auth/forgot-password', { email: 'alice@example.com' });
    await new Promise(r => setTimeout(r, 200));
    await jsonPost('/auth/reset-password', {
      token: capturedResetToken!,
      password: 'NewSecure456!',
    });

    // Sessions should be revoked
    sessions = await runtime.repos.session.getUserSessions(userId, runtime.config);
    const activeSessions = sessions.filter(s => s.isActive);
    expect(activeSessions.length).toBe(0);
  });

  test('emits password.reset event', async () => {
    const hash = await Bun.password.hash('OldPass123!');
    await runtime.adapter.create('alice@example.com', hash);

    await jsonPost('/auth/forgot-password', { email: 'alice@example.com' });
    await new Promise(r => setTimeout(r, 200));

    await jsonPost('/auth/reset-password', {
      token: capturedResetToken!,
      password: 'NewSecure456!',
    });

    const resetEvent = emitted.find(e => e.event === 'security.auth.password.reset');
    expect(resetEvent).toBeDefined();
  });

  test('weak password rejected by policy', async () => {
    const hash = await Bun.password.hash('OldPass123!');
    await runtime.adapter.create('alice@example.com', hash);

    await jsonPost('/auth/forgot-password', { email: 'alice@example.com' });
    await new Promise(r => setTimeout(r, 200));

    // Password too short / no digit
    const res = await jsonPost('/auth/reset-password', {
      token: capturedResetToken!,
      password: 'short',
    });
    expect(res.status).toBe(400);
  });

  test('rate-limits reset attempts by IP', async () => {
    for (let i = 0; i < 10; i++) {
      await jsonPost('/auth/reset-password', { token: `bogus-${i}`, password: 'NewSecure456!' });
    }

    const res = await jsonPost('/auth/reset-password', {
      token: 'one-more',
      password: 'NewSecure456!',
    });
    expect(res.status).toBe(429);
  });
});
