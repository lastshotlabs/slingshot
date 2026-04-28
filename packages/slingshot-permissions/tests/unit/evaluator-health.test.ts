import { describe, expect, test } from 'bun:test';
import type {
  PermissionGrant,
  PermissionsAdapter,
  ResourceTypeDefinition,
} from '@lastshotlabs/slingshot-core';
import { createMemoryPermissionsAdapter } from '../../src/adapters/memory';
import { createPermissionEvaluator } from '../../src/lib/evaluator';
import { createPermissionRegistry } from '../../src/lib/registry';

const postDef: ResourceTypeDefinition = {
  resourceType: 'post',
  actions: ['create', 'read', 'update', 'delete'],
  roles: { reader: ['read'] },
};

const noopBatchMethods: Pick<PermissionsAdapter, 'createGrants' | 'deleteAllGrantsOnResource'> = {
  async createGrants() {
    return [];
  },
  async deleteAllGrantsOnResource() {},
};

describe('createPermissionEvaluator getHealth()', () => {
  test('returns zeroed counters on a freshly-created evaluator', () => {
    const adapter = createMemoryPermissionsAdapter();
    const registry = createPermissionRegistry();
    registry.register(postDef);
    const evaluator = createPermissionEvaluator({ registry, adapter });

    const health = evaluator.getHealth();
    expect(health.queryTimeoutCount).toBe(0);
    expect(health.groupExpansionErrorCount).toBe(0);
    expect(health.lastQueryTimeoutAt).toBeNull();
    expect(health.lastGroupExpansionErrorAt).toBeNull();
  });

  test('increments queryTimeoutCount when an adapter query times out', async () => {
    const hangingAdapter: PermissionsAdapter = {
      ...noopBatchMethods,
      async createGrant() {
        return '';
      },
      async revokeGrant() {
        return false;
      },
      async getGrantsForSubject() {
        return [];
      },
      async getEffectiveGrantsForSubject() {
        return new Promise(() => {}) as Promise<PermissionGrant[]>;
      },
      async listGrantHistory() {
        return [];
      },
      async listGrantsOnResource() {
        return [];
      },
      async deleteAllGrantsForSubject() {},
    };

    const registry = createPermissionRegistry();
    registry.register(postDef);
    const evaluator = createPermissionEvaluator({
      registry,
      adapter: hangingAdapter,
      queryTimeoutMs: 20,
    });

    await expect(
      evaluator.can({ subjectId: 'user-1', subjectType: 'user' }, 'read', {
        resourceType: 'post',
      }),
    ).rejects.toThrow('Permission query timed out');

    const health = evaluator.getHealth();
    expect(health.queryTimeoutCount).toBe(1);
    expect(health.lastQueryTimeoutAt).not.toBeNull();
  });
});
