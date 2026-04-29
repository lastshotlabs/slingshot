import { describe, expect, test } from 'bun:test';
import type { AdminRateLimitHitResult, AdminRateLimitStore } from '../../src/lib/rateLimitStore';

function createTestRateLimitStore(): AdminRateLimitStore {
  const counters = new Map<string, { count: number; resetAt: number }>();
  return {
    async hit(key, opts): Promise<AdminRateLimitHitResult> {
      const now = Date.now();
      const existing = counters.get(key);
      if (existing && now < existing.resetAt) {
        existing.count++;
        return {
          count: existing.count,
          exceeded: existing.count > opts.limit,
          resetAt: existing.resetAt,
        };
      }
      const resetAt = now + opts.windowMs;
      counters.set(key, { count: 1, resetAt });
      return { count: 1, exceeded: 1 > opts.limit, resetAt };
    },
  };
}

describe('AdminRateLimitStore (in-memory)', () => {
  test('first hit initializes counter to 1', async () => {
    const store = createTestRateLimitStore();
    const result = await store.hit('test-key', { limit: 5, windowMs: 60000 });
    expect(result.count).toBe(1);
    expect(result.exceeded).toBe(false);
  });

  test('increments counter on subsequent hits', async () => {
    const store = createTestRateLimitStore();
    await store.hit('key', { limit: 5, windowMs: 60000 });
    const result = await store.hit('key', { limit: 5, windowMs: 60000 });
    expect(result.count).toBe(2);
  });

  test('reports exceeded when count > limit', async () => {
    const store = createTestRateLimitStore();
    await store.hit('burst', { limit: 1, windowMs: 60000 });
    const result = await store.hit('burst', { limit: 1, windowMs: 60000 });
    expect(result.count).toBe(2);
    expect(result.exceeded).toBe(true);
  });

  test('resetAt is in the future', async () => {
    const store = createTestRateLimitStore();
    const now = Date.now();
    const result = await store.hit('key', { limit: 5, windowMs: 30000 });
    expect(result.resetAt).toBeGreaterThan(now);
    expect(result.resetAt).toBeLessThanOrEqual(now + 30000);
  });

  test('window expires after windowMs', async () => {
    const store = createTestRateLimitStore();
    const result1 = await store.hit('key', { limit: 5, windowMs: 1 });
    expect(result1.count).toBe(1);
    // Wait for window to expire
    await new Promise(r => setTimeout(r, 5));
    const result2 = await store.hit('key', { limit: 5, windowMs: 1 });
    expect(result2.count).toBe(1);
  });

  test('separate keys have separate counters', async () => {
    const store = createTestRateLimitStore();
    await store.hit('key-a', { limit: 5, windowMs: 60000 });
    await store.hit('key-a', { limit: 5, windowMs: 60000 });
    const result = await store.hit('key-b', { limit: 5, windowMs: 60000 });
    expect(result.count).toBe(1);
  });
});
