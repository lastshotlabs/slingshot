import { describe, expect, test } from 'bun:test';
import { withTaskConcurrency } from '../src/concurrency';

// ---------------------------------------------------------------------------
// Concurrency semaphore tests
// ---------------------------------------------------------------------------

describe('withTaskConcurrency', () => {
  test('with limit = undefined, runs fn immediately without queuing', async () => {
    let active = 0;
    let maxConcurrent = 0;

    const tasks = Array.from({ length: 5 }, (_, i) =>
      withTaskConcurrency(`unlimited-task`, undefined, async () => {
        active += 1;
        maxConcurrent = Math.max(maxConcurrent, active);
        await new Promise(resolve => setTimeout(resolve, 10));
        active -= 1;
        return i;
      }),
    );

    await Promise.all(tasks);
    // All 5 should have run concurrently since there's no limit
    expect(maxConcurrent).toBe(5);
  });

  test('with limit = 0, runs fn immediately (treated as unlimited)', async () => {
    let active = 0;
    let maxConcurrent = 0;

    const tasks = Array.from({ length: 5 }, (_, i) =>
      withTaskConcurrency(`zero-limit-task`, 0, async () => {
        active += 1;
        maxConcurrent = Math.max(maxConcurrent, active);
        await new Promise(resolve => setTimeout(resolve, 10));
        active -= 1;
        return i;
      }),
    );

    await Promise.all(tasks);
    expect(maxConcurrent).toBe(5);
  });

  test('with limit = 2, at most 2 tasks run simultaneously', async () => {
    let active = 0;
    let maxConcurrent = 0;
    const completed: number[] = [];

    const tasks = Array.from({ length: 5 }, (_, i) =>
      withTaskConcurrency(`limited-task`, 2, async () => {
        active += 1;
        maxConcurrent = Math.max(maxConcurrent, active);
        await new Promise(resolve => setTimeout(resolve, 20));
        active -= 1;
        completed.push(i);
        return i;
      }),
    );

    const results = await Promise.all(tasks);

    expect(maxConcurrent).toBeLessThanOrEqual(2);
    expect(results).toHaveLength(5);
    expect(completed).toHaveLength(5);
  });

  test('after one completes, the next queued task starts immediately', async () => {
    const startTimes: number[] = [];
    const endTimes: number[] = [];

    // Fire 3 tasks with limit=1 so they must serialize
    const tasks = Array.from({ length: 3 }, (_, i) =>
      withTaskConcurrency(`serial-task`, 1, async () => {
        startTimes.push(Date.now());
        await new Promise(resolve => setTimeout(resolve, 20));
        endTimes.push(Date.now());
        return i;
      }),
    );

    await Promise.all(tasks);

    // Each task must start after the previous one ended
    for (let i = 1; i < startTimes.length; i += 1) {
      // Start of task[i] >= end of task[i-1] (allowing 5ms scheduling slack)
      expect(startTimes[i]!).toBeGreaterThanOrEqual(endTimes[i - 1]! - 5);
    }
  });

  test('with limit = 1, tasks run serially and return correct values', async () => {
    const results = await Promise.all(
      [10, 20, 30].map(v =>
        withTaskConcurrency('serial-return-task', 1, async () => {
          await new Promise(resolve => setTimeout(resolve, 5));
          return v * 2;
        }),
      ),
    );

    expect(results).toEqual([20, 40, 60]);
  });

  test('propagates errors from fn and still releases the semaphore slot', async () => {
    let completedAfterError = false;

    // Task 1 errors, task 2 should still run
    const [t1, t2] = [
      withTaskConcurrency('error-task', 1, async () => {
        await new Promise(resolve => setTimeout(resolve, 10));
        throw new Error('task 1 failed');
      }),
      withTaskConcurrency('error-task', 1, async () => {
        await new Promise(resolve => setTimeout(resolve, 10));
        completedAfterError = true;
        return 'ok';
      }),
    ];

    await expect(t1).rejects.toThrow('task 1 failed');
    await expect(t2).resolves.toBe('ok');
    expect(completedAfterError).toBe(true);
  });

  test('different task names maintain independent semaphores', async () => {
    let maxAlpha = 0;
    let maxBeta = 0;
    let activeAlpha = 0;
    let activeBeta = 0;

    const alphaTasks = Array.from({ length: 3 }, () =>
      withTaskConcurrency('alpha-task', 1, async () => {
        activeAlpha += 1;
        maxAlpha = Math.max(maxAlpha, activeAlpha);
        await new Promise(resolve => setTimeout(resolve, 15));
        activeAlpha -= 1;
      }),
    );

    const betaTasks = Array.from({ length: 3 }, () =>
      withTaskConcurrency('beta-task', 2, async () => {
        activeBeta += 1;
        maxBeta = Math.max(maxBeta, activeBeta);
        await new Promise(resolve => setTimeout(resolve, 15));
        activeBeta -= 1;
      }),
    );

    await Promise.all([...alphaTasks, ...betaTasks]);

    expect(maxAlpha).toBeLessThanOrEqual(1);
    expect(maxBeta).toBeLessThanOrEqual(2);
  });
});
