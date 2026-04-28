// Unit tests for the IsrTracker primitive used by the SSR middleware to cap
// concurrent ISR background regenerations (P-SSR-1) and to drain pending
// fire-and-forget cache writes on dispose (P-SSR-7).
import { describe, expect, test } from 'bun:test';
import { createIsrTracker } from '../../../src/middleware';

describe('createIsrTracker — concurrent regen cap (P-SSR-1)', () => {
  test('grants at most maxConcurrent in-flight regen claims and drops the rest', () => {
    const tracker = createIsrTracker(32);
    const granted: string[] = [];
    const dropped: string[] = [];

    // 33 distinct keys: 32 must be granted, 1 must be dropped because the
    // global cap was reached (no key is duplicated, so per-key dedup is not
    // exercised here — it is the cap path).
    for (let i = 0; i < 33; i += 1) {
      const key = `/route-${i}`;
      if (tracker.tryClaimRegen(key)) granted.push(key);
      else dropped.push(key);
    }

    expect(granted).toHaveLength(32);
    expect(dropped).toHaveLength(1);
    expect(tracker.getDroppedCount()).toBe(1);
  });

  test('releasing a slot frees capacity for another key', () => {
    const tracker = createIsrTracker(2);
    expect(tracker.tryClaimRegen('/a')).toBe(true);
    expect(tracker.tryClaimRegen('/b')).toBe(true);
    expect(tracker.tryClaimRegen('/c')).toBe(false); // cap reached
    tracker.releaseRegen('/a');
    expect(tracker.tryClaimRegen('/c')).toBe(true);
  });

  test('per-key dedup prevents two simultaneous regens for the same route', () => {
    const tracker = createIsrTracker(32);
    expect(tracker.tryClaimRegen('/dup')).toBe(true);
    expect(tracker.tryClaimRegen('/dup')).toBe(false);
    expect(tracker.getDroppedCount()).toBe(1);
  });
});

describe('createIsrTracker — pending write drain (P-SSR-7)', () => {
  test('drainPendingWrites awaits in-flight cache writes', async () => {
    const tracker = createIsrTracker(32);
    let resolved = false;
    const pending = new Promise<void>(resolve => {
      setTimeout(() => {
        resolved = true;
        resolve();
      }, 10);
    });
    tracker.trackWrite(pending);
    await tracker.drainPendingWrites(1_000);
    expect(resolved).toBe(true);
  });

  test('drainPendingWrites returns immediately when no writes pending', async () => {
    const tracker = createIsrTracker(32);
    const start = Date.now();
    await tracker.drainPendingWrites(5_000);
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(50);
  });

  test('drainPendingWrites times out without throwing when write hangs', async () => {
    const tracker = createIsrTracker(32);
    // Hung write — never settles
    tracker.trackWrite(new Promise<void>(() => {}));
    const start = Date.now();
    await tracker.drainPendingWrites(50);
    const elapsed = Date.now() - start;
    expect(elapsed).toBeGreaterThanOrEqual(40);
    expect(elapsed).toBeLessThan(500);
  });

  test('drainPendingWrites swallows rejected writes (caller already logged)', async () => {
    const tracker = createIsrTracker(32);
    const rejected = Promise.reject(new Error('cache write boom'));
    // Catch to avoid unhandled rejection warning before tracker installs its
    // finally hook (the tracker uses promise.finally which runs after the
    // initial then chain).
    rejected.catch(() => {});
    tracker.trackWrite(rejected);
    await expect(tracker.drainPendingWrites(1_000)).resolves.toBeUndefined();
  });
});
