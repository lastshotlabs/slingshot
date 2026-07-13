/**
 * The retry layer.
 *
 * One layer, over whatever the SDK already does. The behavior that matters is
 * `onAttempt` firing before EVERY attempt — that is the hook the orchestrator
 * uses to re-check the spend guard, and it is what stops a retry storm from
 * being an unbounded bill.
 */
import { describe, expect, test } from 'bun:test';
import { AiProviderError, AiRateLimitError } from '../../src/errors';
import { withRetry } from '../../src/lib/retry';

const noSleep = async (): Promise<void> => {};

describe('withRetry', () => {
  test('returns the first success without retrying', async () => {
    let calls = 0;
    const result = await withRetry(
      async () => {
        calls++;
        return 'ok';
      },
      { maxAttempts: 3, sleep: noSleep },
    );

    expect(result).toBe('ok');
    expect(calls).toBe(1);
  });

  test('retries a retryable provider error and succeeds', async () => {
    let calls = 0;
    const result = await withRetry(
      async () => {
        calls++;
        if (calls < 3) {
          throw new AiProviderError('upstream hiccup', { retryable: true, providerKind: 'fake' });
        }
        return 'ok';
      },
      { maxAttempts: 3, sleep: noSleep },
    );

    expect(result).toBe('ok');
    expect(calls).toBe(3);
  });

  test('does NOT retry a non-retryable error', async () => {
    // A 400 is not going to become a 200 because we asked again. Retrying it
    // just spends money and latency to fail the same way.
    let calls = 0;
    const attempt = withRetry(
      async () => {
        calls++;
        throw new AiProviderError('bad request', {
          retryable: false,
          status: 400,
          providerKind: 'fake',
        });
      },
      { maxAttempts: 3, sleep: noSleep },
    );

    await expect(attempt).rejects.toThrow('bad request');
    expect(calls).toBe(1);
  });

  test('honors an explicit retryAfterMs from a rate-limit error', async () => {
    const slept: number[] = [];
    let calls = 0;

    await withRetry(
      async () => {
        calls++;
        if (calls === 1) {
          throw new AiRateLimitError('slow down', { retryAfterMs: 1234, providerKind: 'fake' });
        }
        return 'ok';
      },
      {
        maxAttempts: 3,
        sleep: async (ms: number) => {
          slept.push(ms);
        },
      },
    );

    // The provider TOLD us when to come back. Backing off on our own schedule
    // instead just gets us rate-limited again.
    expect(slept).toEqual([1234]);
  });

  test('gives up after maxAttempts and rethrows the last error', async () => {
    let calls = 0;
    const attempt = withRetry(
      async () => {
        calls++;
        throw new AiRateLimitError('still limited', { providerKind: 'fake' });
      },
      { maxAttempts: 3, sleep: noSleep },
    );

    await expect(attempt).rejects.toThrow('still limited');
    expect(calls).toBe(3);
  });

  test('fires onAttempt before EVERY attempt, including the first', async () => {
    // THE invariant. If a retry could skip this hook, a retry storm would run
    // straight past the spend limit.
    const attempts: number[] = [];
    let calls = 0;

    await withRetry(
      async () => {
        calls++;
        if (calls < 3) throw new AiRateLimitError('limited', { providerKind: 'fake' });
        return 'ok';
      },
      {
        maxAttempts: 3,
        sleep: noSleep,
        onAttempt: attempt => {
          attempts.push(attempt);
        },
      },
    );

    expect(attempts).toEqual([1, 2, 3]);
  });

  test('an onAttempt that throws aborts immediately — the call is never made', async () => {
    // This is how the spend guard cuts off a retry loop: it throws from
    // onAttempt, and no further HTTP request happens.
    let calls = 0;

    const attempt = withRetry(
      async () => {
        calls++;
        return 'ok';
      },
      {
        maxAttempts: 3,
        sleep: noSleep,
        onAttempt: () => {
          throw new Error('spend limit reached');
        },
      },
    );

    await expect(attempt).rejects.toThrow('spend limit reached');
    expect(calls).toBe(0);
  });
});
