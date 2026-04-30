/**
 * Tests for F4 — OAuth unlink factor verification.
 *
 * Before F4, all 8 provider unlink routes allowed unlinking without any
 * credential check. After F4, accounts with a password or active MFA must
 * verify a factor before unlinking.
 *
 * Covers:
 *   - OAuth-only accounts bypass verification entirely (204)
 *   - Missing method when verification is required → 400
 *   - Invalid credentials → 401
 *   - Correct password → 204
 *   - Rate limit fires after max attempts → 429
 *   - Rate limit key is shared across providers (cross-provider counter)
 *   - Security event is emitted on successful unlink
 */
import { beforeEach, describe, expect, test } from 'bun:test';
import { setSuspended } from '../../../slingshot-auth/src/lib/suspension';
import { createOAuthRouter } from '../../src/routes/oauth';
import { makeTestRuntime, wrapWithRuntime } from '../helpers/runtime';

type TestRuntime = ReturnType<typeof makeTestRuntime>;

// Build a minimal app that bypasses the JWT-based userAuth by pre-setting
// the actor in the Hono context before the route middleware runs.
function buildApp(
  runtime: TestRuntime,
  userId: string,
  sessionId: string | null,
  providers: string[] = ['google'],
  rateLimit?: { oauthUnlink?: { max: number; windowMs: number } },
  actorKind: 'user' | 'service-account' | 'api-key' = 'user',
) {
  const app = wrapWithRuntime(runtime);
  // userAuth reads actor — pre-set it here so it passes.
  app.use('*', async (c, next) => {
    c.set(
      'actor',
      Object.freeze({
        id: userId,
        kind: actorKind,
        tenantId: null,
        sessionId,
        roles: null,
        claims: {},
      }),
    );
    await next();
  });
  app.route('/', createOAuthRouter(providers, '/', runtime, rateLimit));
  return app;
}

// ---------------------------------------------------------------------------
// OAuth-only bypass
// ---------------------------------------------------------------------------

describe('OAuth unlink — verification bypass for OAuth-only accounts', () => {
  let runtime: TestRuntime;

  beforeEach(() => {
    runtime = makeTestRuntime();
  });

  test('account with no password and no MFA can unlink without credentials (204)', async () => {
    const { id: userId } = await runtime.adapter.create('oauth-only@example.com', '');
    await runtime.adapter.linkProvider!(userId, 'google', 'g-sub-bypass');
    const app = buildApp(runtime, userId, 'sess-bypass');

    const res = await app.request('/auth/google/link', { method: 'DELETE' });
    expect(res.status).toBe(204);
  });

  test('successful unlink emits security.auth.oauth.unlinked event', async () => {
    const emitted: string[] = [];
    const runtime2 = makeTestRuntime({}, event => emitted.push(event));

    const { id: userId } = await runtime2.adapter.create('oauth-emit@example.com', '');
    await runtime2.adapter.linkProvider!(userId, 'google', 'g-sub-emit');

    const app = buildApp(runtime2, userId, 'sess-emit');
    const res = await app.request('/auth/google/link', { method: 'DELETE' });
    expect(res.status).toBe(204);
    expect(emitted).toContain('security.auth.oauth.unlinked');
  });
});

// ---------------------------------------------------------------------------
// Verification required (account has a password)
// ---------------------------------------------------------------------------

