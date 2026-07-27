/**
 * A game app must BOOT on a real store, not just on memory.
 *
 * `assertEntityBackendRequirements` (shipped in v1.0.0) rejects an entity whose
 * operations include an `op.custom` with no factory for the active store. Both
 * game-engine entities have exactly such an escape hatch — GameSession's
 * `updateContent` and GamePlayer's `kick` — each carrying a `memory` factory
 * and nothing else.
 *
 * GamePlayer was migrated to exclude `kick` from its strict factory. GameSession
 * was not, so the FULL operation set (including `updateContent`) went into
 * `createEntityFactories` / `resolveStandardAdapter`, and the check rejected the
 * whole entity the moment a game app resolved a non-memory adapter:
 *
 *   UnsupportedEntityBackendError: Entity "GameSession" cannot use store "sqlite".
 *   - operation.custom (required by operation: updateContent)
 *
 * That is an app-BOOT failure, not a degraded operation, and it fired over an
 * operation nothing in the repo or in any consuming app calls. It took down
 * every game persisting to SQLite — which is how these apps run in production,
 * so matches survive a restart. Only two of trivia's 225 tests went red, purely
 * because every other test runs on the memory store.
 *
 * These tests pin the boot on every standard store, for both entities.
 */
import { describe, expect, test } from 'bun:test';
import type { StoreInfra } from '@lastshotlabs/slingshot-core';
import { UnsupportedEntityBackendError } from '@lastshotlabs/slingshot-entity';
import { gamePlayerFactories, gameSessionFactories } from '../../src/entities/factories';

/**
 * Infra whose every getter throws. The capability check runs BEFORE adapter
 * construction, so a rejected store throws `UnsupportedEntityBackendError` and
 * never reaches these; a store that passes the check throws the sentinel below
 * instead. That difference is the assertion.
 */
const SENTINEL = 'backend infrastructure reached';

const unreachableInfra = {
  appName: 'test',
  getTransactions: () => {
    throw new Error(SENTINEL);
  },
  getRedis: () => {
    throw new Error(SENTINEL);
  },
  getMongo: () => {
    throw new Error(SENTINEL);
  },
  getSqliteDb: () => {
    throw new Error(SENTINEL);
  },
  getPostgres: () => {
    throw new Error(SENTINEL);
  },
} as unknown as StoreInfra;

const STORES = ['sqlite', 'postgres', 'mongo'] as const;

describe('game-engine entities boot on a real store', () => {
  for (const store of STORES) {
    test(`GameSession resolves past the capability check on ${store}`, () => {
      // Getting as far as the infra is a PASS: it means the entity was accepted
      // and adapter construction began. Only the capability rejection is a fail.
      expect(() => gameSessionFactories[store](unreachableInfra)).toThrow(SENTINEL);
      expect(() => gameSessionFactories[store](unreachableInfra)).not.toThrow(
        UnsupportedEntityBackendError,
      );
    });

    test(`GamePlayer resolves past the capability check on ${store}`, () => {
      expect(() => gamePlayerFactories[store](unreachableInfra)).toThrow(SENTINEL);
      expect(() => gamePlayerFactories[store](unreachableInfra)).not.toThrow(
        UnsupportedEntityBackendError,
      );
    });
  }

  test('memory — the store that always worked — still does', () => {
    expect(() => gameSessionFactories.memory()).not.toThrow();
    expect(() => gamePlayerFactories.memory()).not.toThrow();
  });
});
