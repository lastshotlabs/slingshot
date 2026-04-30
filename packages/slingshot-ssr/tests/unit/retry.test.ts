import { beforeEach, describe, expect, it } from 'bun:test';
import { retry } from '../../src/retry';
import type { RetryOptions } from '../../src/retry';

describe('retry', () => {
  const defaultOpts: Partial<RetryOptions> = {
    maxAttempts: 2,
    baseDelayMs: 10, // Use short delay for fast tests
  };

  it('returns the value when the function succeeds on the first call', async () => {
    const result = await retry(async () => 'hello', defaultOpts);
    expect(result).toBe('hello');
  });

  it('succeeds after a retry when the first call fails', async () => {
    let callCount = 0;
    const fn = async () => {
      callCount++;
      if (callCount === 1) throw new Error('first fail');
      return 'recovered';
    };

    const result = await retry(fn, defaultOpts);
    expect(result).toBe('recovered');
    expect(callCount).toBe(2);
  });

  it('throws after exhausting all retry attempts', async () => {
    let callCount = 0;
    const fn = async () => {
      callCount++;
      throw new Error(`fail #${callCount}`);
    };

    await expect(retry(fn, defaultOpts)).rejects.toThrow('fail #3');
    expect(callCount).toBe(3); // initial + 2 retries
  });

  it('throws the last error when all attempts fail', async () => {
    const fn = async () => {
      throw new Error('last error');
    };

    try {
      await retry(fn, defaultOpts);
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(Error);
      expect((err as Error).message).toBe('last error');
    }
  });

  it('does not retry when isRetryable returns false', async () => {
    let callCount = 0;
    const fn = async () => {
      callCount++;
      throw new Error('non-retryable');
    };

    await expect(
      retry(fn, {
        ...defaultOpts,
        isRetryable: () => false,
      }),
    ).rejects.toThrow('non-retryable');

    // Should only be called once — no retry
    expect(callCount).toBe(1);
  });

  it('retries only when isRetryable returns true', async () => {
    let callCount = 0;
    const fn = async () => {
      callCount++;
      throw new Error('server-error');
    };

    await expect(
      retry(fn, {
        ...defaultOpts,
        isRetryable: err => err.message.includes('server'),
      }),
    ).rejects.toThrow('server-error');

    // Should have retried because the error is retryable
    expect(callCount).toBe(3);
  });

  it('invokes onRetry callback with the error and attempt number', async () => {
    let callCount = 0;
    const retries: Array<{ error: string; attempt: number }> = [];
    const fn = async () => {
      callCount++;
      throw new Error(`fail-${callCount}`);
    };

    await expect(
      retry(fn, {
        ...defaultOpts,
        onRetry(error, attempt) {
          retries.push({ error: error.message, attempt });
        },
      }),
    ).rejects.toThrow('fail-3');

    expect(retries).toEqual([
      { error: 'fail-1', attempt: 1 },
      { error: 'fail-2', attempt: 2 },
    ]);
  });

  it('respects custom maxAttempts', async () => {
    let callCount = 0;
    const fn = async () => {
      callCount++;
      throw new Error('fail');
    };

    await expect(retry(fn, { maxAttempts: 5, baseDelayMs: 5 })).rejects.toThrow('fail');

    // initial + 5 retries = 6 total calls
    expect(callCount).toBe(6);
  });

  it('wraps non-Error thrown values in Error', async () => {
    const fn = async () => {
      throw 'string error'; // eslint-disable-line no-throw-literal
    };

    await expect(retry(fn, defaultOpts)).rejects.toThrow('string error');
  });

  it('does not retry when maxAttempts is 0', async () => {
    let callCount = 0;
    const fn = async () => {
      callCount++;
      throw new Error('no retry');
    };

    await expect(retry(fn, { maxAttempts: 0, baseDelayMs: 10 })).rejects.toThrow('no retry');

    // initial call only — no retries allowed
    expect(callCount).toBe(1);
  });

  it('applies backoff delay between retries', async () => {
    let callCount = 0;
    const fn = async () => {
      callCount++;
      throw new Error('fail');
    };

    const start = Date.now();
    await expect(retry(fn, { maxAttempts: 3, baseDelayMs: 50 })).rejects.toThrow('fail');
    const elapsed = Date.now() - start;

    // With baseDelayMs=50 and maxAttempts=3, the cumulative delay is:
    // attempt 1: random(0, 50) = up to 50ms
    // attempt 2: random(0, 100) = up to 100ms
    // attempt 3: random(0, 200) = up to 200ms
    // Total could be up to ~350ms, minimum should be > 0
    // We just check that the function didn't complete instantly (which would mean no delay)
    expect(elapsed).toBeGreaterThan(0);
    expect(callCount).toBe(4); // initial + 3 retries
  });

  it('stops retrying once the function succeeds', async () => {
    let callCount = 0;
    const fn = async () => {
      callCount++;
      if (callCount <= 2) throw new Error(`fail-${callCount}`);
      return 'success';
    };

    const result = await retry(fn, defaultOpts);
    expect(result).toBe('success');
    expect(callCount).toBe(3); // initial fail, retry 1 fail, retry 2 success
  });
});
