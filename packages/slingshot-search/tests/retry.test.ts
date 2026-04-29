import { describe, expect, it } from 'bun:test';
import { isTransientError, withRetry } from '../src/retry';
import { SearchCircuitOpenError } from '../src/searchCircuitBreaker';

describe('isTransientError', () => {
  it('returns false for SearchCircuitOpenError', () => {
    const err = new SearchCircuitOpenError('circuit is open', 'test-provider', 1_000);
    expect(isTransientError(err)).toBe(false);
  });

  it('returns true for timeout errors', () => {
    expect(isTransientError(new Error('Connection timed out'))).toBe(true);
    expect(isTransientError(new Error('request timeout'))).toBe(true);
    expect(isTransientError(new Error('ETIMEDOUT'))).toBe(true);
  });

  it('returns true for connection-refused errors', () => {
    expect(isTransientError(new Error('ECONNREFUSED'))).toBe(true);
    expect(isTransientError(new Error('Connection refused'))).toBe(true);
  });

  it('returns true for connection-reset errors', () => {
    expect(isTransientError(new Error('ECONNRESET'))).toBe(true);
    expect(isTransientError(new Error('socket hang up'))).toBe(true);
  });

  it('returns true for DNS resolution errors', () => {
    expect(isTransientError(new Error('EAI_AGAIN'))).toBe(true);
    expect(isTransientError(new Error('ENOTFOUND'))).toBe(true);
    expect(isTransientError(new Error('ENXIO'))).toBe(true);
  });

  it('returns true for HTTP 429 and 5xx status codes', () => {
    expect(isTransientError(new Error('HTTP 429'))).toBe(true);
    expect(isTransientError(new Error('HTTP 503'))).toBe(true);
    expect(isTransientError(new Error('HTTP 502'))).toBe(true);
    expect(isTransientError(new Error('HTTP 504'))).toBe(true);
  });

  it('returns true for service-unavailable messages', () => {
    expect(isTransientError(new Error('Service Unavailable'))).toBe(true);
    expect(isTransientError(new Error('Too Many Requests'))).toBe(true);
  });

  it('returns false for non-transient errors', () => {
    expect(isTransientError(new Error('Invalid API key'))).toBe(false);
    expect(isTransientError(new Error('Not found'))).toBe(false);
    expect(isTransientError(new Error('Forbidden'))).toBe(false);
  });

  it('returns false for non-Error objects', () => {
    expect(isTransientError('string error')).toBe(false);
    expect(isTransientError(42)).toBe(false);
    expect(isTransientError(null)).toBe(false);
    expect(isTransientError(undefined)).toBe(false);
  });

  it('matches case-insensitively', () => {
    expect(isTransientError(new Error('TIMEOUT'))).toBe(true);
    expect(isTransientError(new Error('Connection REFUSED'))).toBe(true);
    expect(isTransientError(new Error('Too Many Requests'))).toBe(true);
  });
});

describe('withRetry', () => {
  it('returns the result on first success', async () => {
    const result = await withRetry(async () => 42);
    expect(result).toBe(42);
  });

  it('retries on transient errors and succeeds', async () => {
    let calls = 0;
    const result = await withRetry(async () => {
      calls++;
      if (calls < 2) throw new Error('Connection timed out');
      return 'ok';
    });
    expect(result).toBe('ok');
    expect(calls).toBe(2);
  });

  it('throws immediately on non-transient errors', async () => {
    let calls = 0;
    await expect(
      withRetry(async () => {
        calls++;
        throw new Error('Invalid API key');
      }),
    ).rejects.toThrow('Invalid API key');
    expect(calls).toBe(1);
  });

  it('throws immediately on SearchCircuitOpenError', async () => {
    let calls = 0;
    await expect(
      withRetry(async () => {
        calls++;
        throw new SearchCircuitOpenError('circuit open', 'test-provider', 1_000);
      }),
    ).rejects.toThrow(SearchCircuitOpenError);
    expect(calls).toBe(1);
  });

  it('throws the last error after exhausting retries', async () => {
    let calls = 0;
    await expect(
      withRetry(
        async () => {
          calls++;
          throw new Error(`timeout ${calls}`);
        },
        { maxRetries: 2, baseDelayMs: 1 },
      ),
    ).rejects.toThrow('timeout 3');
    expect(calls).toBe(3); // initial + 2 retries
  });

  it('respects custom maxRetries', async () => {
    let calls = 0;
    await expect(
      withRetry(
        async () => {
          calls++;
          throw new Error('ECONNREFUSED');
        },
        { maxRetries: 4, baseDelayMs: 1 },
      ),
    ).rejects.toThrow('ECONNREFUSED');
    expect(calls).toBe(5); // initial + 4 retries
  });

  it('stops retrying when a transient error is followed by a non-transient one', async () => {
    let calls = 0;
    await expect(
      withRetry(
        async () => {
          calls++;
          if (calls === 1) throw new Error('timeout');
          throw new Error('Invalid API key');
        },
        { baseDelayMs: 1 },
      ),
    ).rejects.toThrow('Invalid API key');
    expect(calls).toBe(2);
  });

  it('uses default retry options when none provided', async () => {
    let calls = 0;
    await expect(
      withRetry(async () => {
        calls++;
        throw new Error('ECONNREFUSED');
      }),
    ).rejects.toThrow('ECONNREFUSED');
    // Default maxRetries is 2: initial + 2 retries = 3 total
    expect(calls).toBe(3);
  });
});
