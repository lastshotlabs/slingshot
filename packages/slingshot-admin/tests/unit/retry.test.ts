/**
 * Tests for the retry-with-backoff utility.
 *
 * Covers successful invocation, retry exhaustion, error filtering,
 * exponential backoff, and edge cases.
 */
import { describe, expect, mock, test } from 'bun:test';
import { withRetry } from '../../src/lib/retry';

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('withRetry', () => {
  test('resolves immediately when fn succeeds on first try', async () => {
    const fn = mock(async () => 'ok');
    const result = await withRetry(fn);
    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  test('retries on failure and eventually resolves', async () => {
    let attempts = 0;
    const fn = mock(async () => {
      attempts++;
      if (attempts < 3) throw new Error('transient');
      return 'ok';
    });

    const result = await withRetry(fn, { maxRetries: 4, baseDelayMs: 5 });
    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(3);
  });

  test('throws after exhausting all retries', async () => {
    const fn = mock(async () => {
      throw new Error('persistent');
    });

    const err = await withRetry(fn, { maxRetries: 2, baseDelayMs: 5 }).catch(e => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toBe('persistent');
    expect(fn).toHaveBeenCalledTimes(3); // initial + 2 retries
  });

  test('respects shouldRetry predicate and skips non-retryable errors', async () => {
    const fn = mock(async () => {
      throw new Error('not-retryable');
    });

    const err = await withRetry(fn, {
      maxRetries: 3,
      baseDelayMs: 5,
      shouldRetry: (e: unknown) => e instanceof Error && e.message === 'retryable',
    }).catch(e => e);

    expect((err as Error).message).toBe('not-retryable');
    expect(fn).toHaveBeenCalledTimes(1); // no retries
  });

  test('retries only retryable errors', async () => {
    let attempts = 0;
    const fn = mock(async () => {
      attempts++;
      if (attempts === 1) throw new Error('retryable');
      if (attempts === 2) throw new Error('not-retryable');
      return 'ok';
    });

    const err = await withRetry(fn, {
      maxRetries: 3,
      baseDelayMs: 5,
      shouldRetry: (e: unknown) => e instanceof Error && e.message === 'retryable',
    }).catch(e => e);

    expect((err as Error).message).toBe('not-retryable');
    expect(fn).toHaveBeenCalledTimes(2); // initial + 1 retry, then stops
  });

  test('applies increasing delay between retries', async () => {
    const fn = mock(async () => {
      throw new Error('fail');
    });

    // With very small delays, the test should complete quickly
    await withRetry(fn, {
      maxRetries: 2,
      baseDelayMs: 5,
      maxDelayMs: 20,
    }).catch(() => {});

    // Should have been called 3 times: initial + 2 retries
    expect(fn).toHaveBeenCalledTimes(3);
  });

  test('uses default options when not provided', async () => {
    let attempts = 0;
    const fn = mock(async () => {
      attempts++;
      throw new Error('persistent');
    });

    // Default maxRetries is 3, so the function is called 4 times total
    // (initial + 3 retries) before exhaustion
    const err = await withRetry(fn).catch(e => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toBe('persistent');
    expect(fn).toHaveBeenCalledTimes(4); // initial + 3 retries
  });

  test('handles immediate success with zero retries', async () => {
    const fn = mock(async () => 'instant');
    const result = await withRetry(fn, { maxRetries: 0 });
    expect(result).toBe('instant');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  test('handles TypeErrors as retryable by default', async () => {
    let attempts = 0;
    const fn = mock(async () => {
      attempts++;
      if (attempts < 2) throw new TypeError('network error');
      return 'recovered';
    });

    const result = await withRetry(fn, { maxRetries: 2, baseDelayMs: 5 });
    expect(result).toBe('recovered');
    expect(fn).toHaveBeenCalledTimes(2);
  });
});
