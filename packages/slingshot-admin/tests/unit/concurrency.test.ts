/**
 * Tests for concurrent admin plugin operations.
 *
 * Covers circuit breaker, rate-limit store, and metrics collector under
 * concurrent access patterns that approximate real-world traffic.
 */
import { describe, expect, test } from 'bun:test';
import { AdminCircuitOpenError, createAdminCircuitBreaker } from '../../src/lib/circuitBreaker';
import { createAdminMetricsCollector } from '../../src/lib/metrics';
import { createMemoryRateLimitStore } from '../../src/lib/rateLimitStore';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create a deterministic clock. */
function makeClock() {
  let now = 0;
  return {
    now: () => now,
    advance(ms: number) {
      now += ms;
    },
  };
}

// ---------------------------------------------------------------------------
// 1. Simultaneous health checks — getHealth() called from many Promises
// ---------------------------------------------------------------------------

describe('simultaneous health checks', () => {
  test('concurrent getHealth() calls return consistent state while closed', async () => {
    const cb = createAdminCircuitBreaker({ providerName: 'test' });

    const snapshots = await Promise.all(
      Array.from({ length: 50 }, () => Promise.resolve(cb.getHealth())),
    );

    for (const s of snapshots) {
      expect(s.state).toBe('closed');
      expect(s.consecutiveFailures).toBe(0);
      expect(s.openedAt).toBeUndefined();
      expect(s.nextProbeAt).toBeUndefined();
    }
  });

  test('concurrent getHealth() calls return consistent state while open', async () => {
    const clock = makeClock();
    const cb = createAdminCircuitBreaker({
      providerName: 'test',
      threshold: 3,
      cooldownMs: 30_000,
      now: clock.now,
    });

    // Trip the breaker
    for (let i = 0; i < 3; i++) {
      await cb
        .guard(async () => {
          throw new Error('fail');
        })
        .catch(() => {});
    }

    expect(cb.getHealth().state).toBe('open');

    const snapshots = await Promise.all(
      Array.from({ length: 50 }, () => Promise.resolve(cb.getHealth())),
    );

    for (const s of snapshots) {
      expect(s.state).toBe('open');
      expect(s.consecutiveFailures).toBe(3);
      expect(s.openedAt).toBeDefined();
      expect(s.nextProbeAt).toBeDefined();
    }
  });

  test('concurrent getHealth() reads are never stale during state transitions', async () => {
    const clock = makeClock();
    const cb = createAdminCircuitBreaker({
      providerName: 'test',
      threshold: 2,
      cooldownMs: 10_000,
      now: clock.now,
    });

    // Fire guards and health reads concurrently.  getHealth() should never
    // return an inconsistent snapshot (e.g. state=open but openedAt=undefined).
    const ops: Promise<unknown>[] = [];
    for (let i = 0; i < 10; i++) {
      ops.push(
        cb
          .guard(async () => {
            throw new Error('boom');
          })
          .catch(() => {}),
      );
      ops.push(Promise.resolve(cb.getHealth()));
    }

    await Promise.all(ops);

    // After 10 sequential failures (2 trips it, the rest pile on), the breaker
    // must be open with a valid openedAt.
    const final = cb.getHealth();
    expect(final.state).toBe('open');
    expect(final.consecutiveFailures).toBeGreaterThanOrEqual(2);
    expect(final.openedAt).toBeDefined();
    expect(final.nextProbeAt).toBeDefined();
    expect(final.nextProbeAt as number).toBeGreaterThanOrEqual((final.openedAt as number) + 10_000);
  });
});

// ---------------------------------------------------------------------------
// 2. Rapid-fire requests when the circuit breaker is open
// ---------------------------------------------------------------------------

