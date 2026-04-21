/**
 * Unit tests for the rateLimit middleware.
 *
 * Targets the uncovered lines:
 * - line 70: IP-based rate limit exceeded → 429 response
 * - lines 74-77: fingerprint-based secondary limit path
 */
import { describe, expect, test } from 'bun:test';
import { Hono } from 'hono';
import { attachContext, createMemoryRateLimitAdapter } from '@lastshotlabs/slingshot-core';
import type { AppEnv } from '@lastshotlabs/slingshot-core';
import { rateLimit } from '../../src/framework/middleware/rateLimit';

function buildRateLimitApp(opts: {
  max: number;
  windowMs?: number;
  fingerprintLimit?: boolean;
  rateLimitAdapter?: any;
  fingerprintBuilder?: any;
}) {
  const app = new Hono<AppEnv>();
  const rateLimitAdapter = opts.rateLimitAdapter ?? createMemoryRateLimitAdapter();
  const fingerprintBuilder = opts.fingerprintBuilder ?? {
    buildFingerprint: async () => 'test-fingerprint',
  };

  const ctx = {
    app,
    config: { appName: 'test' },
    rateLimitAdapter,
    fingerprintBuilder,
    publicPaths: new Set<string>(),
  };

  attachContext(app, ctx as any);

  app.use(async (c, next) => {
    const { getContext } = await import('@lastshotlabs/slingshot-core');
    (c as any).set('slingshotCtx', getContext(app));
    await next();
  });

  app.use(
    rateLimit({
      max: opts.max,
      windowMs: opts.windowMs ?? 60_000,
      fingerprintLimit: opts.fingerprintLimit,
    }),
  );

  app.get('/api', c => c.json({ ok: true }));
  app.get('/private', c => c.json({ private: true }));

  return app;
}

describe('rateLimit middleware', () => {
  test('allows requests under the limit', async () => {
    const app = buildRateLimitApp({ max: 5 });
    const res = await app.request('/api');
    expect(res.status).toBe(200);
  });

  test('returns 429 when IP rate limit is exceeded (line 70)', async () => {
    // max: 1 so the 2nd request from the same IP triggers 429
    const app = buildRateLimitApp({ max: 1 });

    const first = await app.request('/api');
    expect(first.status).toBe(200);

    const second = await app.request('/api');
    expect(second.status).toBe(429);
    const body = await second.json();
    expect(body.error).toBe('Too Many Requests');
  });

  test('fingerprint limit returns 429 when fingerprint bucket exhausted (lines 74-77)', async () => {
    // IP check always passes, fingerprint check always fails → 429
    const customAdapter = {
      async trackAttempt(key: string) {
        if (key.includes('ip:')) return false; // IP always passes
        if (key.includes('fp:')) return true; // fingerprint always fails
        return false;
      },
    };

    const app = buildRateLimitApp({
      max: 100,
      windowMs: 60_000,
      fingerprintLimit: true,
      rateLimitAdapter: customAdapter,
      fingerprintBuilder: { buildFingerprint: async () => 'fp-value' },
    });

    const res = await app.request('/api');
    expect(res.status).toBe(429);
    const body = await res.json();
    expect(body.error).toBe('Too Many Requests');
  });

  test('tenant-scoped rate limit uses tenant prefix (line 67)', async () => {
    let capturedKey = '';
    const customAdapter = {
      async trackAttempt(key: string) {
        capturedKey = key;
        return false;
      },
    };

    const app = new Hono<AppEnv>();
    const ctx = {
      app,
      config: { appName: 'test' },
      rateLimitAdapter: customAdapter,
      fingerprintBuilder: { buildFingerprint: async () => 'fp' },
      publicPaths: new Set<string>(),
    };
    attachContext(app, ctx as any);

    app.use(async (c, next) => {
      const { getContext } = await import('@lastshotlabs/slingshot-core');
      (c as any).set('slingshotCtx', getContext(app));
      // Set tenantId on context
      (c as any).set('tenantId', 'tenant-abc');
      await next();
    });
    app.use(rateLimit({ max: 100, windowMs: 60_000 }));
    app.get('/api', c => c.json({ ok: true }));

    await app.request('/api');
    expect(capturedKey).toContain('t:tenant-abc:');
  });

  test('fingerprint check is skipped when fingerprintLimit is false', async () => {
    let fpBuilderCalled = false;
    const customAdapter = {
      async trackAttempt() {
        return false; // never block
      },
    };

    const app = buildRateLimitApp({
      max: 100,
      fingerprintLimit: false,
      rateLimitAdapter: customAdapter,
      fingerprintBuilder: {
        buildFingerprint: async () => {
          fpBuilderCalled = true;
          return 'fp';
        },
      },
    });

    await app.request('/api');
    expect(fpBuilderCalled).toBe(false);
  });

  test('public paths bypass rate limiting', async () => {
    const app = new Hono<AppEnv>();
    const rateLimitAdapter = createMemoryRateLimitAdapter();

    const ctx = {
      app,
      config: { appName: 'test' },
      rateLimitAdapter,
      fingerprintBuilder: { buildFingerprint: async () => 'fp' },
      publicPaths: new Set(['/public']),
    };
    attachContext(app, ctx as any);

    app.use(async (c, next) => {
      const { getContext } = await import('@lastshotlabs/slingshot-core');
      (c as any).set('slingshotCtx', getContext(app));
      await next();
    });

    // max=1 so second request on a private path returns 429
    app.use(rateLimit({ max: 1, windowMs: 60_000 }));
    app.get('/public', c => c.json({ public: true }));
    app.get('/private', c => c.json({ private: true }));

    // Public path: first and second requests should both succeed (bypassed)
    const pub1 = await app.request('/public');
    expect(pub1.status).toBe(200);

    const pub2 = await app.request('/public');
    expect(pub2.status).toBe(200);

    // Private path: first passes (count=1), second returns 429 (limit exceeded)
    const priv1 = await app.request('/private');
    expect(priv1.status).toBe(200);

    const priv2 = await app.request('/private');
    expect(priv2.status).toBe(429);
  });
});
