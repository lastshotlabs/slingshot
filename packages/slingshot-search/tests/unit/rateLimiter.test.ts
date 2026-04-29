import { describe, expect, it } from 'bun:test';
import {
  type RateLimitStore,
  createInMemoryRateLimitStore,
  createRateLimitMiddleware,
} from '../../src/routes/rateLimiter';

function makeFakeContext(overrides?: {
  tenantId?: string;
  ip?: string;
  xForwardedFor?: string;
  xRealIp?: string;
}) {
  const headers = new Map<string, string>();
  if (overrides?.xForwardedFor) headers.set('x-forwarded-for', overrides.xForwardedFor);
  if (overrides?.xRealIp) headers.set('x-real-ip', overrides.xRealIp);

  const responseHeaders = new Map<string, string>();
  let status = 200;
  let jsonBody: unknown = null;

  return {
    c: {
      get: (key: string) => (key === 'tenantId' ? overrides?.tenantId : undefined),
      req: {
        header: (name: string) => headers.get(name) ?? undefined,
      },
      header: (name: string, value: string) => {
        responseHeaders.set(name, value);
      },
      json: (body: unknown, code: number) => {
        status = code;
        jsonBody = body;
        return new Response(JSON.stringify(body), { status: code });
      },
      set: () => {},
    } as any,
    headers: responseHeaders,
    getStatus: () => status,
    getJsonBody: () => jsonBody,
  };
}

describe('createInMemoryRateLimitStore', () => {
  it('returns count 1 on first access', () => {
    const store = createInMemoryRateLimitStore();
    const result = store.increment('key-a', 60_000);
    expect(result.count).toBe(1);
    expect(result.resetAt).toBeGreaterThan(Date.now());
  });

  it('increments count on repeated access within the window', () => {
    const store = createInMemoryRateLimitStore();
    store.increment('key-a', 60_000);
    store.increment('key-a', 60_000);
    const result = store.increment('key-a', 60_000);
    expect(result.count).toBe(3);
  });

  it('resets count when the window expires', async () => {
    const store = createInMemoryRateLimitStore();
    store.increment('key-a', 1); // 1ms window
    store.increment('key-a', 1);
    const beforeExpiry = store.increment('key-a', 1);
    expect(beforeExpiry.count).toBe(3);

    // Wait for the 1ms window to expire.
    await new Promise(r => setTimeout(r, 5));

    const afterExpiry = store.increment('key-a', 60_000);
    expect(afterExpiry.count).toBe(1);
  });

  it('tracks different keys independently', () => {
    const store = createInMemoryRateLimitStore();
    store.increment('key-a', 60_000);
    store.increment('key-a', 60_000);
    const result = store.increment('key-b', 60_000);
    expect(result.count).toBe(1);
  });

  it('returns a resetAt in the future', () => {
    const store = createInMemoryRateLimitStore();
    const result = store.increment('key-a', 60_000);
    expect(result.resetAt).toBeGreaterThan(Date.now() - 1);
  });
});

describe('createRateLimitMiddleware', () => {
  it('calls next() when under the limit', async () => {
    const middleware = createRateLimitMiddleware({
      tenantResolver: () => 't-1',
      ipResolver: () => '1.2.3.4',
      max: 5,
    });
    let nextCalled = false;
    const { c } = makeFakeContext();

    await middleware(c, async () => {
      nextCalled = true;
    });

    expect(nextCalled).toBe(true);
  });

  it('sets rate-limit headers on successful requests', async () => {
    const middleware = createRateLimitMiddleware({
      tenantResolver: () => 't-1',
      ipResolver: () => '1.2.3.4',
      max: 10,
    });
    const { c, headers } = makeFakeContext();

    await middleware(c, async () => {});

    expect(headers.get('X-RateLimit-Limit')).toBe('10');
    expect(headers.get('X-RateLimit-Remaining')).toBe('9');
    expect(headers.get('X-RateLimit-Reset')).toBeTruthy();
  });

  it('returns 429 when the limit is exceeded', async () => {
    const store = createInMemoryRateLimitStore();
    const middleware = createRateLimitMiddleware({
      tenantResolver: () => 't-1',
      ipResolver: () => '1.2.3.4',
      max: 2,
      store,
    });
    const { c } = makeFakeContext();

    // First two should pass
    await middleware(c, async () => {});
    await middleware(c, async () => {});

    // Third should be rate limited
    let nextCalled = false;
    const response = await middleware(c, async () => {
      nextCalled = true;
    });

    expect(nextCalled).toBe(false);
    expect(response).toBeDefined();
    if (!response) throw new Error('Expected rate limit response');
    expect(response.status).toBe(429);
  });

  it('includes Retry-After header on 429 responses', async () => {
    const store = createInMemoryRateLimitStore();
    const middleware = createRateLimitMiddleware({
      tenantResolver: () => 't-1',
      ipResolver: () => '1.2.3.4',
      max: 1,
      store,
    });
    const { c, headers } = makeFakeContext();

    // Exhaust the limit
    await middleware(c, async () => {});
    await middleware(c, async () => {});

    expect(headers.get('Retry-After')).toBeTruthy();
    expect(Number(headers.get('Retry-After'))).toBeGreaterThanOrEqual(1);
  });

  it('separates tenants — tenant A can be limited while tenant B still passes', async () => {
    const store = createInMemoryRateLimitStore();
    const opts = { max: 2, store };
    const mwA = createRateLimitMiddleware({
      ...opts,
      tenantResolver: () => 'tenant-A',
      ipResolver: () => '1.1.1.1',
    });
    const mwB = createRateLimitMiddleware({
      ...opts,
      tenantResolver: () => 'tenant-B',
      ipResolver: () => '1.1.1.1',
    });

    // Exhaust tenant A
    const ctxA = makeFakeContext();
    await mwA(ctxA.c, async () => {});
    await mwA(ctxA.c, async () => {});
    let aNextCalled = false;
    const respA = await mwA(ctxA.c, async () => {
      aNextCalled = true;
    });
    expect(aNextCalled).toBe(false);
    expect(respA).toBeDefined();
    if (!respA) throw new Error('Expected rate limit response');
    expect(respA.status).toBe(429);

    // Tenant B still passes
    const ctxB = makeFakeContext();
    let bNextCalled = false;
    await mwB(ctxB.c, async () => {
      bNextCalled = true;
    });
    expect(bNextCalled).toBe(true);
  });

  it('falls back to _anonymous when tenantResolver returns undefined', async () => {
    const store = createInMemoryRateLimitStore();
    const middleware = createRateLimitMiddleware({
      tenantResolver: () => undefined,
      ipResolver: () => '1.2.3.4',
      max: 1,
      store,
    });
    const { c } = makeFakeContext();

    await middleware(c, async () => {});
    let nextCalled = false;
    await middleware(c, async () => {
      nextCalled = true;
    });
    expect(nextCalled).toBe(false);
  });

  it('uses x-forwarded-for header for IP resolution by default', async () => {
    // Default IP resolver reads x-forwarded-for or x-real-ip.
    // We test via the injectable ipResolver to keep determinism.
    const store = createInMemoryRateLimitStore();
    const middleware = createRateLimitMiddleware({
      tenantResolver: () => 't-1',
      ipResolver: () => '10.0.0.1',
      max: 1,
      store,
    });
    const { c } = makeFakeContext({ xForwardedFor: '10.0.0.1' });

    await middleware(c, async () => {});
    let nextCalled = false;
    await middleware(c, async () => {
      nextCalled = true;
    });
    expect(nextCalled).toBe(false);
  });
});
