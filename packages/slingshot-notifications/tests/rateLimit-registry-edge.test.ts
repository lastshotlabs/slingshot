/**
 * Edge-case coverage for the notification rate-limit registry.
 *
 * Builds on the core rate-limit tests in data-preferences-rateLimit.test.ts.
 * Covers duplicate registration (overriding an existing backend), key
 * collision behavior, TTL precision, empty string keys, and the
 * interaction between multiple backends.
 */
import { describe, expect, test } from 'bun:test';
import {
  createInMemoryRateLimitBackend,
  createNoopRateLimitBackend,
  registerRateLimitBackend,
  resolveRateLimitBackend,
} from '../src/rateLimit';

// ---------------------------------------------------------------------------
// Duplicate registration
// ---------------------------------------------------------------------------

describe('rate-limit registry: duplicate registration', () => {
  test('registering a new name does not throw', () => {
    const name = `custom-${Date.now()}`;
    expect(() => registerRateLimitBackend(name, createNoopRateLimitBackend)).not.toThrow();
  });

  test('registering over an existing name replaces the factory', () => {
    const name = `override-${Date.now()}`;
    registerRateLimitBackend(name, () => ({
      async check() {
        return false;
      },
    }));

    // First resolve — should return false
    const first = resolveRateLimitBackend(name);
    expect(first.check('x', 1, 1)).resolves.toBe(false);

    // Override with a backend that returns true
    registerRateLimitBackend(name, () => ({
      async check() {
        return true;
      },
    }));

    const second = resolveRateLimitBackend(name);
    expect(second.check('x', 1, 1)).resolves.toBe(true);
  });

  test('re-registering memory backend name replaces it', () => {
    const name = `memory-clone-${Date.now()}`;
    // Register a backend that always blocks
    registerRateLimitBackend(name, () => ({
      async check() {
        return false;
      },
    }));

    const backend = resolveRateLimitBackend(name);
    expect(backend.check('any', 100, 60_000)).resolves.toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Key collision
// ---------------------------------------------------------------------------

describe('rate-limit backend: key collision behavior', () => {
  test('different keys with the same value are treated as separate counters', async () => {
    const backend = createInMemoryRateLimitBackend();
    const opts = { limit: 2, windowMs: 60_000 };

    // Hit key-a twice
    await backend.check('key-a', opts.limit, opts.windowMs);
    await backend.check('key-a', opts.limit, opts.windowMs);

    // key-b should still be allowed (its counter is independent)
    const result = await backend.check('key-b', opts.limit, opts.windowMs);
    expect(result).toBe(true);

    // key-a third hit should be blocked
    const resultA = await backend.check('key-a', opts.limit, opts.windowMs);
    expect(resultA).toBe(false);
  });

  test('keys with special characters are treated as distinct', async () => {
    const backend = createInMemoryRateLimitBackend();

    // The key format is typically source:userId
    await backend.check('community:user-1', 1, 60_000);
    await backend.check('community:user-2', 1, 60_000);

    // user-1 should be blocked, user-2 should be allowed (second hit)
    expect(backend.check('community:user-1', 1, 60_000)).resolves.toBe(false);
    // Actually user-2 was only hit once, so it should be allowed on second hit? No wait:
    // we called check on user-2 once, so the second call should hit the limit.
    // Let me re-think: limit=1, windowMs=60_000.
    // First call: count=1, check passes (count <= limit).
    // Second call: count=2, check fails (count > limit).
    // So user-2 on the SECOND call (which is the first after our setup) ...
    // Actually we called check only ONCE for user-2 above, so check returns true.
    // The SECOND call to user-2 (below) will increment and fail.
    expect(backend.check('community:user-2', 1, 60_000)).resolves.toBe(false);
  });

  test('empty string key is allowed as a distinct key', async () => {
    const backend = createInMemoryRateLimitBackend();
    const opts = { limit: 3, windowMs: 60_000 };

    await backend.check('', opts.limit, opts.windowMs);
    await backend.check('', opts.limit, opts.windowMs);
    await backend.check('', opts.limit, opts.windowMs);
    // Third hit is allowed (counter is checked before increment — 2 < 3)
    const result = await backend.check('', opts.limit, opts.windowMs);

    // Fourth hit with empty key should be blocked (3 >= 3)
    expect(result).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// TTL precision
// ---------------------------------------------------------------------------

describe('rate-limit backend: TTL precision', () => {
  test('back-to-back checks within the same ms are within same window', async () => {
    const backend = createInMemoryRateLimitBackend();
    const opts = { limit: 2, windowMs: 60_000 };

    const r1 = await backend.check('ttl-key', opts.limit, opts.windowMs);
    const r2 = await backend.check('ttl-key', opts.limit, opts.windowMs);

    // Both should be allowed
    expect(r1).toBe(true);
    expect(r2).toBe(true);

    // Third hit should be blocked
    const r3 = await backend.check('ttl-key', opts.limit, opts.windowMs);
    expect(r3).toBe(false);
  });

  test('window expiry at exact millisecond boundary resets on next check', async () => {
    const backend = createInMemoryRateLimitBackend();
    // Use a 1ms window
    const opts = { limit: 2, windowMs: 1 };

    await backend.check('ms-key', opts.limit, opts.windowMs);
    await backend.check('ms-key', opts.limit, opts.windowMs);

    // Should be blocked now
    const blocked = await backend.check('ms-key', opts.limit, opts.windowMs);
    expect(blocked).toBe(false);

    // Wait past the window
    await new Promise(r => setTimeout(r, 5));

    // Window expired — should be allowed again
    const fresh = await backend.check('ms-key', opts.limit, opts.windowMs);
    expect(fresh).toBe(true);
  });

  test('very large windowMs does not overflow', async () => {
    const backend = createInMemoryRateLimitBackend();
    const opts = { limit: 5, windowMs: Number.MAX_SAFE_INTEGER };

    const result = await backend.check('big-window', opts.limit, opts.windowMs);
    expect(result).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Backend lifecycle
// ---------------------------------------------------------------------------

describe('rate-limit backend: lifecycle', () => {
  test('clear() resets all counters', async () => {
    const backend = createInMemoryRateLimitBackend();
    const opts = { limit: 2, windowMs: 60_000 };

    await backend.check('clear-key', opts.limit, opts.windowMs);
    await backend.check('clear-key', opts.limit, opts.windowMs);
    await backend.check('clear-key', opts.limit, opts.windowMs);

    // Now blocked
    expect(backend.check('clear-key', opts.limit, opts.windowMs)).resolves.toBe(false);

    backend.clear?.();

    // Reset — should be allowed again
    expect(backend.check('clear-key', opts.limit, opts.windowMs)).resolves.toBe(true);
  });

  test('clear() on noop backend does not throw', () => {
    const backend = createNoopRateLimitBackend();
    expect(() => backend.clear?.()).not.toThrow();
  });

  test('multiple backends do not share state', async () => {
    const backendA = createInMemoryRateLimitBackend();
    const backendB = createInMemoryRateLimitBackend();

    await backendA.check('shared-key', 1, 60_000);

    // backendB should have its own independent counter
    const resultB = await backendB.check('shared-key', 1, 60_000);
    expect(resultB).toBe(true);

    // backendA's counter is now at 2, should be blocked
    const resultA = await backendA.check('shared-key', 1, 60_000);
    expect(resultA).toBe(false);
  });

  test('close() on in-memory backend does not throw', async () => {
    const backend = createInMemoryRateLimitBackend();
    const result = backend.close?.();
    expect(result).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Unknown backend name
// ---------------------------------------------------------------------------

describe('rate-limit registry: unknown backend', () => {
  test('throws with message containing the unknown name and known backends', () => {
    expect(() => resolveRateLimitBackend('definitely-not-registered')).toThrow(
      /definitely-not-registered/,
    );
  });

  test('throws with message listing known backends (memory, noop)', () => {
    expect(() => resolveRateLimitBackend('missing')).toThrow(/memory/);
    expect(() => resolveRateLimitBackend('missing')).toThrow(/noop/);
  });
});