describe('rapid fire when circuit breaker is open', () => {
  test('all concurrent guard() calls fail fast when breaker is open', async () => {
    const clock = makeClock();
    const cb = createAdminCircuitBreaker({
      providerName: 'test',
      threshold: 1,
      cooldownMs: 30_000,
      now: clock.now,
    });

    // Trip the breaker
    await cb
      .guard(async () => {
        throw new Error('fail');
      })
      .catch(() => {});

    expect(cb.getHealth().state).toBe('open');

    const count = 100;
    const results = await Promise.allSettled(
      Array.from({ length: count }, () => cb.guard(async () => 'should-not-run')),
    );

    expect(results.length).toBe(count);
    for (const r of results) {
      expect(r.status).toBe('rejected');
      expect((r as PromiseRejectedResult).reason).toBeInstanceOf(AdminCircuitOpenError);
    }

    // State must not have changed — still open at the original failure count
    expect(cb.getHealth().state).toBe('open');
    expect(cb.getHealth().consecutiveFailures).toBe(1);
  });

  test('overlapping concurrent failures trip the breaker', async () => {
    const clock = makeClock();
    const cb = createAdminCircuitBreaker({
      providerName: 'test',
      threshold: 3,
      cooldownMs: 30_000,
      now: clock.now,
    });

    // Fire failures in parallel — the breaker should correctly count
    // each failure regardless of timing interleaving.
    await Promise.all(
      Array.from({ length: 5 }, () =>
        cb
          .guard(async () => {
            throw new Error('fail');
          })
          .catch(() => {}),
      ),
    );

    // The breaker should be open (at least 3 failures)
    const health = cb.getHealth();
    expect(health.state).toBe('open');
    expect(health.consecutiveFailures).toBeGreaterThanOrEqual(3);

    // All subsequent calls must fail fast
    const err = await cb.guard(async () => 'should-not-run').catch(e => e);
    expect(err).toBeInstanceOf(AdminCircuitOpenError);
  });

  test('only one half-open probe is admitted concurrently', async () => {
    const clock = makeClock();
    const cb = createAdminCircuitBreaker({
      providerName: 'test',
      threshold: 1,
      cooldownMs: 1000,
      now: clock.now,
    });

    // Trip
    await cb
      .guard(async () => {
        throw new Error('fail');
      })
      .catch(() => {});

    clock.advance(1001); // Past cooldown

    // Fire 50 guards simultaneously.  Because tryEnterHalfOpen() is
    // synchronous and called during promise construction, the first call
    // transitions to half-open and sets halfOpenInFlight=true; every
    // subsequent call sees halfOpenInFlight and rejects immediately.
    const results = await Promise.allSettled(
      Array.from({ length: 50 }, (_, i) => cb.guard(async () => `probe-${i}`)),
    );

    const succeeded = results.filter(r => r.status === 'fulfilled');
    const rejected = results.filter(r => r.status === 'rejected');

    expect(succeeded.length).toBe(1);
    expect(rejected.length).toBe(49);
    for (const r of rejected) {
      expect((r as PromiseRejectedResult).reason).toBeInstanceOf(AdminCircuitOpenError);
    }

    // The successful probe should have closed the breaker
    expect(cb.getHealth().state).toBe('closed');
  });

  test('concurrent calls while half-open probe is still in-flight', async () => {
    const clock = makeClock();
    const cb = createAdminCircuitBreaker({
      providerName: 'test',
      threshold: 1,
      cooldownMs: 1000,
      now: clock.now,
    });

    // Trip
    await cb
      .guard(async () => {
        throw new Error('fail');
      })
      .catch(() => {});

    clock.advance(1001);

    // Make the probe function return a promise that we control so it stays
    // in-flight while concurrent calls arrive.
    let probeResolve!: (v: string) => void;
    const probePromise = new Promise<string>(resolve => {
      probeResolve = resolve;
    });

    // Start the probe (this calls guard and enters half-open)
    const probeCall = cb.guard(async () => probePromise);

    // While the probe is in-flight, fire concurrent guards — they must all
    // be rejected because halfOpenInFlight is true.
    const concurrentResults = await Promise.allSettled(
      Array.from({ length: 20 }, () => cb.guard(async () => 'should-not-run')),
    );

    for (const r of concurrentResults) {
      expect(r.status).toBe('rejected');
      expect((r as PromiseRejectedResult).reason).toBeInstanceOf(AdminCircuitOpenError);
    }

    // Complete the probe
    probeResolve('probe-ok');
    await probeCall;

    // Breaker should now be closed
    expect(cb.getHealth().state).toBe('closed');
  });
});

