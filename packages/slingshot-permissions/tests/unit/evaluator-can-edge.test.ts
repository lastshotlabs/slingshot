/**
 * Edge-case coverage for PermissionEvaluator.can().
 *
 * Builds on the extensive evaluator tests in evaluator.test.ts.
 * Covers grant hierarchy resolution, role inheritance/union, scope cascade
 * with denies at different levels, deny-wins across cascade boundaries,
 * boundary scope conditions, and concurrent can() calls.
 */
import { beforeEach, describe, expect, test } from 'bun:test';
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
  roles: {
    editor: ['create', 'update', 'read'],
    reader: ['read'],
    owner: ['create', 'read', 'update', 'delete'],
    moderator: ['delete', 'read'],
  },
};

const commentDef: ResourceTypeDefinition = {
  resourceType: 'comment',
  actions: ['create', 'read', 'delete'],
  roles: {
    author: ['create', 'read', 'delete'],
    reader: ['read'],
  },
};

const noopBatchMethods: Pick<PermissionsAdapter, 'createGrants' | 'deleteAllGrantsOnResource'> = {
  async createGrants() {
    return [];
  },
  async deleteAllGrantsOnResource() {},
};

describe('can() global-to-tenant-to-resource cascade with denies', () => {
  let adapter: ReturnType<typeof createMemoryPermissionsAdapter>;
  let registry: ReturnType<typeof createPermissionRegistry>;
  let evaluator: ReturnType<typeof createPermissionEvaluator>;

  beforeEach(() => {
    adapter = createMemoryPermissionsAdapter();
    registry = createPermissionRegistry();
    registry.register(postDef);
    evaluator = createPermissionEvaluator({ registry, adapter });
  });

  test('global allow + tenant deny = tenant deny wins for tenant-scoped check', async () => {
    // Global allow
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
    // Tenant deny
    await adapter.createGrant({
      subjectId: 'user-1',
      subjectType: 'user',
      tenantId: 'tenant-a',
      resourceType: null,
      resourceId: null,
      roles: ['editor'],
      effect: 'deny',
      grantedBy: 'system',
    });

    // Global scope should still allow
    const globalResult = await evaluator.can({ subjectId: 'user-1', subjectType: 'user' }, 'read', {
      resourceType: 'post',
    });
    expect(globalResult).toBe(true);

    // Tenant scope should deny (tenant deny overrides global allow)
    const tenantResult = await evaluator.can({ subjectId: 'user-1', subjectType: 'user' }, 'read', {
      tenantId: 'tenant-a',
      resourceType: 'post',
    });
    expect(tenantResult).toBe(false);
  });

  test('tenant allow + resource deny: resource-level deny wins', async () => {
    // Tenant allow
    await adapter.createGrant({
      subjectId: 'user-1',
      subjectType: 'user',
      tenantId: 'tenant-a',
      resourceType: null,
      resourceId: null,
      roles: ['editor'],
      effect: 'allow',
      grantedBy: 'system',
    });
    // Resource-specific deny
    await adapter.createGrant({
      subjectId: 'user-1',
      subjectType: 'user',
      tenantId: 'tenant-a',
      resourceType: 'post',
      resourceId: 'post-42',
      roles: ['editor'],
      effect: 'deny',
      grantedBy: 'system',
    });

    // Different resource in same tenant should be allowed
    const otherResource = await evaluator.can(
      { subjectId: 'user-1', subjectType: 'user' },
      'read',
      { tenantId: 'tenant-a', resourceType: 'post', resourceId: 'post-99' },
    );
    expect(otherResource).toBe(true);

    // The denied resource should be blocked
    const deniedResource = await evaluator.can(
      { subjectId: 'user-1', subjectType: 'user' },
      'read',
      { tenantId: 'tenant-a', resourceType: 'post', resourceId: 'post-42' },
    );
    expect(deniedResource).toBe(false);
  });

  test('global deny + tenant allow: global deny still blocks across tenants', async () => {
    // Global deny
    await adapter.createGrant({
      subjectId: 'user-1',
      subjectType: 'user',
      tenantId: null,
      resourceType: null,
      resourceId: null,
      roles: ['editor'],
      effect: 'deny',
      grantedBy: 'system',
    });

    const tenantResult = await evaluator.can({ subjectId: 'user-1', subjectType: 'user' }, 'read', {
      tenantId: 'tenant-a',
      resourceType: 'post',
    });
    expect(tenantResult).toBe(false);
  });

  test('resource-type-wide deny blocks specific resources of that type', async () => {
    // Resource-type-wide deny
    await adapter.createGrant({
      subjectId: 'user-1',
      subjectType: 'user',
      tenantId: 'tenant-a',
      resourceType: 'post',
      resourceId: null,
      roles: ['moderator'],
      effect: 'deny',
      grantedBy: 'system',
    });

    // Specific resource - blocked by type-wide deny
    const blocked = await evaluator.can({ subjectId: 'user-1', subjectType: 'user' }, 'read', {
      tenantId: 'tenant-a',
      resourceType: 'post',
      resourceId: 'post-1',
    });
    expect(blocked).toBe(false);
  });

  test('deny on one role does not block an unrelated action on a different role', async () => {
    // User has reader (read only) and owner (all actions)
    await adapter.createGrant({
      subjectId: 'user-1',
      subjectType: 'user',
      tenantId: null,
      resourceType: null,
      resourceId: null,
      roles: ['reader'],
      effect: 'allow',
      grantedBy: 'system',
    });
    await adapter.createGrant({
      subjectId: 'user-1',
      subjectType: 'user',
      tenantId: null,
      resourceType: null,
      resourceId: null,
      roles: ['owner'],
      effect: 'allow',
      grantedBy: 'system',
    });
    // Deny on reader role
    await adapter.createGrant({
      subjectId: 'user-1',
      subjectType: 'user',
      tenantId: null,
      resourceType: null,
      resourceId: null,
      roles: ['reader'],
      effect: 'deny',
      grantedBy: 'system',
    });

    // 'delete' is an owner action (reader does not have it) → should be allowed
    const result = await evaluator.can({ subjectId: 'user-1', subjectType: 'user' }, 'delete', {
      resourceType: 'post',
    });
    expect(result).toBe(true);
  });
});

