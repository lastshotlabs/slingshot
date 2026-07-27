import { describe, expect, test } from 'bun:test';
import { ENTITY_BACKEND_PROFILES } from '../../src/configDriven/backendProfiles';
import type {
  EntityConformanceCase,
  EntityConformanceDriver,
  EntityConformanceHarness,
} from '../../src/testing';
import { runEntityConformance } from '../../src/testing';

function harness(onDestroy: () => void): EntityConformanceHarness {
  return {
    adapter() {
      throw new Error('Adapter is not used by runner unit cases');
    },
    composite() {
      throw new Error('Composite is not used by runner unit cases');
    },
    reset: async () => {},
    destroy: async () => onDestroy(),
  };
}

describe('runEntityConformance', () => {
  test('records pass, profile skip, and sanitized failure while destroying once', async () => {
    let destroys = 0;
    let skippedRan = false;
    const driver: EntityConformanceDriver = {
      name: 'memory',
      profile: ENTITY_BACKEND_PROFILES.memory,
      createHarness: async () => harness(() => destroys++),
    };
    const cases: readonly EntityConformanceCase[] = [
      {
        id: 'runner.pass',
        description: 'passes',
        requires: ['crud.read'],
        run: async () => {},
      },
      {
        id: 'runner.skip',
        description: 'skips',
        requires: ['transaction.rollback'],
        run: async () => {
          skippedRan = true;
        },
      },
      {
        id: 'runner.fail',
        description: 'fails',
        requires: ['crud.read'],
        run: async () => {
          throw new TypeError('selected failure');
        },
      },
    ];

    const results = await runEntityConformance(driver, cases);

    expect(results.map(result => result.status)).toEqual(['passed', 'skipped', 'failed']);
    expect(results[1]).toMatchObject({
      durationMs: 0,
      reason: expect.stringContaining('transaction.rollback'),
    });
    expect(results[2]).toMatchObject({
      error: { name: 'TypeError', message: 'selected failure' },
    });
    expect(results[2]?.error).not.toHaveProperty('stack');
    expect(skippedRan).toBe(false);
    expect(destroys).toBe(1);
    expect(Object.isFrozen(results)).toBe(true);
    expect(Object.isFrozen(results[2]?.error)).toBe(true);
  });

  test('captures reset failure, continues, and still destroys', async () => {
    let resets = 0;
    let destroys = 0;
    const driver: EntityConformanceDriver = {
      name: 'memory',
      profile: ENTITY_BACKEND_PROFILES.memory,
      async createHarness() {
        return {
          ...harness(() => destroys++),
          async reset() {
            resets++;
            if (resets === 1) throw new Error('reset failed');
          },
        };
      },
    };
    const cases: readonly EntityConformanceCase[] = [
      {
        id: 'runner.reset-failure',
        description: 'captures reset',
        requires: ['crud.read'],
        run: async () => {},
      },
      {
        id: 'runner.continues',
        description: 'continues',
        requires: ['crud.read'],
        run: async () => {},
      },
    ];

    const results = await runEntityConformance(driver, cases);
    expect(results.map(result => result.status)).toEqual(['failed', 'passed']);
    expect(results[0]?.error?.message).toBe('reset failed');
    expect(resets).toBe(2);
    expect(destroys).toBe(1);
  });
});
