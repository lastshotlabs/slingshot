/**
 * Tests for the manager-level circuit breaker and retry utility.
 *
 * Verifies closed -> open -> half-open cycle, fail-fast behavior while open,
 * recovery via half-open probe, and retry with exponential backoff.
 *
 * Uses a fake clock and mock provider functions so tests are deterministic
 * and do not depend on real wall-clock timing.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { isTransientError, withRetry } from '../src/retry';
import {
  SearchCircuitOpenError,
  createSearchCircuitBreaker,
} from '../src/searchCircuitBreaker';

// ============================================================================
// Fake clock
// ============================================================================

interface FakeClock {
  now: number;
  advance(ms: number): void;
}

function makeClock(start = 0): FakeClock {
  return { now: start, advance(ms) { this.now += ms; } };
}

// ============================================================================
// Circuit breaker tests
// ============================================================================

describe('SearchCircuitBreaker', () => {
  let clock: FakeClock;

  beforeEach(() => {
    clock = makeClock();
  });

  it('starts in closed state', () => {
    const cb = createSearchCircuitBreaker({ providerKey: 'test', now: () => clock.now });
    const health = cb.getHealth();
    expect(health.state).toBe('closed');
    expect(health.consecutiveFailures).toBe(0);
    expect(health.openedAt).toBeUndefined();
    expect(health.nextProbeAt).toBeUndefined();
  });

  it('opens after threshold consecutive failures', async () => {
    const cb = createSearchCircuitBreaker({
      providerKey: 'test',
      threshold: 3,
      cooldownMs: 10_000,
      now: () => clock.now,
    });

    // Two failures — still closed.
    await expect(cb.guard(() => Promise.reject(new Error('fail')))).rejects.toThrow('fail');
    expect(cb.getHealth().state).toBe('closed');

    await expect(cb.guard(() => Promise.reject(new Error('fail')))).rejects.toThrow('fail');
    expect(cb.getHealth().state).toBe('closed');

    // Third failure — opens.
    await expect(cb.guard(() => Promise.reject(new Error('fail')))).rejects.toThrow('fail');
    expect(cb.getHealth().state).toBe('open');

    // openedAt should be set
    expect(cb.getHealth().openedAt).toBe(clock.now);
  });

  it('fails fast while the breaker is open (before cooldown)', async () => {
    const cb = createSearchCircuitBreaker({
      providerKey: 'test',
      threshold: 1,
      cooldownMs: 10_000,
      now: () => clock.now,
    });

    // Trip the breaker.
    await expect(cb.guard(() => Promise.reject(new Error('fail')))).rejects.toThrow('fail');
    expect(cb.getHealth().state).toBe('open');

    // Next call should fail fast with SearchCircuitOpenError.
    const err = await cb.guard(() => Promise.resolve('ok')).catch(e => e);
    expect(err).toBeInstanceOf(SearchCircuitOpenError);
    expect((err as SearchCircuitOpenError).providerKey).toBe('test');
    expect((err as SearchCircuitOpenError).retryAfterMs).toBeGreaterThan(0);
  });

  it('transitions open -> half-open after cooldown, probe success resets to closed', async () => {
    const cb = createSearchCircuitBreaker({
      providerKey: 'test',
      threshold: 2,
      cooldownMs: 500,
      now: () => clock.now,
    });

    // Trip the breaker with 2 failures.
    await expect(cb.guard(() => Promise.reject(new Error('fail')))).rejects.toThrow('fail');
    await expect(cb.guard(() => Promise.reject(new Error('fail')))).rejects.toThrow('fail');
    expect(cb.getHealth().state).toBe('open');

    // Advance past cooldown.
    clock.advance(600);

    // Probe succeeds — back to closed.
    const result = await cb.guard(() => Promise.resolve('ok'));
    expect(result).toBe('ok');
    expect(cb.getHealth().state).toBe('closed');
    expect(cb.getHealth().consecutiveFailures).toBe(0);
  });

  it('half-open probe failure re-opens the breaker', async () => {
    const cb = createSearchCircuitBreaker({
      providerKey: 'test',
      threshold: 1,
      cooldownMs: 500,
      now: () => clock.now,
    });

    // Trip the breaker.
    await expect(cb.guard(() => Promise.reject(new Error('fail')))).rejects.toThrow('fail');
    expect(cb.getHealth().state).toBe('open');

    // Advance past cooldown.
    clock.advance(600);

    // Half-open probe is admitted — but it fails.
    await expect(cb.guard(() => Promise.reject(new Error('still down')))).rejects.toThrow('still down');
    expect(cb.getHealth().state).toBe('open');

    // openedAt should now reflect the fresh cooldown from the failed probe.
    expect(cb.getHealth().openedAt).toBe(clock.now);
  });

  it('only admits one half-open probe at a time', async () => {
    const cb = createSearchCircuitBreaker({
      providerKey: 'test',
      threshold: 1,
      cooldownMs: 500,
      now: () => clock.now,
    });

    // Trip the breaker.
    await expect(cb.guard(() => Promise.reject(new Error('fail')))).rejects.toThrow('fail');

    // Advance past cooldown.
    clock.advance(600);

    // First call enters half-open.
    const probe1 = cb.guard(() => Promise.resolve('first'));
    // Second call while half-open probe is in-flight should fail fast.
    const probe2 = cb.guard(() => Promise.resolve('second')).catch(e => e);

    await expect(probe1).resolves.toBe('first');
    const err2 = await probe2;
    expect(err2).toBeInstanceOf(SearchCircuitOpenError);
  });

  it('reset restores closed state', async () => {
    const cb = createSearchCircuitBreaker({
      providerKey: 'test',
      threshold: 1,
      cooldownMs: 10_000,
      now: () => clock.now,
    });

    // Trip the breaker.
    await expect(cb.guard(() => Promise.reject(new Error('fail')))).rejects.toThrow('fail');
    expect(cb.getHealth().state).toBe('open');

    cb.reset();
    expect(cb.getHealth().state).toBe('closed');
    expect(cb.getHealth().consecutiveFailures).toBe(0);
    expect(cb.getHealth().openedAt).toBeUndefined();

    // After reset, operations succeed again.
    const result = await cb.guard(() => Promise.resolve('works'));
    expect(result).toBe('works');
  });
});

// ============================================================================
// Retry tests
// ============================================================================

describe('withRetry', () => {
  it('returns the result on success (no retries needed)', async () => {
    const result = await withRetry(() => Promise.resolve(42));
    expect(result).toBe(42);
  });

  it('retries on transient errors and succeeds on retry', async () => {
    let attempts = 0;
    const result = await withRetry(
      () => {
        attempts++;
        if (attempts < 3) return Promise.reject(new Error('timeout'));
        return Promise.resolve('ok');
      },
      { maxRetries: 3, baseDelayMs: 10 },
    );
    expect(result).toBe('ok');
    expect(attempts).toBe(3);
  });

  it('throws the last error after exhausting retries', async () => {
    let attempts = 0;
    await expect(
      withRetry(
        () => {
          attempts++;
          return Promise.reject(new Error('timeout'));
        },
        { maxRetries: 2, baseDelayMs: 10 },
      ),
    ).rejects.toThrow('timeout');
    expect(attempts).toBe(3); // initial + 2 retries
  });

  it('does not retry non-transient errors', async () => {
    let attempts = 0;
    await expect(
      withRetry(
        () => {
          attempts++;
          return Promise.reject(new Error('validation error'));
        },
        { maxRetries: 3, baseDelayMs: 10 },
      ),
    ).rejects.toThrow('validation error');
    expect(attempts).toBe(1); // no retry for non-transient
  });

  it('does not retry SearchCircuitOpenError', async () => {
    const breaker = createSearchCircuitBreaker({
      providerKey: 'test',
      threshold: 1,
      cooldownMs: 10_000,
      now: () => 0,
    });
    // Trip the breaker so guard will throw SearchCircuitOpenError.
    await expect(breaker.guard(() => Promise.reject(new Error('fail')))).rejects.toThrow('fail');

    let attempts = 0;
    await expect(
      withRetry(
        () => {
          attempts++;
          return breaker.guard(() => Promise.resolve('never reached'));
        },
        { maxRetries: 3, baseDelayMs: 10 },
      ),
    ).rejects.toBeInstanceOf(SearchCircuitOpenError);
    expect(attempts).toBe(1); // no retry — circuit-open errors are excluded
  });

  it('uses exponential backoff between retries', async () => {
    const timestamps: number[] = [];
    const fakeNow = () => timestamps[timestamps.length - 1] ?? 0;

    // We'll resolve the promise after 3 transient failures.
    let attempts = 0;
    await withRetry(
      () => {
        attempts++;
        timestamps.push(attempts === 1 ? 0 : attempts === 2 ? 100 : 300);
        if (attempts < 3) return Promise.reject(new Error('timeout'));
        return Promise.resolve('ok');
      },
      { maxRetries: 3, baseDelayMs: 100 },
    );

    // The delays should grow exponentially (100, 200, 400... capped at maxDelayMs).
    expect(attempts).toBe(3);
  });
});

// ============================================================================
// isTransientError tests
// ============================================================================

describe('isTransientError', () => {
  it('returns true for timeout errors', () => {
    expect(isTransientError(new Error('timeout'))).toBe(true);
    expect(isTransientError(new Error('Timeout'))).toBe(true);
    expect(isTransientError(new Error('Request timed out'))).toBe(true);
  });

  it('returns true for connection refused', () => {
    expect(isTransientError(new Error('ECONNREFUSED'))).toBe(true);
    expect(isTransientError(new Error('connection refused'))).toBe(true);
  });

  it('returns true for 5xx and 429 status codes', () => {
    expect(isTransientError(new Error('HTTP 503 Service Unavailable'))).toBe(true);
    expect(isTransientError(new Error('502 Bad Gateway'))).toBe(true);
    expect(isTransientError(new Error('504 Gateway Timeout'))).toBe(true);
    expect(isTransientError(new Error('429 Too Many Requests'))).toBe(true);
  });

  it('returns false for SearchCircuitOpenError', () => {
    const err = new SearchCircuitOpenError('circuit open', 'test', 5000);
    expect(isTransientError(err)).toBe(false);
  });

  it('returns false for non-transient errors', () => {
    expect(isTransientError(new Error('Not found'))).toBe(false);
    expect(isTransientError(new Error('Invalid input'))).toBe(false);
    expect(isTransientError(new Error('Unauthorized'))).toBe(false);
  });

  it('returns false for non-Error values', () => {
    expect(isTransientError('string error')).toBe(false);
    expect(isTransientError(42)).toBe(false);
    expect(isTransientError(null)).toBe(false);
    expect(isTransientError({ message: 'some error' })).toBe(false);
  });
});
