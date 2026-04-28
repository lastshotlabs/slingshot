import { describe, expect, test } from 'bun:test';
import { createMemoryOrganizationsRateLimitStore } from '../../src/lib/rateLimit';

describe('createMemoryOrganizationsRateLimitStore', () => {
  test('allows up to limit hits in window', async () => {
    const store = createMemoryOrganizationsRateLimitStore();
    for (let i = 0; i < 3; i++) {
      const decision = await store.hit('k', 3, 1000);
      expect(decision.allowed).toBe(true);
    }
  });

  test('rejects the (limit+1)-th hit and reports retryAfterMs', async () => {
    const store = createMemoryOrganizationsRateLimitStore();
    for (let i = 0; i < 3; i++) {
      await store.hit('k', 3, 1000);
    }
    const decision = await store.hit('k', 3, 1000);
    expect(decision.allowed).toBe(false);
    expect(decision.retryAfterMs).toBeGreaterThanOrEqual(0);
    expect(decision.remaining).toBe(0);
  });

  test('allows again once entries age out', async () => {
    const store = createMemoryOrganizationsRateLimitStore();
    for (let i = 0; i < 2; i++) {
      await store.hit('k', 2, 30);
    }
    const blocked = await store.hit('k', 2, 30);
    expect(blocked.allowed).toBe(false);
    await new Promise(r => setTimeout(r, 60));
    const after = await store.hit('k', 2, 30);
    expect(after.allowed).toBe(true);
  });

  test('reports remaining count for allowed hits', async () => {
    const store = createMemoryOrganizationsRateLimitStore();
    const first = await store.hit('k', 5, 1000);
    expect(first.remaining).toBe(4);
    const second = await store.hit('k', 5, 1000);
    expect(second.remaining).toBe(3);
  });

  test('separate keys do not interfere', async () => {
    const store = createMemoryOrganizationsRateLimitStore();
    await store.hit('a', 1, 1000);
    const decisionForA = await store.hit('a', 1, 1000);
    expect(decisionForA.allowed).toBe(false);
    const decisionForB = await store.hit('b', 1, 1000);
    expect(decisionForB.allowed).toBe(true);
  });

  test('honors maxEntries by evicting oldest tracked key', async () => {
    const store = createMemoryOrganizationsRateLimitStore({ maxEntries: 2 });
    await store.hit('a', 1, 60_000);
    await store.hit('b', 1, 60_000);
    await store.hit('c', 1, 60_000); // evicts 'a' (oldest by insertion)
    // 'a' was evicted — first hit again is allowed
    const aAgain = await store.hit('a', 1, 60_000);
    expect(aAgain.allowed).toBe(true);
  });
});
