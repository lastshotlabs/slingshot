import { describe, expect, it } from 'bun:test';
import {
  type RateLimitBackend,
  buildRateLimitMiddleware,
  createInMemoryRateLimiter,
  parseDuration,
} from '../../src/lib/rateLimit';

describe('parseDuration', () => {
  it('parses seconds', () => {
    expect(parseDuration('10s')).toBe(10_000);
    expect(parseDuration('1s')).toBe(1_000);
    expect(parseDuration('120s')).toBe(120_000);
  });

  it('parses minutes', () => {
    expect(parseDuration('1m')).toBe(60_000);
    expect(parseDuration('5m')).toBe(300_000);
  });

  it('parses hours', () => {
    expect(parseDuration('1h')).toBe(3_600_000);
    expect(parseDuration('24h')).toBe(86_400_000);
  });

  it('throws on invalid format', () => {
    expect(() => parseDuration('')).toThrow('Invalid duration');
    expect(() => parseDuration('10')).toThrow('Invalid duration');
    expect(() => parseDuration('abc')).toThrow('Invalid duration');
    expect(() => parseDuration('10d')).toThrow('Invalid duration');
    expect(() => parseDuration('-1s')).toThrow('Invalid duration');
  });
});

describe('createInMemoryRateLimiter', () => {
  it('allows requests within the limit', async () => {
    const rl = createInMemoryRateLimiter();
    const r1 = await rl.check('k', 60_000, 3);
    expect(r1.allowed).toBe(true);
    expect(r1.remaining).toBe(2);

    const r2 = await rl.check('k', 60_000, 3);
    expect(r2.allowed).toBe(true);
    expect(r2.remaining).toBe(1);

    const r3 = await rl.check('k', 60_000, 3);
    expect(r3.allowed).toBe(true);
    expect(r3.remaining).toBe(0);
  });

  it('rejects once limit is exceeded', async () => {
    const rl = createInMemoryRateLimiter();
    await rl.check('k', 60_000, 2);
    await rl.check('k', 60_000, 2);

    const r = await rl.check('k', 60_000, 2);
    expect(r.allowed).toBe(false);
    expect(r.remaining).toBe(0);
  });

  it('rejects on every subsequent call after limit', async () => {
    const rl = createInMemoryRateLimiter();
    await rl.check('k', 60_000, 1);

    const r1 = await rl.check('k', 60_000, 1);
    expect(r1.allowed).toBe(false);

    const r2 = await rl.check('k', 60_000, 1);
    expect(r2.allowed).toBe(false);
  });

  it('resets after window expires', async () => {
    const rl = createInMemoryRateLimiter();
    // Use a very short window
    await rl.check('k', 1, 1); // 1ms window
    // Wait for window to expire
    await new Promise(r => setTimeout(r, 5));

    const result = await rl.check('k', 1, 1);
    expect(result.allowed).toBe(true);
  });

  it('tracks separate keys independently', async () => {
    const rl = createInMemoryRateLimiter();
    await rl.check('a', 60_000, 1);
    const r = await rl.check('b', 60_000, 1);
    expect(r.allowed).toBe(true);
  });

  it('returns correct resetAt', async () => {
    const rl = createInMemoryRateLimiter();
    const before = Date.now();
    const r = await rl.check('k', 60_000, 5);
    expect(r.resetAt).toBeGreaterThanOrEqual(before + 60_000);
    expect(r.resetAt).toBeLessThanOrEqual(Date.now() + 60_000);
  });
});

