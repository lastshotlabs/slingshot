/**
 * Tests for F3/F12 — rate limit on POST /auth/mfa/email-otp/enable.
 *
 * Before F12, the email OTP initiation endpoint had no rate limit. After F12,
 * it is gated by `mfaEmailOtpInitiateOpts` (default: 3/15min per user).
 * The rate limit fires before `MfaService.initiateEmailOtp` is called, so
 * even if email OTP is not fully configured the counter still increments and
 * returns 429 when exceeded.
 *
 * Also tests ordering: the rate limit fires before the 501 "not configured"
 * check, proving the guard is in the right place.
 */
import { beforeEach, describe, expect, test } from 'bun:test';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { HttpError } from '@lastshotlabs/slingshot-core';
import { createMfaRouter } from '../../src/routes/mfa';
import { makeTestRuntime, wrapWithRuntime } from '../helpers/runtime';

type TestRuntime = ReturnType<typeof makeTestRuntime>;

function buildApp(
  runtime: TestRuntime,
  userId: string,
  rateLimit?: { mfaEmailOtpInitiate?: { max: number; windowMs: number } },
) {
  const app = wrapWithRuntime(runtime);
  app.use('*', async (c, next) => {
    c.set(
      'actor',
      Object.freeze({
        id: userId,
        kind: 'user' as const,
        tenantId: null,
        sessionId: 'test-session',
        roles: null,
        claims: {},
      }),
    );
    await next();
  });
  // Handle HttpError thrown by the route (e.g. 501 for unconfigured OTP).
  app.onError((err, c) =>
    c.json(
      { error: err.message },
      (err instanceof HttpError ? err.status : 500) as ContentfulStatusCode,
    ),
  );
  app.route('/', createMfaRouter({ rateLimit }, runtime));
  return app;
}

describe('POST /auth/mfa/email-otp/enable — rate limit (F12)', () => {
  let runtime: TestRuntime;
  let userId: string;

  beforeEach(async () => {
    runtime = makeTestRuntime({ mfa: { issuer: 'TestApp' } });
    const { id } = await runtime.adapter.create('otp-rl@example.com', '');
    userId = id;
  });

  test('returns 429 after exceeding mfaEmailOtpInitiate rate limit', async () => {
    const app = buildApp(runtime, userId, {
      mfaEmailOtpInitiate: { max: 2, windowMs: 60_000 },
    });

    let lastStatus = 0;
    // max=2 means: 1st (count=1) and 2nd (count=2) pass; 3rd (count=3 > 2) returns 429
    for (let i = 0; i <= 2; i++) {
      const res = await app.request('/auth/mfa/email-otp/enable', { method: 'POST' });
      lastStatus = res.status;
      if (lastStatus === 429) break;
    }
    expect(lastStatus).toBe(429);
  });

  test('rate limit fires before email OTP "not configured" check (429 beats 501)', async () => {
    // Runtime with no email OTP mailer configured → initiateEmailOtp would throw 501.
    // max=1: count > 1 triggers rate limit, so first request (count=1) passes through to
    // the 501 check, and the second request (count=2) is blocked by the rate limit.
    const app = buildApp(runtime, userId, {
      mfaEmailOtpInitiate: { max: 2, windowMs: 60_000 },
    });

    // 1st request: count=1, 1 > max=1 is false → rate limit not exceeded → reaches 501 check
    const firstRes = await app.request('/auth/mfa/email-otp/enable', { method: 'POST' });
    expect(firstRes.status).not.toBe(429); // 501 or other, but not rate-limited yet

    // 2nd request: count=2 > max=1 → rate limit fires BEFORE 501 check → 429
    const secondRes = await app.request('/auth/mfa/email-otp/enable', { method: 'POST' });
    expect(secondRes.status).toBe(429);
    const body = await secondRes.json();
    expect(body.error).toMatch(/too many.*initiation|try again/i);
  });

  test('each user has an independent rate limit counter', async () => {
    const { id: userId2 } = await runtime.adapter.create('otp-rl2@example.com', '');

    // max=1: first request (count=1, not > 1) passes, second (count=2 > 1) is rate-limited.
    const app1 = buildApp(runtime, userId, { mfaEmailOtpInitiate: { max: 2, windowMs: 60_000 } });
    const app2 = buildApp(runtime, userId2, {
      mfaEmailOtpInitiate: { max: 2, windowMs: 60_000 },
    });

    // Exhaust user1's limit
    await app1.request('/auth/mfa/email-otp/enable', { method: 'POST' });
    const blockedRes = await app1.request('/auth/mfa/email-otp/enable', { method: 'POST' });
    expect(blockedRes.status).toBe(429);

    // user2 should NOT be blocked (independent counter)
    const user2Res = await app2.request('/auth/mfa/email-otp/enable', { method: 'POST' });
    expect(user2Res.status).not.toBe(429);
  });
});
