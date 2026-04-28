import { describe, expect, test } from 'bun:test';
import { TimeoutError, timeoutSignal, withTimeout } from '../../src/concurrency/withTimeout';

describe('withTimeout', () => {
  test('passes through resolved value when promise settles before timeout', async () => {
    const result = await withTimeout(Promise.resolve(42), 1000, 'fast');
    expect(result).toBe(42);
  });

  test('passes through original rejection when promise rejects before timeout', async () => {
    const original = new Error('boom');
    await expect(withTimeout(Promise.reject(original), 1000, 'fast')).rejects.toBe(original);
  });

  test('rejects with TimeoutError when deadline elapses', async () => {
    const never = new Promise<number>(() => {});
    let caught: unknown;
    try {
      await withTimeout(never, 20, 'slow-op');
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(TimeoutError);
    expect((caught as TimeoutError).timeoutMs).toBe(20);
    expect((caught as TimeoutError).label).toBe('slow-op');
    expect((caught as TimeoutError).message).toContain('slow-op');
  });

  test('clears the timer on early settle so no late rejection arrives', async () => {
    let lateRejection: unknown = null;
    const promise = withTimeout(Promise.resolve('ok'), 30, 'early').catch(err => {
      lateRejection = err;
    });
    const value = await promise;
    expect(value).toBe('ok');
    await new Promise(resolve => setTimeout(resolve, 60));
    expect(lateRejection).toBeNull();
  });

  test('clears the timer on early rejection so timeout cannot replace original error', async () => {
    const original = new Error('original');
    const trail: unknown[] = [];
    const promise = withTimeout(Promise.reject(original), 30, 'early-rej').catch(err => {
      trail.push(err);
    });
    await promise;
    await new Promise(resolve => setTimeout(resolve, 60));
    expect(trail).toEqual([original]);
  });
});

describe('timeoutSignal', () => {
  test('returns an AbortSignal that is not yet aborted', () => {
    const signal = timeoutSignal(1000);
    expect(signal.aborted).toBe(false);
  });

  test('aborts after timeout elapses', async () => {
    const signal = timeoutSignal(20);
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(signal.aborted).toBe(true);
  });
});