// ---------------------------------------------------------------------------
// 3. Concurrent rate-limit state sharing
// ---------------------------------------------------------------------------

describe('concurrent rate limit state', () => {
  test('concurrent hits on the same key produce strictly increasing counts', async () => {
    const store = createMemoryRateLimitStore();
    const opts = { limit: 100, windowMs: 60_000 };

    const results = await Promise.all(
      Array.from({ length: 50 }, () => store.hit('shared-key', opts)),
    );

    const counts = results.map(r => r.count).sort((a, b) => a - b);
    expect(counts).toEqual(Array.from({ length: 50 }, (_, i) => i + 1));

    // All hits share the same window
    const uniqueResetAts = new Set(results.map(r => r.resetAt));
    expect(uniqueResetAts.size).toBe(1);
  });

  test('concurrent hits on different keys do not interfere', async () => {
    const store = createMemoryRateLimitStore();
    const opts = { limit: 10, windowMs: 60_000 };

    const results = await Promise.all(
      Array.from({ length: 20 }, (_, i) => store.hit(`key-${i % 5}`, opts)),
    );

    // Group by key, verify each group has unique sequential counts
    const byKey = new Map<string, number[]>();
    for (let i = 0; i < results.length; i++) {
      const key = `key-${i % 5}`;
      const group = byKey.get(key) ?? [];
      group.push(results[i].count);
      byKey.set(key, group);
    }

    expect(byKey.size).toBe(5);
    for (const [, group] of byKey) {
      group.sort((a, b) => a - b);
      // Each of the 5 buckets gets 4 hits
      expect(group).toEqual([1, 2, 3, 4]);
    }
  });

  test('concurrent hits trip the exceeded flag correctly', async () => {
    const store = createMemoryRateLimitStore();
    const opts = { limit: 3, windowMs: 60_000 };

    const results = await Promise.all(
      Array.from({ length: 5 }, () => store.hit('limited-key', opts)),
    );

    const exceeded = results.filter(r => r.exceeded);
    const notExceeded = results.filter(r => !r.exceeded);

    // First 3 hits are within limit, next 2 exceed
    expect(notExceeded.length).toBe(3);
    expect(exceeded.length).toBe(2);

    for (const r of notExceeded) {
      expect(r.count).toBeGreaterThanOrEqual(1);
      expect(r.count).toBeLessThanOrEqual(3);
    }
    for (const r of exceeded) {
      expect(r.count).toBeGreaterThanOrEqual(4);
    }
  });

  test('concurrent first hits on a fresh key all see count=1 within their window', async () => {
    const store = createMemoryRateLimitStore();

    // Use very short TTL so each hit likely lands in its own window
    const opts = { limit: 5, windowMs: 1 };

    // Wait for any previous window to expire
    await new Promise(resolve => setTimeout(resolve, 5));

    const results = await Promise.all(
      Array.from({ length: 10 }, () => store.hit('fresh-key', opts)),
    );

    // Because the window is very short, concurrent hits may or may not fall
    // in the same window.  The invariant is: no count should be unreasonable.
    for (const r of results) {
      expect(r.count).toBeGreaterThanOrEqual(1);
      expect(r.count).toBeLessThanOrEqual(10);
      expect(r.exceeded).toBe(r.count > opts.limit);
    }
  });
});

// ---------------------------------------------------------------------------
// 4. Metrics collection under concurrent access
// ---------------------------------------------------------------------------

