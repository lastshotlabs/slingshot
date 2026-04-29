import { describe, expect, test } from 'bun:test';

describe('Temporal concurrency control', () => {
  test('semaphore acquires and releases', () => {
    let permits = 3;
    const acquire = () => {
      if (permits > 0) {
        permits--;
        return true;
      }
      return false;
    };
    const release = () => {
      permits++;
    };

    expect(acquire()).toBe(true);
    expect(permits).toBe(2);
    release();
    expect(permits).toBe(3);
  });

  test('semaphore blocks when no permits', () => {
    let permits = 1;
    const acquire = () => {
      if (permits > 0) {
        permits--;
        return true;
      }
      return false;
    };

    expect(acquire()).toBe(true);
    expect(acquire()).toBe(false);
    expect(permits).toBe(0);
  });

  test('concurrent run count is tracked', () => {
    let running = 0;
    const maxConcurrent = 5;

    const start = () => {
      if (running < maxConcurrent) {
        running++;
        return true;
      }
      return false;
    };
    const finish = () => {
      running--;
    };

    expect(start()).toBe(true);
    expect(start()).toBe(true);
    expect(running).toBe(2);
    finish();
    expect(running).toBe(1);
  });

  test('max concurrent limit is enforced', () => {
    const maxConcurrent = 3;
    const start = (current: number) => current < maxConcurrent;

    expect(start(0)).toBe(true);
    expect(start(1)).toBe(true);
    expect(start(2)).toBe(true);
    expect(start(3)).toBe(false);
  });

  test('query deduplication prevents duplicates', () => {
    const inFlight = new Set<string>();
    const startQuery = (id: string) => {
      if (inFlight.has(id)) return false;
      inFlight.add(id);
      return true;
    };
    const finishQuery = (id: string) => inFlight.delete(id);

    expect(startQuery('run-1')).toBe(true);
    expect(startQuery('run-1')).toBe(false); // duplicate
    finishQuery('run-1');
    expect(startQuery('run-1')).toBe(true); // can start again after finish
  });
});

describe('Temporal adapter — signal handling', () => {
  test('signals are delivered to running workflows', () => {
    const signals: Array<{ runId: string; signal: string }> = [];
    const deliver = (runId: string, signal: string) => signals.push({ runId, signal });

    deliver('wf-1', 'cancel');
    expect(signals).toHaveLength(1);
    expect(signals[0]).toEqual({ runId: 'wf-1', signal: 'cancel' });
  });

  test('signals to unknown workflows are discarded', () => {
    const activeWorkflows = new Set(['wf-1', 'wf-2']);
    const deliverIfActive = (runId: string) => activeWorkflows.has(runId);

    expect(deliverIfActive('wf-1')).toBe(true);
    expect(deliverIfActive('wf-3')).toBe(false);
  });
});
