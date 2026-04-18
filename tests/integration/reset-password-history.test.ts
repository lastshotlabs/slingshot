/**
 * Integration tests for the POST /auth/reset-password route with password
 * history enforcement.
 *
 * Uses `makeTestRuntime` + `createResetToken` to inject a real reset token
 * directly into the repo (bypassing email delivery) so the route can be
 * exercised end-to-end without a mail transport.
 *
 * Covers:
 *   - Reset-password with a previously-used password returns 400 PASSWORD_PREVIOUSLY_USED
 *   - Reset-password with a new password returns 200 { ok: true }
 *   - Reset token is single-use: second attempt with the same token returns 400
 *   - All active sessions are revoked after a successful reset
 */
import { recordPasswordChange } from '@auth/lib/passwordHistory';
import { createResetToken } from '@auth/lib/resetPassword';
import { createPasswordResetRouter } from '@auth/routes/passwordReset';
import { beforeEach, describe, expect, test } from 'bun:test';
import {
  makeTestRuntime,
  wrapWithRuntime,
} from '../../packages/slingshot-auth/tests/helpers/runtime';

const json = (body: Record<string, unknown>) => ({
  method: 'POST' as const,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

function buildApp(runtime: ReturnType<typeof makeTestRuntime>) {
  const app = wrapWithRuntime(runtime);
  app.onError((err: any, c) => c.json({ error: err.message, code: err?.code }, err?.status ?? 500));
  app.route('/', createPasswordResetRouter({}, runtime));
  return app;
}

describe('POST /auth/reset-password — password history enforcement', () => {
  let runtime: ReturnType<typeof makeTestRuntime>;

  beforeEach(() => {
    runtime = makeTestRuntime({
      passwordReset: { tokenExpiry: 3600 },
      passwordPolicy: { preventReuse: 3 },
    });
  });

  test('previously-used password returns 400 PASSWORD_PREVIOUSLY_USED', async () => {
    const email = 'rh-reuse@example.com';
    const initialHash = await Bun.password.hash('InitialPass1!');
    const { id: userId } = await runtime.adapter.create(email, initialHash);
    // Seed 'InitialPass1!' into history so the route sees it as reused
    await recordPasswordChange(runtime.adapter, userId, initialHash, 5);

    const rawToken = await createResetToken(
      runtime.repos.resetToken,
      userId,
      email,
      runtime.config,
    );

    const app = buildApp(runtime);
    const res = await app.request(
      '/auth/reset-password',
      json({ token: rawToken, password: 'InitialPass1!' }),
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe('PASSWORD_PREVIOUSLY_USED');
  });

  test('new password returns 200 { ok: true }', async () => {
    const email = 'rh-ok@example.com';
    const initialHash = await Bun.password.hash('InitialPass1!');
    const { id: userId } = await runtime.adapter.create(email, initialHash);

    const rawToken = await createResetToken(
      runtime.repos.resetToken,
      userId,
      email,
      runtime.config,
    );

    const app = buildApp(runtime);
    const res = await app.request(
      '/auth/reset-password',
      json({ token: rawToken, password: 'BrandNew1!X' }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
  });

  test('token is single-use: second attempt returns 400 invalid token', async () => {
    const email = 'rh-replay@example.com';
    const hash = await Bun.password.hash('InitialPass1!');
    const { id: userId } = await runtime.adapter.create(email, hash);

    const rawToken = await createResetToken(
      runtime.repos.resetToken,
      userId,
      email,
      runtime.config,
    );

    const app = buildApp(runtime);
    // First use — succeeds
    await app.request('/auth/reset-password', json({ token: rawToken, password: 'NewPass1!X' }));
    // Second use — token already consumed
    const res = await app.request(
      '/auth/reset-password',
      json({ token: rawToken, password: 'AnotherPass1!' }),
    );
    expect(res.status).toBe(400);
  });

  test('all sessions are revoked after a successful reset', async () => {
    const email = 'rh-sessions@example.com';
    const hash = await Bun.password.hash('InitialPass1!');
    const { id: userId } = await runtime.adapter.create(email, hash);

    // Create a session for the user
    await runtime.repos.session.atomicCreateSession(
      userId,
      'tok-before-reset',
      'sess-before-reset',
      3600,
      {},
      runtime.config,
    );

    const rawToken = await createResetToken(
      runtime.repos.resetToken,
      userId,
      email,
      runtime.config,
    );

    const app = buildApp(runtime);
    await app.request('/auth/reset-password', json({ token: rawToken, password: 'NewPass99!X' }));

    // Session token should be gone after reset
    const found = await runtime.repos.session.getSession('sess-before-reset', runtime.config);
    expect(found).toBeNull();
  });
});