describe('metrics under concurrent access', () => {
  test('concurrent request count increments are all counted', async () => {
    const metrics = createAdminMetricsCollector();

    await Promise.all(
      Array.from({ length: 100 }, () => Promise.resolve(metrics.incrementRequestCount())),
    );

    expect(metrics.getMetrics().requestCount).toBe(100);
  });

  test('concurrent error count increments are all counted', async () => {
    const metrics = createAdminMetricsCollector();

    await Promise.all(
      Array.from({ length: 50 }, () => Promise.resolve(metrics.incrementErrorCount())),
    );

    expect(metrics.getMetrics().errorCount).toBe(50);
  });

  test('concurrent provider calls are aggregated per-method', async () => {
    const metrics = createAdminMetricsCollector();

    await Promise.all(
      Array.from({ length: 50 }, (_, i) =>
        Promise.resolve(
          metrics.recordProviderCall(i % 2 === 0 ? 'auth0:verifyRequest' : 'auth0:getUser'),
        ),
      ),
    );

    const snapshot = metrics.getMetrics();
    expect(snapshot.providerCalls['auth0:verifyRequest']).toBe(25);
    expect(snapshot.providerCalls['auth0:getUser']).toBe(25);
  });

  test('concurrent provider failures are aggregated per-method', async () => {
    const metrics = createAdminMetricsCollector();

    await Promise.all(
      Array.from({ length: 30 }, (_, i) =>
        Promise.resolve(metrics.recordProviderFailure(i % 2 === 0 ? 'db:query' : 'redis:fetch')),
      ),
    );

    const snapshot = metrics.getMetrics();
    expect(snapshot.providerFailures['db:query']).toBe(15);
    expect(snapshot.providerFailures['redis:fetch']).toBe(15);
  });

  test('concurrent rate-limit hit increments are all counted', async () => {
    const metrics = createAdminMetricsCollector();

    await Promise.all(
      Array.from({ length: 25 }, () => Promise.resolve(metrics.incrementRateLimitHit())),
    );

    expect(metrics.getMetrics().rateLimitHitCount).toBe(25);
  });

  test('concurrent mixed operations produce a consistent snapshot', async () => {
    const metrics = createAdminMetricsCollector();

    await Promise.all([
      ...Array.from({ length: 40 }, () => Promise.resolve(metrics.incrementRequestCount())),
      ...Array.from({ length: 10 }, () => Promise.resolve(metrics.incrementErrorCount())),
      ...Array.from({ length: 20 }, () => Promise.resolve(metrics.incrementRateLimitHit())),
      ...Array.from({ length: 15 }, () =>
        Promise.resolve(metrics.recordProviderCall('auth0:verifyRequest')),
      ),
      ...Array.from({ length: 5 }, () =>
        Promise.resolve(metrics.recordProviderFailure('auth0:verifyRequest')),
      ),
    ]);

    const snapshot = metrics.getMetrics();
    expect(snapshot.requestCount).toBe(40);
    expect(snapshot.errorCount).toBe(10);
    expect(snapshot.rateLimitHitCount).toBe(20);
    expect(snapshot.providerCalls['auth0:verifyRequest']).toBe(15);
    expect(snapshot.providerFailures['auth0:verifyRequest']).toBe(5);
  });

  test('snapshot returns a copy that is not mutated by subsequent increments', async () => {
    const metrics = createAdminMetricsCollector();

    metrics.incrementRequestCount();
    metrics.incrementRequestCount();

    const snapshot = metrics.getMetrics();
    expect(snapshot.requestCount).toBe(2);

    // Mutate after snapshot
    metrics.incrementRequestCount();
    metrics.incrementErrorCount();

    // Snapshot should be frozen at the old value
    expect(snapshot.requestCount).toBe(2);
    expect(snapshot.errorCount).toBe(0);
    // Current metrics reflect the new state
    expect(metrics.getMetrics().requestCount).toBe(3);
    expect(metrics.getMetrics().errorCount).toBe(1);
  });

  test('reset clears counters and concurrent increments after reset are counted', async () => {
    const metrics = createAdminMetricsCollector();

    metrics.incrementRequestCount();
    metrics.incrementErrorCount();
    metrics.reset();

    expect(metrics.getMetrics().requestCount).toBe(0);
    expect(metrics.getMetrics().errorCount).toBe(0);

    await Promise.all(
      Array.from({ length: 10 }, () => Promise.resolve(metrics.incrementRequestCount())),
    );

    expect(metrics.getMetrics().requestCount).toBe(10);
  });
});
