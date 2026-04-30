import { beforeEach, describe, expect, test } from 'bun:test';
import { createHmac } from 'crypto';
import { Hono } from 'hono';
import type { AppEnv } from '@lastshotlabs/slingshot-core';
import { csrfProtection } from '../../src/middleware/csrf';
import type { AuthRuntimeContext } from '../../src/runtime';
import { makeTestRuntime, wrapWithRuntime } from '../helpers/runtime';

// Constants mirror slingshot-core/src/constants.ts to avoid a cross-package import in tests
const COOKIE_TOKEN = 'token';
const COOKIE_CSRF_TOKEN = 'csrf_token';
const HEADER_CSRF_TOKEN = 'x-csrf-token';

const SIGNING_SECRET = 'test-signing-secret-32-chars-ok!';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Generate a properly HMAC-signed CSRF token for the given secret. */
function makeValidCsrfToken(secret: string): string {
  const token = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('hex');
  const sig = createHmac('sha256', secret).update(token).digest('hex');
  return `${token}.${sig}`;
}

function buildApp(runtime: AuthRuntimeContext): Hono<AppEnv> {
  const app = wrapWithRuntime(runtime);
  app.use('*', csrfProtection({ signing: { secret: SIGNING_SECRET } }));
  app.get('/test', c => c.json({ ok: true }));
  app.post('/test', c => c.json({ ok: true }));
  return app;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('CSRF double-submit cookie validation', () => {
  let runtime: AuthRuntimeContext;

  beforeEach(() => {
    runtime = makeTestRuntime();
  });

  test('GET request bypasses CSRF validation entirely', async () => {
    const app = buildApp(runtime);
    const res = await app.fetch(new Request('http://localhost/test'));
    expect(res.status).toBe(200);
  });

  test('POST without an auth session cookie bypasses CSRF (not vulnerable)', async () => {
    const app = buildApp(runtime);
    const res = await app.fetch(new Request('http://localhost/test', { method: 'POST' }));
    // No auth cookie → CSRF check is skipped (the browser has no session to steal)
    expect(res.status).toBe(200);
  });

  test('POST with auth cookie but no CSRF token returns 403', async () => {
    const app = buildApp(runtime);
    const res = await app.fetch(
      new Request('http://localhost/test', {
        method: 'POST',
        headers: { Cookie: `${COOKIE_TOKEN}=some-session-token` },
      }),
    );
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/missing/i);
  });

  test('POST with tampered (unsigned) CSRF cookie returns 403', async () => {
    const app = buildApp(runtime);
    const unsignedToken = 'deadbeef.invalidsignature';
    const res = await app.fetch(
      new Request('http://localhost/test', {
        method: 'POST',
        headers: {
          Cookie: `${COOKIE_TOKEN}=session; ${COOKIE_CSRF_TOKEN}=${unsignedToken}`,
          [HEADER_CSRF_TOKEN]: unsignedToken,
        },
      }),
    );
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/invalid/i);
  });

  test('POST with valid cookie but mismatched header returns 403 (double-submit fails)', async () => {
    const app = buildApp(runtime);
    const validToken = makeValidCsrfToken(SIGNING_SECRET);
    const differentToken = makeValidCsrfToken(SIGNING_SECRET);

    const res = await app.fetch(
      new Request('http://localhost/test', {
        method: 'POST',
        headers: {
          Cookie: `${COOKIE_TOKEN}=session; ${COOKIE_CSRF_TOKEN}=${validToken}`,
          [HEADER_CSRF_TOKEN]: differentToken, // header ≠ cookie
        },
      }),
    );
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/mismatch/i);
  });

  test('POST with valid CSRF token matching in both cookie and header returns 200', async () => {
    const app = buildApp(runtime);
    const validToken = makeValidCsrfToken(SIGNING_SECRET);

    const res = await app.fetch(
      new Request('http://localhost/test', {
        method: 'POST',
        headers: {
          Cookie: `${COOKIE_TOKEN}=session; ${COOKIE_CSRF_TOKEN}=${validToken}`,
          [HEADER_CSRF_TOKEN]: validToken, // cookie === header ✓
        },
      }),
    );
    expect(res.status).toBe(200);
  });

  test('configured origin check rejects missing Origin and Referer', async () => {
    const runtime2 = makeTestRuntime();
    const app2 = wrapWithRuntime(runtime2);
    app2.use(
      '*',
      csrfProtection({
        signing: { secret: SIGNING_SECRET },
        allowedOrigins: ['https://app.example.com'],
      }),
    );
    app2.post('/test', c => c.json({ ok: true }));
    const validToken = makeValidCsrfToken(SIGNING_SECRET);

    const res = await app2.fetch(
      new Request('http://localhost/test', {
        method: 'POST',
        headers: {
          Cookie: `${COOKIE_TOKEN}=session; ${COOKIE_CSRF_TOKEN}=${validToken}`,
          [HEADER_CSRF_TOKEN]: validToken,
        },
      }),
    );

    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/origin missing/i);
  });

  test('configured origin check accepts allowed Referer when Origin is absent', async () => {
    const runtime2 = makeTestRuntime();
    const app2 = wrapWithRuntime(runtime2);
    app2.use(
      '*',
      csrfProtection({
        signing: { secret: SIGNING_SECRET },
        allowedOrigins: ['https://app.example.com'],
      }),
    );
    app2.post('/test', c => c.json({ ok: true }));
    const validToken = makeValidCsrfToken(SIGNING_SECRET);

    const res = await app2.fetch(
      new Request('http://localhost/test', {
        method: 'POST',
        headers: {
          Cookie: `${COOKIE_TOKEN}=session; ${COOKIE_CSRF_TOKEN}=${validToken}`,
          [HEADER_CSRF_TOKEN]: validToken,
          Referer: 'https://app.example.com/settings',
        },
      }),
    );

    expect(res.status).toBe(200);
  });

  test('exempt path bypasses CSRF even with an auth cookie', async () => {
    const runtime2 = makeTestRuntime();
    const app2 = wrapWithRuntime(runtime2);
    app2.use(
      '*',
      csrfProtection({
        signing: { secret: SIGNING_SECRET },
        exemptPaths: ['/webhooks/*'],
      }),
    );
    app2.post('/webhooks/stripe', c => c.json({ ok: true }));

    const res = await app2.fetch(
      new Request('http://localhost/webhooks/stripe', {
        method: 'POST',
        headers: { Cookie: `${COOKIE_TOKEN}=session` },
        // No CSRF token — exempt path should skip the check
      }),
    );
    expect(res.status).toBe(200);
  });

  test('protected auth endpoints are not bypassed by broad publicPaths', async () => {
    const runtime2 = makeTestRuntime();
    const app2 = wrapWithRuntime(runtime2);
    app2.use('*', async (c, next) => {
      const ctx = c.get('slingshotCtx') as unknown as Record<string, unknown>;
      c.set('slingshotCtx', { ...ctx, publicPaths: new Set(['/auth/*']) } as never);
      await next();
    });
    app2.use(
      '*',
      csrfProtection({
        signing: { secret: SIGNING_SECRET },
        protectedUnauthenticatedPaths: ['/auth/login'],
      }),
    );
    app2.post('/auth/login', c => c.json({ ok: true }));

    const res = await app2.fetch(
      new Request('http://localhost/auth/login', {
        method: 'POST',
      }),
    );
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/missing/i);
  });
});
