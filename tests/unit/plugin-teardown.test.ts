import { describe, expect, mock, test } from 'bun:test';
import type { SlingshotPlugin } from '@lastshotlabs/slingshot-core';
import { runPluginTeardown } from '../../src/framework/runPluginLifecycle';

// ---------------------------------------------------------------------------
// runPluginTeardown — reverse order, error isolation, AggregateError
// ---------------------------------------------------------------------------

describe('runPluginTeardown', () => {
  test('calls teardown on every plugin', async () => {
    const t1 = mock(() => Promise.resolve());
    const t2 = mock(() => Promise.resolve());
    const plugins: SlingshotPlugin[] = [
      { name: 'a', setupPost: async () => {}, teardown: t1 },
      { name: 'b', setupPost: async () => {}, teardown: t2 },
    ];
    await runPluginTeardown(plugins);
    expect(t1).toHaveBeenCalledTimes(1);
    expect(t2).toHaveBeenCalledTimes(1);
  });

  test('calls teardown in reverse order', async () => {
    const order: string[] = [];
    const plugins: SlingshotPlugin[] = [
      {
        name: 'first',
        setupPost: async () => {},
        teardown: async () => {
          order.push('first');
        },
      },
      {
        name: 'second',
        setupPost: async () => {},
        teardown: async () => {
          order.push('second');
        },
      },
      {
        name: 'third',
        setupPost: async () => {},
        teardown: async () => {
          order.push('third');
        },
      },
    ];
    await runPluginTeardown(plugins);
    expect(order).toEqual(['third', 'second', 'first']);
  });

  test('runs all teardowns even when one throws', async () => {
    const t1 = mock(() => Promise.reject(new Error('teardown-a failed')));
    const t2 = mock(() => Promise.resolve());
    const t3 = mock(() => Promise.reject(new Error('teardown-c failed')));
    const plugins: SlingshotPlugin[] = [
      { name: 'a', setupPost: async () => {}, teardown: t1 },
      { name: 'b', setupPost: async () => {}, teardown: t2 },
      { name: 'c', setupPost: async () => {}, teardown: t3 },
    ];
    await expect(runPluginTeardown(plugins)).rejects.toBeInstanceOf(AggregateError);
    // All three must have been called despite failures
    expect(t1).toHaveBeenCalledTimes(1);
    expect(t2).toHaveBeenCalledTimes(1);
    expect(t3).toHaveBeenCalledTimes(1);
  });

  test('throws AggregateError containing all failure messages', async () => {
    const plugins: SlingshotPlugin[] = [
      {
        name: 'a',
        setupPost: async () => {},
        teardown: async () => {
          throw new Error('err-a');
        },
      },
      {
        name: 'b',
        setupPost: async () => {},
        teardown: async () => {
          throw new Error('err-b');
        },
      },
    ];
    let caught: unknown;
    try {
      await runPluginTeardown(plugins);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(AggregateError);
    const agg = caught as AggregateError;
    expect(agg.errors).toHaveLength(2);
    expect(agg.message).toContain('2 plugin teardown(s) failed');
    const messages = agg.errors.map((e: Error) => e.message);
    expect(messages).toContain('err-a');
    expect(messages).toContain('err-b');
  });

  test('wraps non-Error throws in Error', async () => {
    const plugins: SlingshotPlugin[] = [
      {
        name: 'a',
        setupPost: async () => {},
        teardown: async () => {
          throw 'string error';
        },
      },
    ];
    let caught: unknown;
    try {
      await runPluginTeardown(plugins);
    } catch (err) {
      caught = err;
    }
    const agg = caught as AggregateError;
    expect(agg.errors[0]).toBeInstanceOf(Error);
    expect((agg.errors[0] as Error).message).toBe('string error');
  });

  test('does not throw when no plugins have teardown', async () => {
    const plugins: SlingshotPlugin[] = [
      { name: 'a', setupPost: async () => {} },
      { name: 'b', setupRoutes: async () => {} },
    ];
    await expect(runPluginTeardown(plugins)).resolves.toBeUndefined();
  });

  test('does not throw when plugins array is empty', async () => {
    await expect(runPluginTeardown([])).resolves.toBeUndefined();
  });

  test('succeeding teardowns after a failing one still run', async () => {
    const order: string[] = [];
    const plugins: SlingshotPlugin[] = [
      {
        name: 'first',
        setupPost: async () => {},
        teardown: async () => {
          order.push('first');
        },
      },
      {
        name: 'second',
        setupPost: async () => {},
        teardown: async () => {
          throw new Error('middle fails');
        },
      },
      {
        name: 'third',
        setupPost: async () => {},
        teardown: async () => {
          order.push('third');
        },
      },
    ];
    await expect(runPluginTeardown(plugins)).rejects.toBeInstanceOf(AggregateError);
    // toReversed() → ['third', 'second', 'first']; first and third succeed
    expect(order).toContain('first');
    expect(order).toContain('third');
  });
});
