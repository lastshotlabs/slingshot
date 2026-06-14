/**
 * createApp seed phase — verifies the framework actually calls each
 * plugin's/package's seed() hook when CreateAppConfig.seed is set, and
 * threads seedInput / seedState through correctly.
 */
import { describe, expect, test } from 'bun:test';
import type { PluginSeedContext, SlingshotPlugin } from '@lastshotlabs/slingshot-core';
import { createTestApp } from '../setup';

function recordingSeedPlugin(
  name: string,
  ownKey: string,
  observed: {
    invocations: number;
    lastSeedInput?: Record<string, unknown>;
    lastState?: Map<string, unknown>;
  },
): SlingshotPlugin {
  return {
    name,
    async seed({ seedInput, seedState }: PluginSeedContext) {
      observed.invocations += 1;
      observed.lastSeedInput = seedInput;
      observed.lastState = seedState;
      const value = seedInput[ownKey];
      if (value !== undefined) {
        seedState.set(`${name}:${ownKey}`, value);
      }
    },
  };
}

describe('createApp seed phase', () => {
  test('seed() hooks are not invoked when config.seed is omitted', async () => {
    const observed = { invocations: 0 };
    await createTestApp({
      plugins: [recordingSeedPlugin('test-seeder', 'rows', observed)],
    });
    expect(observed.invocations).toBe(0);
  });

  test('seed() hooks are invoked exactly once when config.seed is provided', async () => {
    const observed = { invocations: 0 };
    await createTestApp({
      plugins: [recordingSeedPlugin('test-seeder', 'rows', observed)],
      seed: { rows: [{ id: 1 }, { id: 2 }] },
    } as never);
    expect(observed.invocations).toBe(1);
    expect(observed.lastSeedInput).toEqual({ rows: [{ id: 1 }, { id: 2 }] });
  });

  test('seedState is shared across plugins and survives across hooks', async () => {
    const aObserved = { invocations: 0 };
    const bObserved = { invocations: 0 };
    const a = recordingSeedPlugin('seeder-a', 'foo', aObserved);
    const b: SlingshotPlugin = {
      name: 'seeder-b',
      dependencies: ['seeder-a'],
      async seed({ seedState }: PluginSeedContext) {
        bObserved.invocations += 1;
        // Confirm A's write is visible to B.
        bObserved.lastState = seedState;
      },
    };
    await createTestApp({
      plugins: [a, b],
      seed: { foo: 'bar' },
    } as never);
    expect(aObserved.invocations).toBe(1);
    expect(bObserved.invocations).toBe(1);
    expect(bObserved.lastState?.get('seeder-a:foo')).toBe('bar');
  });
});