describe('OAuth unlink — factor verification required', () => {
  let runtime: TestRuntime;

  beforeEach(() => {
    runtime = makeTestRuntime();
  });

  test('user with password and no method provided returns 400', async () => {
    const { id: userId } = await runtime.adapter.create('has-pass@example.com', '');
    const hash = await Bun.password.hash('CorrectPass1!');
    await runtime.adapter.setPassword!(userId, hash);
    await runtime.adapter.linkProvider!(userId, 'google', 'g-sub-nomethod');
    const app = buildApp(runtime, userId, 'sess-nomethod');

    const res = await app.request('/auth/google/link', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.toLowerCase()).toMatch(/verification.*required|provide method/);
  });

  test('user with password and invalid credentials returns 401', async () => {
    const { id: userId } = await runtime.adapter.create('wrong-pass@example.com', '');
    const hash = await Bun.password.hash('CorrectPass1!');
    await runtime.adapter.setPassword!(userId, hash);
    await runtime.adapter.linkProvider!(userId, 'google', 'g-sub-wrong');
    const app = buildApp(runtime, userId, 'sess-wrong');

    const res = await app.request('/auth/google/link', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ method: 'password', password: 'WrongPass1!' }),
    });
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error.toLowerCase()).toMatch(/invalid verification/);
  });

  test('user with password and correct credentials can unlink (204)', async () => {
    const { id: userId } = await runtime.adapter.create('correct-pass@example.com', '');
    const hash = await Bun.password.hash('CorrectPass1!');
    await runtime.adapter.setPassword!(userId, hash);
    await runtime.adapter.linkProvider!(userId, 'google', 'g-sub-correct');
    const app = buildApp(runtime, userId, 'sess-correct');

    const res = await app.request('/auth/google/link', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ method: 'password', password: 'CorrectPass1!' }),
    });
    expect(res.status).toBe(204);
  });

  test('returns 403 for suspended accounts when route guard is responsible', async () => {
    runtime = makeTestRuntime({ checkSuspensionOnIdentify: false });

    const { id: userId } = await runtime.adapter.create('suspended-unlink@example.com', '');
    const hash = await Bun.password.hash('CorrectPass1!');
    await runtime.adapter.setPassword!(userId, hash);
    await runtime.adapter.linkProvider!(userId, 'google', 'g-sub-suspended');
    await setSuspended(runtime.adapter, userId, true, 'security hold');
    const app = buildApp(runtime, userId, 'sess-suspended');

    const res = await app.request('/auth/google/link', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ method: 'password', password: 'CorrectPass1!' }),
    });

    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toContain('suspended');
  });
});

// ---------------------------------------------------------------------------
// Rate limiting
// ---------------------------------------------------------------------------

describe('OAuth unlink — rate limiting', () => {
  test('rate limit returns 429 after max attempts', async () => {
    const runtime = makeTestRuntime();
    const { id: userId } = await runtime.adapter.create('rl@example.com', '');
    const app = buildApp(runtime, userId, 'sess-rl', ['google'], {
      oauthUnlink: { max: 2, windowMs: 60_000 },
    });

    let lastStatus = 0;
    for (let i = 0; i <= 2; i++) {
      const res = await app.request('/auth/google/link', { method: 'DELETE' });
      lastStatus = res.status;
      if (lastStatus === 429) break;
    }
    expect(lastStatus).toBe(429);
  });

  test('rate limit key is shared across providers — exhausting google blocks github', async () => {
    const runtime = makeTestRuntime();
    const { id: userId } = await runtime.adapter.create('cross-rl@example.com', '');

    // Mount both google and github unlink routes with max=2.
    const app = buildApp(runtime, userId, 'sess-cross', ['google', 'github'], {
      oauthUnlink: { max: 2, windowMs: 60_000 },
    });

    // Two attempts on google: count reaches max=2 (counter key is `oauth-unlink:${userId}`)
    await app.request('/auth/google/link', { method: 'DELETE' });
    await app.request('/auth/google/link', { method: 'DELETE' });

    // Third attempt via a different provider — same user, same counter → 429
    const res = await app.request('/auth/github/link', { method: 'DELETE' });
    expect(res.status).toBe(429);
  });
});

describe('OAuth unlink — provider coverage and actor semantics', () => {
  test('Apple linked accounts can be unlinked', async () => {
    const runtime = makeTestRuntime();
    const { id: userId } = await runtime.adapter.create('apple-unlink@example.com', '');
    await runtime.adapter.linkProvider!(userId, 'apple', 'apple-sub-1');
    const app = buildApp(runtime, userId, 'sess-apple', ['apple']);

    const res = await app.request('/auth/apple/link', { method: 'DELETE' });
    expect(res.status).toBe(204);
    const user = await runtime.adapter.getUser?.(userId);
    expect(user?.providerIds).not.toContain('apple:apple-sub-1');
  });

  test('service-account actors cannot use user OAuth unlink routes', async () => {
    const runtime = makeTestRuntime();
    const { id: userId } = await runtime.adapter.create('svc-unlink@example.com', '');
    await runtime.adapter.linkProvider!(userId, 'google', 'g-sub-svc');
    const app = buildApp(runtime, userId, null, ['google'], undefined, 'service-account');

    const res = await app.request('/auth/google/link', { method: 'DELETE' });
    expect(res.status).toBe(401);
  });
});
