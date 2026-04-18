/**
 * Tests for F13 — reserved JWT claim stripping in postLogin hook.
 *
 * Before F13, a `postLogin` hook could return `customClaims` containing JOSE-
 * managed fields like `sub`, `exp`, `iat`, `iss`, `aud`, `jti`, etc. and those
 * would be included in the token payload, potentially overriding the identity
 * claims set by the auth system. After F13, the `RESERVED_CLAIMS` set strips
 * these before the claims object is passed to `signToken`.
 *
 * Covers:
 *   - Hook-injected `sub` does NOT override the real userId in the JWT
 *   - Hook-injected `exp: 0` does NOT zero out the expiry
 *   - Hook-injected `iss` is stripped (no issuer configured in test)
 *   - Legitimate custom claims (e.g. `role`, `tenantId`) are preserved
 *   - postLogin hook with no customClaims is still harmless (token has correct sub/sid)
 */
import { beforeEach, describe, expect, test } from 'bun:test';
import { verifyToken } from '../../src/lib/jwt';
import { createLoginRouter } from '../../src/routes/login';
import { makeTestRuntime, wrapWithRuntime } from '../helpers/runtime';

const jsonPost = (body: Record<string, unknown>) => ({
  method: 'POST' as const,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

describe('reserved JWT claims stripping via postLogin hook (F13)', () => {
  test('hook cannot override sub — token still carries real userId', async () => {
    const runtime = makeTestRuntime({
      hooks: {
        postLogin: async () => ({
          customClaims: { sub: 'evil-override', customField: 'allowed' },
        }),
      },
    });

    const hash = await Bun.password.hash('Pass1234!');
    const { id: realUserId } = await runtime.adapter.create('reserved-sub@example.com', hash);

    const app = wrapWithRuntime(runtime);
    app.route('/', createLoginRouter({ primaryField: 'email' }, runtime));

    const res = await app.request(
      '/auth/login',
      jsonPost({ email: 'reserved-sub@example.com', password: 'Pass1234!' }),
    );
    expect(res.status).toBe(200);
    const { token } = await res.json();

    const payload = await verifyToken(token, runtime.config, runtime.signing);
    expect(payload.sub).toBe(realUserId); // not 'evil-override'
    expect(payload['customField']).toBe('allowed'); // custom field preserved
  });

  test('hook cannot set exp:0 — token has a valid positive expiry', async () => {
    const runtime = makeTestRuntime({
      hooks: {
        postLogin: async () => ({
          customClaims: { exp: 0, iat: 0 },
        }),
      },
    });

    const hash = await Bun.password.hash('Pass1234!');
    await runtime.adapter.create('reserved-exp@example.com', hash);

    const app = wrapWithRuntime(runtime);
    app.route('/', createLoginRouter({ primaryField: 'email' }, runtime));

    const res = await app.request(
      '/auth/login',
      jsonPost({ email: 'reserved-exp@example.com', password: 'Pass1234!' }),
    );
    expect(res.status).toBe(200);
    const { token } = await res.json();

    const payload = await verifyToken(token, runtime.config, runtime.signing);
    // exp must be a positive Unix timestamp in the future — not 0
    expect(payload.exp).toBeGreaterThan(Math.floor(Date.now() / 1000));
  });

  test('hook cannot inject iss/aud — token issuer/audience stay unset when not configured', async () => {
    const runtime = makeTestRuntime({
      hooks: {
        postLogin: async () => ({
          customClaims: { iss: 'evil-issuer', aud: 'evil-audience' },
        }),
      },
    });

    const hash = await Bun.password.hash('Pass1234!');
    await runtime.adapter.create('reserved-iss@example.com', hash);

    const app = wrapWithRuntime(runtime);
    app.route('/', createLoginRouter({ primaryField: 'email' }, runtime));

    const res = await app.request(
      '/auth/login',
      jsonPost({ email: 'reserved-iss@example.com', password: 'Pass1234!' }),
    );
    expect(res.status).toBe(200);
    const { token } = await res.json();

    // Verify without iss/aud options (no issuer configured in test runtime)
    const payload = await verifyToken(token, runtime.config, runtime.signing);
    // jose sets iss/aud from config.jwt — test runtime has none, so neither should appear
    expect(payload.iss).toBeUndefined();
    expect(payload.aud).toBeUndefined();
  });

  test('multiple legitimate custom claims are all preserved in the token', async () => {
    const runtime = makeTestRuntime({
      hooks: {
        postLogin: async ({ userId }: { userId: string }) => ({
          customClaims: {
            // Reserved (stripped)
            sub: 'evil',
            jti: 'evil-jti',
            nbf: 0,
            // Allowed
            tenantId: 'tenant-abc',
            plan: 'pro',
            featureFlags: ['beta'],
          },
        }),
      },
    });

    const hash = await Bun.password.hash('Pass1234!');
    const { id: realId } = await runtime.adapter.create('multi-claims@example.com', hash);

    const app = wrapWithRuntime(runtime);
    app.route('/', createLoginRouter({ primaryField: 'email' }, runtime));

    const res = await app.request(
      '/auth/login',
      jsonPost({ email: 'multi-claims@example.com', password: 'Pass1234!' }),
    );
    expect(res.status).toBe(200);
    const { token } = await res.json();
    const payload = await verifyToken(token, runtime.config, runtime.signing);

    expect(payload.sub).toBe(realId);
    expect(payload['tenantId']).toBe('tenant-abc');
    expect(payload['plan']).toBe('pro');
    expect(payload['featureFlags']).toEqual(['beta']);
    expect(typeof payload.jti).toBe('string');
  });

  test('postLogin hook with no customClaims produces a valid token with correct sub', async () => {
    const runtime = makeTestRuntime({
      hooks: {
        postLogin: async () => ({ customClaims: undefined }),
      },
    });

    const hash = await Bun.password.hash('Pass1234!');
    const { id: realId } = await runtime.adapter.create('no-claims@example.com', hash);

    const app = wrapWithRuntime(runtime);
    app.route('/', createLoginRouter({ primaryField: 'email' }, runtime));

    const res = await app.request(
      '/auth/login',
      jsonPost({ email: 'no-claims@example.com', password: 'Pass1234!' }),
    );
    expect(res.status).toBe(200);
    const { token } = await res.json();
    const payload = await verifyToken(token, runtime.config, runtime.signing);

    expect(payload.sub).toBe(realId);
    expect(typeof payload.sid).toBe('string');
    expect(payload.exp).toBeGreaterThan(0);
  });
});
