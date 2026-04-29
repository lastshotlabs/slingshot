import { beforeEach, describe, expect, it } from 'bun:test';
import { createCircuitBreaker } from '../../src/circuitBreaker';

describe('createCircuitBreaker', () => {
  let breaker: ReturnType<typeof createCircuitBreaker>;

  beforeEach(() => {
    breaker = createCircuitBreaker({ failureThreshold: 3, cooldownMs: 60_000 });
  });

  it('starts in closed state', () => {
    expect(breaker.state).toBe('closed');
    expect(breaker.failureCount).toBe(0);
  });

  it('executes a successful function and returns the value', async () => {
    const result = await breaker.execute(async () => 'hello');
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toBe('hello');
  });

  it('records failures and keeps the circuit closed below the threshold', async () => {
    const fn = async () => {
      throw new Error('fail');
    };
    const r1 = await breaker.execute(fn);
    expect(r1.ok).toBe(false);
    if (!r1.ok) {
      expect(r1.reason).toBe('execution_failed');
      expect(r1.error.message).toBe('fail');
    }
    expect(breaker.state).toBe('closed');
    expect(breaker.failureCount).toBe(1);

    const r2 = await breaker.execute(fn);
    expect(r2.ok).toBe(false);
    expect(breaker.failureCount).toBe(2);
    expect(breaker.state).toBe('closed');
  });

  it('opens the circuit when failure threshold is reached', async () => {
    const fn = async () => {
      throw new Error('fail');
    };
    await breaker.execute(fn);
    await breaker.execute(fn);

    // Third failure should open the circuit
    const r3 = await breaker.execute(fn);
    expect(r3.ok).toBe(false);
    if (!r3.ok) {
      expect(r3.reason).toBe('execution_failed');
    }
    expect(breaker.state).toBe('open');
    expect(breaker.failureCount).toBe(3);
  });

  it('rejects requests immediately when circuit is open', async () => {
    const fn = async () => {
      throw new Error('fail');
    };
    // Trigger threshold
    await breaker.execute(fn);
    await breaker.execute(fn);
    await breaker.execute(fn);
    expect(breaker.state).toBe('open');

    // This request should be rejected without calling fn
    const rejected = await breaker.execute(fn);
    expect(rejected.ok).toBe(false);
    if (!rejected.ok) {
      expect(rejected.reason).toBe('circuit_open');
    }
  });

  it('resets failure count on success', async () => {
    // Two failures
    const failFn = async () => {
      throw new Error('fail');
    };
    await breaker.execute(failFn);
    await breaker.execute(failFn);
    expect(breaker.failureCount).toBe(2);

    // One success resets
    const success = await breaker.execute(async () => 'ok');
    expect(success.ok).toBe(true);
    expect(breaker.failureCount).toBe(0);
  });

  it('can be manually closed', async () => {
    const fn = async () => {
      throw new Error('fail');
    };
    await breaker.execute(fn);
    await breaker.execute(fn);
    await breaker.execute(fn);
    expect(breaker.state).toBe('open');

    breaker.close();
    expect(breaker.state).toBe('closed');
    expect(breaker.failureCount).toBe(0);

    // Should work again
    const result = await breaker.execute(async () => 'recovered');
    expect(result.ok).toBe(true);
  });

  it('can be manually opened', () => {
    breaker.open('maintenance');
    expect(breaker.state).toBe('open');
  });

  it('reset restores initial state', async () => {
    const fn = async () => {
      throw new Error('fail');
    };
    await breaker.execute(fn);
    await breaker.execute(fn);
    await breaker.execute(fn);
    expect(breaker.state).toBe('open');

    breaker.reset();
    expect(breaker.state).toBe('closed');
    expect(breaker.failureCount).toBe(0);

    const result = await breaker.execute(async () => 'ok');
    expect(result.ok).toBe(true);
  });

  it('closes the circuit from half_open when probe succeeds', async () => {
    const failFn = async () => {
      throw new Error('fail');
    };
    await breaker.execute(failFn);
    await breaker.execute(failFn);
    await breaker.execute(failFn);
    expect(breaker.state).toBe('open');

    // Manually transition to half_open to simulate cooldown expiry
    // We do this by forcing state via open/close and timing
    // Instead, create a new breaker with a very short cooldown
    const shortBreaker = createCircuitBreaker({ failureThreshold: 2, cooldownMs: 50 });
    await shortBreaker.execute(failFn);
    await shortBreaker.execute(failFn);
    expect(shortBreaker.state).toBe('open');

    // Wait for cooldown
    await new Promise(resolve => setTimeout(resolve, 60));

    // State should auto-transition to half_open on access
    expect(shortBreaker.state).toBe('half_open');

    // A successful probe should close the circuit
    const ok = await shortBreaker.execute(async () => 'probe ok');
    expect(ok.ok).toBe(true);
    expect(shortBreaker.state).toBe('closed');
  });

  it('re-opens the circuit when a half_open probe fails', async () => {
    const failFn = async () => {
      throw new Error('fail');
    };
    const shortBreaker = createCircuitBreaker({ failureThreshold: 2, cooldownMs: 50 });
    await shortBreaker.execute(failFn);
    await shortBreaker.execute(failFn);
    expect(shortBreaker.state).toBe('open');

    // Wait for cooldown
    await new Promise(resolve => setTimeout(resolve, 60));
    expect(shortBreaker.state).toBe('half_open');

    // Probe fails — back to open
    const result = await shortBreaker.execute(failFn);
    expect(result.ok).toBe(false);
    expect(shortBreaker.state).toBe('open');
  });

  it('calls onStateChange callback', () => {
    const transitions: string[] = [];
    const cb = createCircuitBreaker({
      failureThreshold: 1,
      cooldownMs: 60_000,
      onStateChange(from, to) {
        transitions.push(`${from}->${to}`);
      },
    });

    cb.open('test');
    expect(transitions).toContain('closed->open');
  });

  it('calls onFailure callback on each failure', async () => {
    const failures: Array<{ error: string; count: number }> = [];
    const cb = createCircuitBreaker({
      failureThreshold: 3,
      cooldownMs: 60_000,
      onFailure(error, count) {
        failures.push({ error: error.message, count });
      },
    });

    await cb.execute(async () => {
      throw new Error('err1');
    });
    await cb.execute(async () => {
      throw new Error('err2');
    });
    await cb.execute(async () => {
      throw new Error('err3');
    });

    expect(failures).toEqual([
      { error: 'err1', count: 1 },
      { error: 'err2', count: 2 },
      { error: 'err3', count: 3 },
    ]);
  });
});
