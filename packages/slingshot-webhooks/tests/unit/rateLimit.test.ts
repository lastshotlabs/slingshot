import { describe, expect, it } from 'bun:test';
import { createSlidingWindowRateLimiter } from '../../src/lib/rateLimit';
import type { RateLimiter } from '../../src/lib/rateLimit';

describe('createSlidingWindowRateLimiter', () => {
  it('allows requests within the limit', () => {
    const limiter = createSlidingWindowRateLimiter({ maxRequests: 5, windowMs: 60_000 });
    for (let i = 0; i < 5; i++) {
      const result = limiter.check('test-key');
      expect(result.allowed).toBe(true);
      expect(result.remaining).toBe(5 - i - 1);
    }
  });

  it('blocks requests that exceed the limit', () => {
    const limiter = createSlidingWindowRateLimiter({ maxRequests: 3, windowMs: 60_000 });
    for (let i = 0; i < 3; i++) {
      expect(limiter.check('test-key').allowed).toBe(true);
    }
    const blocked = limiter.check('test-key');
    expect(blocked.allowed).toBe(false);
    expect(blocked.remaining).toBe(0);
    expect(blocked.resetMs).toBeGreaterThan(0);
  });

  it('tracks keys independently', () => {
    const limiter = createSlidingWindowRateLimiter({ maxRequests: 2, windowMs: 60_000 });
    expect(limiter.check('key-a').allowed).toBe(true);
    expect(limiter.check('key-a').allowed).toBe(true);
    expect(limiter.check('key-a').allowed).toBe(false);

    // key-b should still have its full quota
    expect(limiter.check('key-b').allowed).toBe(true);
    expect(limiter.check('key-b').allowed).toBe(true);
  });

  it('recovers after the window passes', async () => {
    const limiter = createSlidingWindowRateLimiter({ maxRequests: 1, windowMs: 50 });
    expect(limiter.check('test-key').allowed).toBe(true);
    expect(limiter.check('test-key').allowed).toBe(false);

    // Wait for the window to expire
    await new Promise(resolve => setTimeout(resolve, 60));
    const result = limiter.check('test-key');
    expect(result.allowed).toBe(true);
    expect(result.remaining).toBe(0);
  });

  it('uses default options when none are provided', () => {
    const limiter = createSlidingWindowRateLimiter();
    // Default maxRequests is 100 — all 100 should be allowed
    for (let i = 0; i < 100; i++) {
      expect(limiter.check(`key-${i}`).allowed).toBe(true);
    }
  });

  it('returns resetMs greater than 0 when blocked', () => {
    const limiter = createSlidingWindowRateLimiter({ maxRequests: 1, windowMs: 10_000 });
    expect(limiter.check('test-key').allowed).toBe(true);
    const result = limiter.check('test-key');
    expect(result.allowed).toBe(false);
    expect(result.resetMs).toBeGreaterThan(0);
    expect(result.resetMs).toBeLessThanOrEqual(10_000);
  });
});

describe('RateLimiter interface — custom implementation', () => {
  it('accepts a custom RateLimiter', () => {
    const custom: RateLimiter = {
      check(key: string) {
        return { allowed: key !== 'blocked', remaining: 5, resetMs: 1000 };
      },
    };
    expect(custom.check('allowed-key').allowed).toBe(true);
    expect(custom.check('blocked').allowed).toBe(false);
  });
});
