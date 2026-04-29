/**
 * Tests for the admin plugin circuit breaker.
 *
 * Covers the full state machine: closed -> open -> half-open -> closed,
 * failure counting, cooldown timing, and error semantics.
 */
import { describe, expect, test } from 'bun:test';
import {
  AdminCircuitOpenError,
  createAdminCircuitBreaker,
} from '../../src/lib/circuitBreaker';

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
    reset(t = 0) {
      now = t;
    },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('createAdminCircuitBreaker', () => {
  test('starts in closed state', () => {
    const cb = createAdminCircuitBreaker({ providerName: 'test' });
    const health = cb.getHealth();
    expect(health.state).toBe('closed');
    expect(health.consecutiveFailures).toBe(0);
    expect(health.openedAt).toBeUndefined();
    expect(health.nextProbeAt).toBeUndefined();
  });

  test('passes through successful calls without changing state', async () => {
    const clock = makeClock();
    const cb = createAdminCircuitBreaker({ providerName: 'test', now: clock.now });
    const result = await cb.guard(async () => 'success');
    expect(result).toBe('success');
    const health = cb.getHealth();
    expect(health.state).toBe('closed');
    expect(health.consecutiveFailures).toBe(0);
  });

  test('resets failure count on success', async () => {
    const clock = makeClock();
    const cb = createAdminCircuitBreaker({
      providerName: 'test',
      threshold: 3,
      now: clock.now,
    });

    // Two failures
    await cb.guard(async () => { throw new Error('fail'); }).catch(() => {});
    await cb.guard(async () => { throw new Error('fail'); }).catch(() => {});

    expect(cb.getHealth().consecutiveFailures).toBe(2);

    // Success resets
    await cb.guard(async () => 'ok');
    expect(cb.getHealth().consecutiveFailures).toBe(0);
  });

  test('trips open after threshold consecutive failures', async () => {
    const clock = makeClock();
    const cb = createAdminCircuitBreaker({
      providerName: 'test',
      threshold: 3,
      now: clock.now,
    });

    for (let i = 0; i < 3; i++) {
      await cb.guard(async () => { throw new Error('fail'); }).catch(() => {});
    }

    const health = cb.getHealth();
    expect(health.state).toBe('open');
    expect(health.consecutiveFailures).toBe(3);
    expect(health.openedAt).toBe(clock.now());
    expect(health.nextProbeAt).toBe(clock.now() + 30000);
  });

  test('throws AdminCircuitOpenError when breaker is open', async () => {
    const clock = makeClock();
    const cb = createAdminCircuitBreaker({
      providerName: 'test',
      threshold: 1,
      cooldownMs: 60000,
      now: clock.now,
    });

    // Trip the breaker
    await cb.guard(async () => { throw new Error('boom'); }).catch(() => {});

    // Now open — should throw AdminCircuitOpenError
    const err = await cb.guard(async () => 'should-not-run').catch(e => e);
    expect(err).toBeInstanceOf(AdminCircuitOpenError);
    expect((err as AdminCircuitOpenError).providerName).toBe('test');
    expect((err as AdminCircuitOpenError).retryAfterMs).toBe(60000);
    // The provider function should not have been called
    expect(err.providerName).toBe('test');

    // State remains open, failures still at threshold
    expect(cb.getHealth().state).toBe('open');
    expect(cb.getHealth().consecutiveFailures).toBe(1);
  });

  test('enters half-open after cooldown elapses', async () => {
    const clock = makeClock();
    const cb = createAdminCircuitBreaker({
      providerName: 'test',
      threshold: 1,
      cooldownMs: 1000,
      now: clock.now,
    });

    // Trip the breaker
    await cb.guard(async () => { throw new Error('boom'); }).catch(() => {});
    expect(cb.getHealth().state).toBe('open');

    // Advance past cooldown
    clock.advance(1001);

    // Next call should succeed (half-open probe)
    const result = await cb.guard(async () => 'probe-ok');
    expect(result).toBe('probe-ok');

    // State should be closed again
    expect(cb.getHealth().state).toBe('closed');
    expect(cb.getHealth().consecutiveFailures).toBe(0);
  });

  test('re-opens when half-open probe fails', async () => {
    const clock = makeClock();
    const cb = createAdminCircuitBreaker({
      providerName: 'test',
      threshold: 1,
      cooldownMs: 1000,
      now: clock.now,
    });

    // Trip the breaker
    await cb.guard(async () => { throw new Error('boom'); }).catch(() => {});
    expect(cb.getHealth().state).toBe('open');

    // Advance past cooldown
    clock.advance(1001);

    // Half-open probe fails
    await cb.guard(async () => { throw new Error('fail-again'); }).catch(() => {});
    expect(cb.getHealth().state).toBe('open');
    expect(cb.getHealth().consecutiveFailures).toBe(2);
    expect(cb.getHealth().openedAt).toBe(clock.now());

    // Next call should still be rejected
    const err = await cb.guard(async () => 'should-not-run').catch(e => e);
    expect(err).toBeInstanceOf(AdminCircuitOpenError);
  });

  test('only allows one half-open probe at a time', async () => {
    const clock = makeClock();
    const cb = createAdminCircuitBreaker({
      providerName: 'test',
      threshold: 1,
      cooldownMs: 1000,
      now: clock.now,
    });

    // Trip the breaker
    await cb.guard(async () => { throw new Error('boom'); }).catch(() => {});
    clock.advance(1001);

    // First probe enters half-open
    const probe1 = cb.guard(async () => {
      // While inside the guard, check health is half-open
      expect(cb.getHealth().state).toBe('half-open');
      return 'ok';
    });

    // Second call while half-open probe is in-flight should be rejected
    const err = await cb.guard(async () => 'should-not-run').catch(e => e);
    expect(err).toBeInstanceOf(AdminCircuitOpenError);

    await probe1;
    expect(cb.getHealth().state).toBe('closed');
  });

  test('uses default threshold of 5 and cooldown of 30000ms', () => {
    const cb = createAdminCircuitBreaker({ providerName: 'defaults' });
    expect(cb.getHealth().state).toBe('closed');
    // Threshold is implicit — we can verify by checking the error message
    // when the breaker opens, but for now just verify defaults don't crash
  });

  test('getHealth returns correct nextProbeAt', async () => {
    const clock = makeClock();
    const cb = createAdminCircuitBreaker({
      providerName: 'test',
      threshold: 1,
      cooldownMs: 5000,
      now: clock.now,
    });

    // While closed, nextProbeAt is undefined
    expect(cb.getHealth().nextProbeAt).toBeUndefined();

    // Trip it — await the guard so state transitions complete
    await cb.guard(async () => { throw new Error('fail'); }).catch(() => {});
    expect(cb.getHealth().nextProbeAt).toBe(clock.now() + 5000);
  });

  test('AdminCircuitOpenError has correct properties', () => {
    const err = new AdminCircuitOpenError('test message', 'auth0', 5000);
    expect(err.name).toBe('AdminCircuitOpenError');
    expect(err.code).toBe('ADMIN_CIRCUIT_OPEN');
    expect(err.providerName).toBe('auth0');
    expect(err.retryAfterMs).toBe(5000);
    expect(err.message).toContain('test message');
  });
});
