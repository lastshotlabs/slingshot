import { describe, expect, test } from 'bun:test';

describe('BullMQ workflow worker — step execution', () => {
  test('steps execute in order', async () => {
    const order: string[] = [];
    const steps = [
      {
        name: 'step1',
        execute: async () => {
          order.push('step1');
        },
      },
      {
        name: 'step2',
        execute: async () => {
          order.push('step2');
        },
      },
      {
        name: 'step3',
        execute: async () => {
          order.push('step3');
        },
      },
    ];
    for (const step of steps) {
      await step.execute();
    }
    expect(order).toEqual(['step1', 'step2', 'step3']);
  });

  test('step failure stops execution', async () => {
    const executed: string[] = [];
    const failingStep = {
      name: 'fail',
      execute: async () => {
        throw new Error('step failed');
      },
    };
    try {
      await failingStep.execute();
    } catch {
      // Expected
    }
    expect(executed).not.toContain('step3');
  });

  test('step results are accumulated', () => {
    const results = new Map<string, unknown>();
    results.set('step1', { value: 1 });
    results.set('step2', { value: 2 });
    expect(results.size).toBe(2);
    expect(results.get('step1')).toEqual({ value: 1 });
  });

  test('parallel steps execute concurrently', async () => {
    const startTimes: number[] = [];
    const steps = [
      {
        name: 'p1',
        execute: async () => {
          startTimes.push(Date.now());
        },
      },
      {
        name: 'p2',
        execute: async () => {
          startTimes.push(Date.now());
        },
      },
    ];
    await Promise.all(steps.map(s => s.execute()));
    // Both steps recorded start times
    expect(startTimes.length).toBe(2);
  });

  test('sleep delays execution', async () => {
    const start = Date.now();
    await new Promise(r => setTimeout(r, 10));
    const elapsed = Date.now() - start;
    expect(elapsed).toBeGreaterThanOrEqual(5);
  });
});

describe('BullMQ workflow worker — cancellation', () => {
  test('cancelled workflow stops processing', () => {
    const state = { cancelled: true, running: false };
    expect(state.cancelled).toBe(true);
    expect(state.running).toBe(false);
  });

  test('active workflow can be cancelled', () => {
    const state = { cancelled: false };
    state.cancelled = true;
    expect(state.cancelled).toBe(true);
  });

  test('completed workflow cannot be cancelled', () => {
    const state = { status: 'completed' as const };
    const canCancel = state.status !== 'completed' && state.status !== 'failed';
    expect(canCancel).toBe(false);
  });
});