describe('can() role inheritance and union', () => {
  let adapter: ReturnType<typeof createMemoryPermissionsAdapter>;
  let registry: ReturnType<typeof createPermissionRegistry>;
  let evaluator: ReturnType<typeof createPermissionEvaluator>;

  beforeEach(() => {
    adapter = createMemoryPermissionsAdapter();
    registry = createPermissionRegistry();
    registry.register(postDef);
    registry.register(commentDef);
    evaluator = createPermissionEvaluator({ registry, adapter });
  });

  test('user with two roles unions their action sets', async () => {
    await adapter.createGrant({
      subjectId: 'user-1',
      subjectType: 'user',
      tenantId: null,
      resourceType: null,
      resourceId: null,
      roles: ['editor', 'reader'],
      effect: 'allow',
      grantedBy: 'system',
    });

    // editor has [create, update, read], reader has [read] → union has [create, read, update]
    const canCreate = await evaluator.can({ subjectId: 'user-1', subjectType: 'user' }, 'create', {
      resourceType: 'post',
    });
    expect(canCreate).toBe(true);

    const canDelete = await evaluator.can({ subjectId: 'user-1', subjectType: 'user' }, 'delete', {
      resourceType: 'post',
    });
    expect(canDelete).toBe(false);
  });

  test('same subject with grants across different resource types is isolated', async () => {
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

    const canEditPost = await evaluator.can({ subjectId: 'user-1', subjectType: 'user' }, 'update', {
      resourceType: 'post',
    });
    expect(canEditPost).toBe(true);

    // 'comment' is registered but user has no role that maps to it
    const canDeleteComment = await evaluator.can(
      { subjectId: 'user-1', subjectType: 'user' },
      'delete',
      { resourceType: 'comment' },
    );
    expect(canDeleteComment).toBe(false);
  });
});

describe('can() scope boundary conditions', () => {
  let adapter: ReturnType<typeof createMemoryPermissionsAdapter>;
  let registry: ReturnType<typeof createPermissionRegistry>;
  let evaluator: ReturnType<typeof createPermissionEvaluator>;

  beforeEach(() => {
    adapter = createMemoryPermissionsAdapter();
    registry = createPermissionRegistry();
    registry.register(postDef);
    evaluator = createPermissionEvaluator({ registry, adapter });
  });

  test('scope with only tenantId (no resourceType) matches tenant-wide grants', async () => {
    await adapter.createGrant({
      subjectId: 'user-1',
      subjectType: 'user',
      tenantId: 'tenant-a',
      resourceType: null,
      resourceId: null,
      roles: ['super-admin'],
      effect: 'allow',
      grantedBy: 'system',
    });

    // super-admin grant at tenant level — should match even without resourceType in scope
    const result = await evaluator.can({ subjectId: 'user-1', subjectType: 'user' }, 'read', {
      tenantId: 'tenant-a',
    });
    expect(result).toBe(true);
  });

  test('scope with explicitly null resourceId does not match resource-scoped grants', async () => {
    await adapter.createGrant({
      subjectId: 'user-1',
      subjectType: 'user',
      tenantId: 'tenant-a',
      resourceType: 'post',
      resourceId: 'post-42',
      roles: ['editor'],
      effect: 'allow',
      grantedBy: 'system',
    });

    // scope has resourceId: null ≠ 'post-42', so no match
    const result = await evaluator.can({ subjectId: 'user-1', subjectType: 'user' }, 'read', {
      tenantId: 'tenant-a',
      resourceType: 'post',
      resourceId: null,
    });
    expect(result).toBe(false);
  });
});