describe('buildRateLimitMiddleware', () => {
  function mockContext(userId?: string, tenantId?: string) {
    const headers = new Map<string, string>();
    let status = 200;
    let body: unknown;

    const c = {
      get(key: string) {
        if (key === 'authUserId') return userId;
        if (key === 'tenantId') return tenantId;
        return undefined;
      },
      header(name: string, value: string) {
        headers.set(name, value);
      },
      json(data: unknown, s: number) {
        status = s;
        body = data;
        return { status, body, headers: Object.fromEntries(headers) };
      },
    };

    return { c, getHeaders: () => headers, getStatus: () => status, getBody: () => body };
  }

  it('allows requests within per-user limit', async () => {
    const backend = createInMemoryRateLimiter();
    const mw = buildRateLimitMiddleware('vote', { perUser: { window: '1m', max: 2 } }, backend);

    let nextCalled = false;
    const { c } = mockContext('user-1');
    await mw(c as never, async () => {
      nextCalled = true;
    });
    expect(nextCalled).toBe(true);
  });

  it('returns 429 when per-user limit exceeded', async () => {
    const backend = createInMemoryRateLimiter();
    const mw = buildRateLimitMiddleware('vote', { perUser: { window: '1m', max: 1 } }, backend);

    const { c: c1 } = mockContext('user-1');
    await mw(c1 as never, async () => {});

    let nextCalled = false;
    const { c: c2, getHeaders } = mockContext('user-1');
    const response = await mw(c2 as never, async () => {
      nextCalled = true;
    });
    expect(nextCalled).toBe(false);
    expect((response as { status: number }).status).toBe(429);
    expect((response as { body: { error: string } }).body.error).toBe('RATE_LIMITED');
    expect((response as { body: { scope: string } }).body.scope).toBe('user');
    expect((response as { body: { op: string } }).body.op).toBe('vote');
    expect(getHeaders().get('Retry-After')).toBeDefined();
    expect(getHeaders().get('X-RateLimit-Limit')).toBe('1');
    expect(getHeaders().get('X-RateLimit-Remaining')).toBe('0');
    expect(getHeaders().get('X-RateLimit-Reset')).toBeDefined();
  });

  it('returns 429 when per-tenant limit exceeded', async () => {
    const backend = createInMemoryRateLimiter();
    const mw = buildRateLimitMiddleware(
      'results',
      { perTenant: { window: '1m', max: 1 } },
      backend,
    );

    const { c: c1 } = mockContext('user-1', 'tenant-1');
    await mw(c1 as never, async () => {});

    const { c: c2 } = mockContext('user-2', 'tenant-1');
    const response = await mw(c2 as never, async () => {});
    expect((response as { status: number }).status).toBe(429);
    expect((response as { body: { scope: string } }).body.scope).toBe('tenant');
  });

  it('skips per-user check when no userId in context', async () => {
    const backend = createInMemoryRateLimiter();
    const mw = buildRateLimitMiddleware('vote', { perUser: { window: '1m', max: 1 } }, backend);

    let nextCalled = false;
    const { c } = mockContext(undefined);
    await mw(c as never, async () => {
      nextCalled = true;
    });
    expect(nextCalled).toBe(true);
  });

  it('skips per-tenant check when no tenantId in context', async () => {
    const backend = createInMemoryRateLimiter();
    const mw = buildRateLimitMiddleware(
      'results',
      { perTenant: { window: '1m', max: 1 } },
      backend,
    );

    // First call with no tenant — should pass through
    let nextCalled = false;
    const { c } = mockContext('user-1', undefined);
    await mw(c as never, async () => {
      nextCalled = true;
    });
    expect(nextCalled).toBe(true);
  });

  it('checks per-user before per-tenant', async () => {
    const calls: string[] = [];
    const backend: RateLimitBackend = {
      async check(key, _w, _m) {
        calls.push(key);
        return { allowed: true, remaining: 10, resetAt: Date.now() + 60_000 };
      },
    };
    const mw = buildRateLimitMiddleware(
      'vote',
      {
        perUser: { window: '1m', max: 5 },
        perTenant: { window: '1m', max: 100 },
      },
      backend,
    );

    const { c } = mockContext('user-1', 'tenant-1');
    await mw(c as never, async () => {});
    expect(calls[0]).toContain('user:');
    expect(calls[1]).toContain('tenant:');
  });
});
