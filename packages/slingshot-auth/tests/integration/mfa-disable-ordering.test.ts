/**
 * Tests for F12 ordering — MFA disable rate limit fires before factor verification.
 *
 * The DELETE /auth/mfa handler evaluates guards in this order:
 *   1. Rate limit check  → returns 429 if exceeded
 *   2. Method presence   → returns 400 if missing
 *   3. Factor verification → returns 401 if invalid
 *
 * Confirming ordering matters: a rate limit hit must return 429 even when the
 * request body is invalid, so that attackers cannot bypass rate limiting by
 * sending malformed requests that would otherwise short-circuit at step 2.
 *
 * Covers:
 *   - First N requests with missing method → 400 (rate limit not yet hit)
 *   - (N+1)th request → 429 even though body is still invalid
 *   - Rate limit also fires before factor verification (401 never beats 429)
 */
import { beforeEach, describe, expect, test } from 'bun:test';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { HttpError } from '@lastshotlabs/slingshot-core';
import { createMfaRouter } from '../../src/routes/mfa';
import { makeTestRuntime, wrapWithRuntime } from '../helpers/runtime';

type TestRuntime = ReturnType<typeof makeTestRuntime>;

function buildMfaApp(
  runtime: TestRuntime,
  userId: string,
  rateLimit?: { mfaDisable?: { max: number; windowMs: number } },
) {
  const app = wrapWithRuntime(runtime);
  // Handle HttpError thrown by the route (e.g. 400 for missing method, 401 for bad factor).
  app.onError((err, c) =>
    c.json(
      { error: err.message },
      (err instanceof HttpError ? err.status : 500) as ContentfulStatusCode,
    ),
  );
  app.use('*', async (c, next) => {
    c.set('authUserId', userId);
    c.set('sessionId', 'test-session');
    await next();
  });
  app.route('/', createMfaRouter({ rateLimit }, runtime));
  return app;
}

describe('DELETE /auth/mfa — rate limit ordering (F12)', () => {
  let runtime: TestRuntime;
  let userId: string;

  beforeEach(async () => {
    runtime = makeTestRuntime({ mfa: { issuer: 'TestApp' } });
    const { id } = await runtime.adapter.create('mfa-order@example.com', '');
    userId = id;
  });

  test('rate limit fires before method-missing check: 429 beats 400', async () => {
    // max=2: rate limit fires when count > 2, so first two requests pass through to the
    // method-missing check (400), and the third is blocked by the rate limit (429).
    const app = buildMfaApp(runtime, userId, {
      mfaDisable: { max: 3, windowMs: 60_000 },
    });

    const deleteRequest = () =>
      app.request('/auth/mfa', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}), // missing method — would give 400 if rate limit not hit
      });

    // First two requests: counter at 1 and 2 respectively — not > max=2 → 400 (method missing)
    const r1 = await deleteRequest();
    expect(r1.status).toBe(400);

    const r2 = await deleteRequest();
    expect(r2.status).toBe(400);

    // Third request: counter at 3 > max=2 → 429 returned BEFORE method check
    const r3 = await deleteRequest();
    expect(r3.status).toBe(429);
    const body = await r3.json();
    expect(body.error).toMatch(/too many.*mfa|try again/i);
  });

  test('rate limit also fires before factor verification: 429 beats 401', async () => {
    // max=2: same reasoning as above — two 401s pass through, third is rate-limited.
    const app = buildMfaApp(runtime, userId, {
      mfaDisable: { max: 3, windowMs: 60_000 },
    });

    const deleteWithBadCode = () =>
      app.request('/auth/mfa', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ method: 'totp', code: '000000' }), // invalid code → 401
      });

    // First two fail with 401 (wrong code) but still increment counter
    const r1 = await deleteWithBadCode();
    expect(r1.status).toBe(401);

    const r2 = await deleteWithBadCode();
    expect(r2.status).toBe(401);

    // Third request: rate limit exceeded → 429, not 401
    const r3 = await deleteWithBadCode();
    expect(r3.status).toBe(429);
  });

  test('each user has an independent MFA disable rate limit counter', async () => {
    const { id: userId2 } = await runtime.adapter.create('mfa-order2@example.com', '');

    const app1 = buildMfaApp(runtime, userId, { mfaDisable: { max: 3, windowMs: 60_000 } });
    const app2 = buildMfaApp(runtime, userId2, { mfaDisable: { max: 3, windowMs: 60_000 } });

    // Exhaust user1's rate limit
    await app1.request('/auth/mfa', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    await app1.request('/auth/mfa', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    const blocked1 = await app1.request('/auth/mfa', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    expect(blocked1.status).toBe(429);

    // user2's counter is independent — still gets 400 (method missing), not 429
    const user2Res = await app2.request('/auth/mfa', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    expect(user2Res.status).toBe(400);
  });
});
