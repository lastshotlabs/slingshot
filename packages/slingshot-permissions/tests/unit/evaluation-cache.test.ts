import { beforeEach, describe, expect, test } from 'bun:test';
import type { ResourceTypeDefinition } from '@lastshotlabs/slingshot-core';
import { createMemoryPermissionsAdapter } from '../../src/adapters/memory';
import { createEvaluationCache } from '../../src/lib/evaluationCache';
import { createPermissionEvaluator } from '../../src/lib/evaluator';
import { createPermissionRegistry } from '../../src/lib/registry';

const postDef: ResourceTypeDefinition = {
  resourceType: 'post',
  actions: ['create', 'read', 'update', 'delete'],
  roles: {
    editor: ['create', 'update', 'read'],
    reader: ['read'],
    owner: ['create', 'read', 'update', 'delete'],
  },
};

describe('evaluationCache', () => {
  describe('createEvaluationCache', () => {
    test('throws when ttlMs is 0', () => {
      expect(() => createEvaluationCache({ ttlMs: 0 })).toThrow('must be a positive number');
    });

    test('throws when ttlMs is negative', () => {
      expect(() => createEvaluationCache({ ttlMs: -100 })).toThrow('must be a positive number');
    });

    test('returns undefined on cache miss', () => {
      const cache = createEvaluationCache();
      const result = cache.get('user-1', 'user', 'read', {
        tenantId: 't1',
        resourceType: 'post',
      });
      expect(result).toBeUndefined();
    });

    test('returns cached value on hit within TTL', () => {
      const cache = createEvaluationCache({ ttlMs: 5000 });
      cache.set('user-1', 'user', 'read', { tenantId: 't1', resourceType: 'post' }, true);

      const entry = cache.get('user-1', 'user', 'read', {
        tenantId: 't1',
        resourceType: 'post',
      });
      expect(entry).toBeDefined();
      expect(entry!.result).toBe(true);
      expect(entry!.cachedAt).toBeGreaterThan(0);
    });

    test('different keys do not collide', () => {
      const cache = createEvaluationCache();
      cache.set('user-1', 'user', 'read', { tenantId: 't1', resourceType: 'post' }, true);

      const miss = cache.get('user-2', 'user', 'read', {
        tenantId: 't1',
        resourceType: 'post',
      });
      expect(miss).toBeUndefined();
    });

    test('different actions produce different cache keys', () => {
      const cache = createEvaluationCache();
      cache.set('user-1', 'user', 'read', { tenantId: 't1', resourceType: 'post' }, true);

      const miss = cache.get('user-1', 'user', 'delete', {
        tenantId: 't1',
        resourceType: 'post',
      });
      expect(miss).toBeUndefined();
    });

    test('different scopes produce different cache keys', () => {
      const cache = createEvaluationCache();
      cache.set('user-1', 'user', 'read', { tenantId: 't1', resourceType: 'post' }, true);

      const miss = cache.get('user-1', 'user', 'read', {
        tenantId: 't2',
        resourceType: 'post',
      });
      expect(miss).toBeUndefined();
    });

    test('scope with only tenantId is keyed correctly', () => {
      const cache = createEvaluationCache();
      cache.set('user-1', 'user', 'read', { tenantId: 't1' }, true);

      const hit = cache.get('user-1', 'user', 'read', { tenantId: 't1' });
      expect(hit).toBeDefined();
      expect(hit!.result).toBe(true);
    });

    test('entry that exceeds TTL returns undefined', async () => {
      const cache = createEvaluationCache({ ttlMs: 10 });
      cache.set('user-1', 'user', 'read', { resourceType: 'post' }, true);

      // Wait for the TTL to expire
      await new Promise(r => setTimeout(r, 20));

      const entry = cache.get('user-1', 'user', 'read', { resourceType: 'post' });
      expect(entry).toBeUndefined();
    });

    test('invalidate clears all entries', () => {
      const cache = createEvaluationCache();
      cache.set('user-1', 'user', 'read', { resourceType: 'post' }, true);
      cache.set('user-2', 'user', 'write', { resourceType: 'post' }, false);

      cache.invalidate();

      expect(cache.get('user-1', 'user', 'read', { resourceType: 'post' })).toBeUndefined();
      expect(cache.get('user-2', 'user', 'write', { resourceType: 'post' })).toBeUndefined();
    });

    test('invalidateForActor clears only matching entries', () => {
      const cache = createEvaluationCache();
      cache.set('user-1', 'user', 'read', { resourceType: 'post' }, true);
      cache.set('user-1', 'user', 'write', { resourceType: 'post' }, false);
      cache.set('user-2', 'user', 'read', { resourceType: 'post' }, true);

      cache.invalidateForActor('user-1');

      // user-1 entries are gone
      expect(cache.get('user-1', 'user', 'read', { resourceType: 'post' })).toBeUndefined();
      expect(cache.get('user-1', 'user', 'write', { resourceType: 'post' })).toBeUndefined();
      // user-2 entry remains
      expect(cache.get('user-2', 'user', 'read', { resourceType: 'post' })).toBeDefined();
    });

    test('can set false result and retrieve it', () => {
      const cache = createEvaluationCache();
      cache.set('user-1', 'user', 'delete', { resourceType: 'post' }, false);

      const entry = cache.get('user-1', 'user', 'delete', {
        resourceType: 'post',
      });
      expect(entry).toBeDefined();
      expect(entry!.result).toBe(false);
    });
  });

  describe('integration with evaluator', () => {
    let adapter: ReturnType<typeof createMemoryPermissionsAdapter>;
    let registry: ReturnType<typeof createPermissionRegistry>;

    beforeEach(() => {
      adapter = createMemoryPermissionsAdapter();
      registry = createPermissionRegistry();
      registry.register(postDef);
    });

    test('cached true result is returned without hitting adapter', async () => {
      let adapterCalls = 0;
      const trackingAdapter = {
        ...adapter,
        async getEffectiveGrantsForSubject() {
          adapterCalls++;
          return adapter.getEffectiveGrantsForSubject(
            arguments[0] as string,
            arguments[1] as 'user' | 'group' | 'service-account',
          );
        },
      };

      const cache = createEvaluationCache({ ttlMs: 5000 });
      // Pre-seed the cache
      cache.set('user-1', 'user', 'read', { resourceType: 'post' }, true);

      const evaluator = createPermissionEvaluator({
        registry,
        adapter: trackingAdapter,
        cache,
      });

      const result = await evaluator.can({ subjectId: 'user-1', subjectType: 'user' }, 'read', {
        resourceType: 'post',
      });

      expect(result).toBe(true);
      // Should NOT have called the adapter for this check
      expect(adapterCalls).toBe(0);
    });

    test('cached false result is returned without hitting adapter', async () => {
      let adapterCalls = 0;
      const trackingAdapter = {
        ...adapter,
        async getEffectiveGrantsForSubject() {
          adapterCalls++;
          return adapter.getEffectiveGrantsForSubject(
            arguments[0] as string,
            arguments[1] as 'user' | 'group' | 'service-account',
          );
        },
      };

      const cache = createEvaluationCache({ ttlMs: 5000 });
      // Pre-seed the cache with false
      cache.set('user-1', 'user', 'delete', { resourceType: 'post' }, false);

      const evaluator = createPermissionEvaluator({
        registry,
        adapter: trackingAdapter,
        cache,
      });

      const result = await evaluator.can({ subjectId: 'user-1', subjectType: 'user' }, 'delete', {
        resourceType: 'post',
      });

      expect(result).toBe(false);
      expect(adapterCalls).toBe(0);
    });

    test('second can() call uses cached result from first call', async () => {
      let adapterCalls = 0;
      const trackingAdapter = {
        ...adapter,
        async createGrant(g: Parameters<typeof adapter.createGrant>[0]) {
          return adapter.createGrant(g);
        },
        async getEffectiveGrantsForSubject() {
          adapterCalls++;
          return adapter.getEffectiveGrantsForSubject(
            arguments[0] as string,
            arguments[1] as 'user' | 'group' | 'service-account',
          );
        },
      };

      const cache = createEvaluationCache({ ttlMs: 5000 });
      const evaluator = createPermissionEvaluator({
        registry,
        adapter: trackingAdapter,
        cache,
      });

      // First call — need at least one grant to pass
      await trackingAdapter.createGrant({
        subjectId: 'user-1',
        subjectType: 'user',
        tenantId: null,
        resourceType: null,
        resourceId: null,
        roles: ['editor'],
        effect: 'allow',
        grantedBy: 'system',
      });

      const first = await evaluator.can({ subjectId: 'user-1', subjectType: 'user' }, 'read', {
        resourceType: 'post',
      });
      expect(first).toBe(true);
      expect(adapterCalls).toBe(1);

      // Second call — should be cached
      const second = await evaluator.can({ subjectId: 'user-1', subjectType: 'user' }, 'read', {
        resourceType: 'post',
      });
      expect(second).toBe(true);
      // adapter calls should NOT have increased
      expect(adapterCalls).toBe(1);
    });

    test('invalidate busts cache so next call hits adapter', async () => {
      let adapterCalls = 0;
      const trackingAdapter = {
        ...adapter,
        async createGrant(g: Parameters<typeof adapter.createGrant>[0]) {
          return adapter.createGrant(g);
        },
        async getEffectiveGrantsForSubject() {
          adapterCalls++;
          return adapter.getEffectiveGrantsForSubject(
            arguments[0] as string,
            arguments[1] as 'user' | 'group' | 'service-account',
          );
        },
      };

      const cache = createEvaluationCache({ ttlMs: 5000 });
      const evaluator = createPermissionEvaluator({
        registry,
        adapter: trackingAdapter,
        cache,
      });

      await trackingAdapter.createGrant({
        subjectId: 'user-1',
        subjectType: 'user',
        tenantId: null,
        resourceType: null,
        resourceId: null,
        roles: ['editor'],
        effect: 'allow',
        grantedBy: 'system',
      });

      // Prime cache
      await evaluator.can({ subjectId: 'user-1', subjectType: 'user' }, 'read', {
        resourceType: 'post',
      });
      expect(adapterCalls).toBe(1);

      // Invalidate and call again
      cache.invalidate();
      const result = await evaluator.can({ subjectId: 'user-1', subjectType: 'user' }, 'read', {
        resourceType: 'post',
      });
      expect(result).toBe(true);
      expect(adapterCalls).toBe(2);
    });

    test('evaluator without cache works identically (backward compat)', async () => {
      const noCacheEvaluator = createPermissionEvaluator({ registry, adapter });

      await adapter.createGrant({
        subjectId: 'user-1',
        subjectType: 'user',
        tenantId: null,
        resourceType: null,
        resourceId: null,
        roles: ['editor'],
        effect: 'allow',
        grantedBy: 'system',
      });

      const result = await noCacheEvaluator.can(
        { subjectId: 'user-1', subjectType: 'user' },
        'read',
        { resourceType: 'post' },
      );
      expect(result).toBe(true);
    });
  });
});
