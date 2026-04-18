import type { StoreInfra } from '@lastshotlabs/slingshot-core';
import {
  banFactories,
  containerFactories,
  containerMemberFactories,
  containerRuleFactories,
  reactionFactories,
  replyFactories,
  reportFactories,
  threadFactories,
} from './entities/factories';

/**
 * Create entity adapters for all eight community entities backed by in-memory
 * stores.
 *
 * Intended for unit and integration tests only. No persistence, no search
 * sync, and no infrastructure required — a stub `StoreInfra` is used
 * internally.
 *
 * @returns An object containing one adapter per entity plus a `clear()` method
 *   that resets all stores between tests.
 *
 * @remarks
 * The returned adapters satisfy the same interface as their production
 * counterparts so they can be passed to middleware helpers or route handlers
 * under test without modification.
 *
 * `clear()` calls the underlying in-memory adapter's `clear()` method which
 * removes all records from every store.
 *
 * @example
 * ```ts
 * import { createCommunityTestAdapters } from '@lastshotlabs/slingshot-community/testing';
 *
 * const adapters = createCommunityTestAdapters();
 *
 * afterEach(async () => {
 *   await adapters.clear();
 * });
 *
 * test('creates a container', async () => {
 *   const container = await adapters.containers.create({
 *     slug: 'general',
 *     name: 'General',
 *     createdBy: 'user-1',
 *   });
 *   expect(container.slug).toBe('general');
 * });
 * ```
 */
export function createCommunityTestAdapters() {
  // Memory adapters don't use infra -- the StoreInfra param is only consumed
  // by search-sync registration which bails out when symbols are absent.
  const stub = {} as unknown as StoreInfra;

  const adapters = {
    containers: containerFactories.memory(stub),
    threads: threadFactories.memory(stub),
    replies: replyFactories.memory(stub),
    reactions: reactionFactories.memory(stub),
    members: containerMemberFactories.memory(stub),
    rules: containerRuleFactories.memory(stub),
    reports: reportFactories.memory(stub),
    bans: banFactories.memory(stub),
  };

  return Object.assign(adapters, {
    async clear(): Promise<void> {
      const promises = Object.values(adapters)
        .map(a => (a as { clear?(): Promise<void> }).clear?.())
        .filter((p): p is Promise<void> => p != null);
      await Promise.all(promises);
    },
  });
}
