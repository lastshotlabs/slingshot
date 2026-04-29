import { describe, expect, test } from 'bun:test';
import { createMemoryOrganizationsRateLimitStore } from '../../src/lib/rateLimit';

describe('rate limit edge cases', () => {
  // -------------------------------------------------------------------------
  // Burst
  // -------------------------------------------------------------------------

  test('burst of hits over the limit only allows up to limit', async () => {
    const store = createMemoryOrganizationsRateLimitStore();
    const limit = 5;
    const windowMs = 60_000;
    const results = await Promise.all(
      Array.from({ length: 10 }, () => store.hit('burst-key', limit, windowMs)),
    );
    const allowed = results.filter(r => r.allowed).length;
    expect(allowed).toBe(limit);
    const denied = results.filter(r => !r.allowed).length;
    expect(denied).toBe(10 - limit);
  });

  test('denied hits report retryAfterMs greater than 0', async () => {
    const store = createMemoryOrganizationsRateLimitStore();
    // Consume the limit
    for (let i = 0; i < 3; i++) {
      await store.hit('retry-key', 3, 10_000);
    }
    const decision = await store.hit('retry-key', 3, 10_000);
    expect(decision.allowed).toBe(false);
    expect(decision.retryAfterMs).toBeGreaterThan(0);
    expect(decision.remaining).toBe(0);
  });

  // -------------------------------------------------------------------------
  // Concurrency (separate keys do not interfere under concurrent load)
  // -------------------------------------------------------------------------

  test('separate keys under burst load do not interfere', async () => {
    const store = createMemoryOrganizationsRateLimitStore();
    const limit = 3;
    const windowMs = 60_000;

    // Burst on key-a
    const resultsA = await Promise.all(
      Array.from({ length: 6 }, () => store.hit('a', limit, windowMs)),
    );
    const allowedA = resultsA.filter(r => r.allowed).length;
    expect(allowedA).toBe(limit);

    // Burst on key-b (should start fresh)
    const resultsB = await Promise.all(
      Array.from({ length: 6 }, () => store.hit('b', limit, windowMs)),
    );
    const allowedB = resultsB.filter(r => r.allowed).length;
    expect(allowedB).toBe(limit);
  });

  // -------------------------------------------------------------------------
  // Window expiry
  // -------------------------------------------------------------------------

  test('hits age out after window expires, allowing new hits', async () => {
    const store = createMemoryOrganizationsRateLimitStore();
    // Use a very short window (20ms)
    for (let i = 0; i < 2; i++) {
      await store.hit('age-key', 2, 20);
    }
    // Third hit should be denied
    expect((await store.hit('age-key', 2, 20)).allowed).toBe(false);

    // Wait for window to expire
    await new Promise(r => setTimeout(r, 40));

    // Should be allowed again
    expect((await store.hit('age-key', 2, 20)).allowed).toBe(true);
    expect((await store.hit('age-key', 2, 20)).allowed).toBe(true);
    // Third hit should be denied again (window started fresh)
    expect((await store.hit('age-key', 2, 20)).allowed).toBe(false);
  });

  test('extremely short window (1ms) ages out almost immediately', async () => {
    const store = createMemoryOrganizationsRateLimitStore();
    // First hit within a 1ms window fills the limit of 1
    const first = await store.hit('tiny', 1, 1);
    expect(first.allowed).toBe(true);
    // Second hit should be denied
    expect((await store.hit('tiny', 1, 1)).allowed).toBe(false);
    // After a small pause the window expires
    await new Promise(r => setTimeout(r, 5));
    expect((await store.hit('tiny', 1, 1)).allowed).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Remaining count tracking
  // -------------------------------------------------------------------------

  test('remaining count decreases from limit-1 down to 0', async () => {
    const store = createMemoryOrganizationsRateLimitStore();
    const limit = 4;
    expect((await store.hit('rem-key', limit, 10_000)).remaining).toBe(3);
    expect((await store.hit('rem-key', limit, 10_000)).remaining).toBe(2);
    expect((await store.hit('rem-key', limit, 10_000)).remaining).toBe(1);
    expect((await store.hit('rem-key', limit, 10_000)).remaining).toBe(0);
    const denied = await store.hit('rem-key', limit, 10_000);
    expect(denied.allowed).toBe(false);
    expect(denied.remaining).toBe(0);
  });

  test('first hit on a key returns remaining = limit - 1', async () => {
    const store = createMemoryOrganizationsRateLimitStore();
    const decision = await store.hit('fresh-key', 10, 60_000);
    expect(decision.allowed).toBe(true);
    expect(decision.remaining).toBe(9);
  });

  // -------------------------------------------------------------------------
  // maxEntries eviction
  // -------------------------------------------------------------------------

  test('maxEntries evicts oldest key when limit exceeded', async () => {
    const store = createMemoryOrganizationsRateLimitStore({ maxEntries: 3 });

    // Insert three keys
    await store.hit('k1', 1, 60_000);
    await store.hit('k2', 1, 60_000);
    await store.hit('k3', 1, 60_000);

    // k1 should now be consumed (limit of 1)
    const k1Again = await store.hit('k1', 1, 60_000);
    expect(k1Again.allowed).toBe(false);

    // Insert k4, which evicts the oldest key (k2 is now oldest since we touched k1)
    // After k1 was touched, insertion order is k2, k3, k1
    await store.hit('k4', 1, 60_000);
    // k2 was evicted (oldest by insertion order), so it should be allowed again
    const k2Again = await store.hit('k2', 1, 60_000);
    expect(k2Again.allowed).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Limit of 1
  // -------------------------------------------------------------------------

  test('limit of 1 rejects every second hit', async () => {
    const store = createMemoryOrganizationsRateLimitStore();
    expect((await store.hit('1limit', 1, 10_000)).allowed).toBe(true);
    expect((await store.hit('1limit', 1, 10_000)).allowed).toBe(false);
    expect((await store.hit('1limit', 1, 10_000)).allowed).toBe(false);
  });

  // -------------------------------------------------------------------------
  // Large window
  // -------------------------------------------------------------------------

  test('large window with single hit is always allowed', async () => {
    const store = createMemoryOrganizationsRateLimitStore();
    const decision = await store.hit('big-window', 1, 3_600_000);
    expect(decision.allowed).toBe(true);
  });
});
