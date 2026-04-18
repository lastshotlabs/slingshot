/**
 * Tests for F7 — credential stuffing detection wired into the login route.
 *
 * After F7, `trackFailedLogin()` returns a boolean and the login route
 * emits `security.credential_stuffing.detected` when the return value is
 * `true`. Subsequent requests where `isStuffingBlocked()` is already true
 * also emit the event and return 429.
 *
 * Covers:
 *   - `trackFailedLogin` triggers event and blocks when threshold crossed
 *   - `isStuffingBlocked` triggers event + 429 on follow-up requests
 *   - Below-threshold failed logins do NOT emit the detection event
 */
import { beforeEach, describe, expect, test } from 'bun:test';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { HttpError } from '@lastshotlabs/slingshot-core';
import {
  createCredentialStuffingService,
  createMemoryCredentialStuffingRepository,
} from '../../src/lib/credentialStuffing';
import { createLoginRouter } from '../../src/routes/login';
import { makeEventBus, makeTestRuntime, wrapWithRuntime } from '../helpers/runtime';

const jsonPost = (body: Record<string, unknown>) => ({
  method: 'POST' as const,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

function buildApp(
  runtime: ReturnType<typeof makeTestRuntime>,
  opts: { maxAccountsPerIp?: number } = {},
) {
  runtime.credentialStuffing = createCredentialStuffingService(
    {
      maxAccountsPerIp: {
        count: opts.maxAccountsPerIp ?? 2,
        windowMs: 60_000,
      },
    },
    createMemoryCredentialStuffingRepository(),
  );

  const app = wrapWithRuntime(runtime);
  // Handle HttpError thrown by the route (e.g. 429 for stuffing-blocked).
  app.onError((err, c) =>
    c.json(
      { error: err.message },
      (err instanceof HttpError ? err.status : 500) as ContentfulStatusCode,
    ),
  );
  app.route('/', createLoginRouter({ primaryField: 'email' }, runtime));
  return app;
}

describe('credential stuffing detection on login route', () => {
  let runtime: ReturnType<typeof makeTestRuntime>;
  let emitted: string[];

  beforeEach(() => {
    runtime = makeTestRuntime();
    emitted = [];
    runtime.eventBus = makeEventBus(event => emitted.push(event));
  });

  test('failed logins below threshold do not emit credential_stuffing.detected', async () => {
    const app = buildApp(runtime, { maxAccountsPerIp: 3 }); // threshold = 3

    // One failed login — below threshold
    await app.request('/auth/login', jsonPost({ email: 'nonexist1@example.com', password: 'x' }));

    expect(emitted).not.toContain('security.credential_stuffing.detected');
  });

  test('trackFailedLogin emits detected event when threshold is crossed', async () => {
    const app = buildApp(runtime, { maxAccountsPerIp: 2 }); // blocks at 2 distinct accounts per IP

    // 1st failed login (count=1, not blocked yet)
    await app.request('/auth/login', jsonPost({ email: 'victim1@example.com', password: 'bad' }));
    expect(emitted).not.toContain('security.credential_stuffing.detected');

    // 2nd failed login with DIFFERENT account from same IP (count=2 >= threshold → blocked)
    await app.request('/auth/login', jsonPost({ email: 'victim2@example.com', password: 'bad' }));
    expect(emitted).toContain('security.credential_stuffing.detected');
  });

  test('isStuffingBlocked returns 429 and re-emits event on subsequent requests', async () => {
    const app = buildApp(runtime, { maxAccountsPerIp: 2 });

    // Cross the threshold with 2 failed logins
    await app.request('/auth/login', jsonPost({ email: 'victim3@example.com', password: 'bad' }));
    await app.request('/auth/login', jsonPost({ email: 'victim4@example.com', password: 'bad' }));
    emitted.length = 0; // reset — now test the already-blocked path

    // Any account from same IP → isStuffingBlocked returns true → 429 immediately
    const res = await app.request(
      '/auth/login',
      jsonPost({ email: 'any@example.com', password: 'bad' }),
    );
    expect(res.status).toBe(429);
    // Event also emitted from the isStuffingBlocked path
    expect(emitted).toContain('security.credential_stuffing.detected');
  });

  test('login with correct credentials succeeds while stuffing threshold is NOT crossed', async () => {
    const hash = await Bun.password.hash('GoodPass1!');
    await runtime.adapter.create('legit@example.com', hash);
    const app = buildApp(runtime, { maxAccountsPerIp: 5 }); // high threshold — won't trigger

    const res = await app.request(
      '/auth/login',
      jsonPost({ email: 'legit@example.com', password: 'GoodPass1!' }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(typeof body.token).toBe('string');
    expect(emitted).not.toContain('security.credential_stuffing.detected');
  });
});
