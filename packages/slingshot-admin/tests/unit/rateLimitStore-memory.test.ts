import { describe, expect, test } from 'bun:test';
import { createMemoryRateLimitStore } from '../../src/lib/rateLimitStore';

describe('createMemoryRateLimitStore', () => {
  test('first hit on a fresh key returns count=1 and not exceeded', async () => {
    const store = createMemoryRateLimitStore();
    const result = await store.hit('user:ip:action', { limit: 3, windowMs: 60_000 });

    expect(result.count).toBe(1);
    expect(result.exceeded).toBe(false);
    expect(result.resetAt).toBeGreaterThan(Date.now());
  });

  test('hits accumulate within the window and trip when count > limit', async () => {
    const store = createMemoryRateLimitStore();
    const opts = { limit: 2, windowMs: 60_000 };

    const first = await store.hit('k', opts);
    const second = await store.hit('k', opts);
    const third = await store.hit('k', opts);

    expect(first.exceeded).toBe(false);
    expect(second.exceeded).toBe(false);
    expect(third.exceeded).toBe(true);
    expect(third.count).toBe(3);
    expect(third.resetAt).toBe(first.resetAt);
  });

  test('expired window resets the counter on the next hit', async () => {
    const store = createMemoryRateLimitStore();
    const opts = { limit: 1, windowMs: 1 };

    const first = await store.hit('k', opts);
    expect(first.exceeded).toBe(false);

    // Wait past the window.
    await new Promise(resolve => setTimeout(resolve, 5));

    const second = await store.hit('k', opts);
    expect(second.count).toBe(1);
    expect(second.exceeded).toBe(false);
    expect(second.resetAt).toBeGreaterThan(first.resetAt);
  });

  test('different keys do not share counters', async () => {
    const store = createMemoryRateLimitStore();
    const opts = { limit: 1, windowMs: 60_000 };

    const a = await store.hit('a', opts);
    const b = await store.hit('b', opts);

    expect(a.count).toBe(1);
    expect(b.count).toBe(1);
    expect(a.exceeded).toBe(false);
    expect(b.exceeded).toBe(false);
  });

  test('limit=0 reports exceeded on first hit', async () => {
    const store = createMemoryRateLimitStore();
    const result = await store.hit('k', { limit: 0, windowMs: 60_000 });
    expect(result.exceeded).toBe(true);
    expect(result.count).toBe(1);
  });
});