describe('can() with unregistered resource types', () => {
  let adapter: ReturnType<typeof createMemoryPermissionsAdapter>;
  let registry: ReturnType<typeof createPermissionRegistry>;
  let evaluator: ReturnType<typeof createPermissionEvaluator>;

  beforeEach(() => {
    adapter = createMemoryPermissionsAdapter();
    registry = createPermissionRegistry();
    evaluator = createPermissionEvaluator({ registry, adapter });
  });

  test('edit action on unregistered resource type = false even with global editor grant', async () => {
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

    const result = await evaluator.can({ subjectId: 'user-1', subjectType: 'user' }, 'update', {
      resourceType: 'widget',
    });
    expect(result).toBe(false);
  });

  test('super-admin can act on unregistered resource type', async () => {
    await adapter.createGrant({
      subjectId: 'user-1',
      subjectType: 'user',
      tenantId: null,
      resourceType: null,
      resourceId: null,
      roles: ['super-admin'],
      effect: 'allow',
      grantedBy: 'system',
    });

    const result = await evaluator.can({ subjectId: 'user-1', subjectType: 'user' }, 'delete', {
      resourceType: 'widget',
    });
    expect(result).toBe(true);
  });
});

describe('can() concurrent calls', () => {
  test('multiple concurrent can() calls with same adapter do not interfere', async () => {
    const adapter = createMemoryPermissionsAdapter();
    const registry = createPermissionRegistry();
    registry.register(postDef);
    const evaluator = createPermissionEvaluator({ registry, adapter });

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

    await adapter.createGrant({
      subjectId: 'user-2',
      subjectType: 'user',
      tenantId: null,
      resourceType: null,
      resourceId: null,
      roles: ['reader'],
      effect: 'allow',
      grantedBy: 'system',
    });

    const results = await Promise.all([
      evaluator.can({ subjectId: 'user-1', subjectType: 'user' }, 'update', {
        resourceType: 'post',
      }),
      evaluator.can({ subjectId: 'user-2', subjectType: 'user' }, 'update', {
        resourceType: 'post',
      }),
      evaluator.can({ subjectId: 'user-1', subjectType: 'user' }, 'delete', {
        resourceType: 'post',
      }),
      evaluator.can({ subjectId: 'user-2', subjectType: 'user' }, 'read', {
        resourceType: 'post',
      }),
    ]);

    expect(results[0]).toBe(true); // user-1 editor can update
    expect(results[1]).toBe(false); // user-2 reader cannot update
    expect(results[2]).toBe(false); // user-1 editor cannot delete
    expect(results[3]).toBe(true); // user-2 reader can read
  });
});

describe('can() with deny on specific action in role', () => {
  let adapter: ReturnType<typeof createMemoryPermissionsAdapter>;
  let registry: ReturnType<typeof createPermissionRegistry>;
  let evaluator: ReturnType<typeof createPermissionEvaluator>;

  beforeEach(() => {
    adapter = createMemoryPermissionsAdapter();
    registry = createPermissionRegistry();
    registry.register(postDef);
    evaluator = createPermissionEvaluator({ registry, adapter });
  });

  test('allow + deny same role: deny wins for actions covered by the role', async () => {
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
    await adapter.createGrant({
      subjectId: 'user-1',
      subjectType: 'user',
      tenantId: null,
      resourceType: null,
      resourceId: null,
      roles: ['editor'],
      effect: 'deny',
      grantedBy: 'system',
    });

    // editor has [create, update, read], deny blocks all of them
    const canCreate = await evaluator.can({ subjectId: 'user-1', subjectType: 'user' }, 'create', {
      resourceType: 'post',
    });
    expect(canCreate).toBe(false);

    // But owner (different grant) is not affected
    await adapter.createGrant({
      subjectId: 'user-1',
      subjectType: 'user',
      tenantId: null,
      resourceType: null,
      resourceId: null,
      roles: ['owner'],
      effect: 'allow',
      grantedBy: 'system',
    });

    const canDelete = await evaluator.can({ subjectId: 'user-1', subjectType: 'user' }, 'delete', {
      resourceType: 'post',
    });
    expect(canDelete).toBe(true);
  });
});
