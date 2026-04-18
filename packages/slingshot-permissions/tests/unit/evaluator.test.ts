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
  },
};

describe('PermissionEvaluator', () => {
  let adapter: ReturnType<typeof createMemoryPermissionsAdapter>;
  let registry: ReturnType<typeof createPermissionRegistry>;
  let evaluator: ReturnType<typeof createPermissionEvaluator>;

  beforeEach(() => {
    adapter = createMemoryPermissionsAdapter();
    registry = createPermissionRegistry();
    registry.register(postDef);
    evaluator = createPermissionEvaluator({ registry, adapter });
  });

  test('user with matching grant passes permission check', async () => {
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
    const result = await evaluator.can({ subjectId: 'user-1', subjectType: 'user' }, 'read', {
      resourceType: 'post',
    });
    expect(result).toBe(true);
  });

  test('user without any grant fails permission check', async () => {
    const result = await evaluator.can({ subjectId: 'user-1', subjectType: 'user' }, 'read', {
      resourceType: 'post',
    });
    expect(result).toBe(false);
  });

  test('user with wrong role fails permission check', async () => {
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
    const result = await evaluator.can({ subjectId: 'user-1', subjectType: 'user' }, 'delete', {
      resourceType: 'post',
    });
    expect(result).toBe(false);
  });

  test('tenant-scoped grant: correct tenant passes, wrong tenant fails', async () => {
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
    const passResult = await evaluator.can({ subjectId: 'user-1', subjectType: 'user' }, 'read', {
      tenantId: 'tenant-a',
      resourceType: 'post',
    });
    expect(passResult).toBe(true);

    const failResult = await evaluator.can({ subjectId: 'user-1', subjectType: 'user' }, 'read', {
      tenantId: 'tenant-b',
      resourceType: 'post',
    });
    expect(failResult).toBe(false);
  });

  test('evaluator rejects grants that do not actually match the requested scope', async () => {
    const mismatchedGrant: PermissionGrant = {
      id: 'tenant-a-only',
      subjectId: 'user-1',
      subjectType: 'user',
      tenantId: 'tenant-a',
      resourceType: 'post',
      resourceId: null,
      roles: ['editor'],
      effect: 'allow',
      grantedBy: 'system',
      grantedAt: new Date(),
    };
    const mockAdapter: PermissionsAdapter = {
      async createGrant() {
        return '';
      },
      async revokeGrant() {
        return false;
      },
      async getGrantsForSubject() {
        return [mismatchedGrant];
      },
      async getEffectiveGrantsForSubject() {
        // Simulate a buggy adapter that leaked a tenant-a grant into a tenant-b check.
        return [mismatchedGrant];
      },
      async listGrantHistory() {
        return [];
      },
      async listGrantsOnResource() {
        return [];
      },
      async deleteAllGrantsForSubject() {},
    };
    const hardenedEvaluator = createPermissionEvaluator({ registry, adapter: mockAdapter });

    const result = await hardenedEvaluator.can(
      { subjectId: 'user-1', subjectType: 'user' },
      'read',
      {
        tenantId: 'tenant-b',
        resourceType: 'post',
      },
    );

    expect(result).toBe(false);
  });

  test('revoked grant is not applied', async () => {
    const grantId = await adapter.createGrant({
      subjectId: 'user-1',
      subjectType: 'user',
      tenantId: null,
      resourceType: null,
      resourceId: null,
      roles: ['editor'],
      effect: 'allow',
      grantedBy: 'system',
    });
    await adapter.revokeGrant(grantId, 'admin');
    const result = await evaluator.can({ subjectId: 'user-1', subjectType: 'user' }, 'read', {
      resourceType: 'post',
    });
    expect(result).toBe(false);
  });

  test('deny grant wins over allow grant', async () => {
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
    const result = await evaluator.can({ subjectId: 'user-1', subjectType: 'user' }, 'read', {
      resourceType: 'post',
    });
    expect(result).toBe(false);
  });

  test('super-admin role via global grant passes any action', async () => {
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
      resourceType: 'post',
    });
    expect(result).toBe(true);
  });

  test('expired grant is not applied', async () => {
    // Use a mock adapter that returns a grant with past expiresAt
    // (memory adapter rejects past expiresAt during createGrant)
    const pastDate = new Date(Date.now() - 100_000);
    const expiredGrant: PermissionGrant = {
      id: 'expired-1',
      subjectId: 'user-1',
      subjectType: 'user',
      tenantId: null,
      resourceType: null,
      resourceId: null,
      roles: ['editor'],
      effect: 'allow',
      grantedBy: 'system',
      grantedAt: new Date(),
      expiresAt: pastDate,
    };
    const mockAdapter: PermissionsAdapter = {
      async createGrant() {
        return '';
      },
      async revokeGrant() {
        return false;
      },
      async getGrantsForSubject() {
        return [expiredGrant];
      },
      async getEffectiveGrantsForSubject() {
        // Simulate an adapter that returned the expired grant anyway (evaluator safety net)
        return [expiredGrant];
      },
      async listGrantHistory() {
        return [];
      },
      async listGrantsOnResource() {
        return [];
      },
      async deleteAllGrantsForSubject() {},
    };
    const expEvaluator = createPermissionEvaluator({ registry, adapter: mockAdapter });
    const result = await expEvaluator.can({ subjectId: 'user-1', subjectType: 'user' }, 'read', {
      resourceType: 'post',
    });
    expect(result).toBe(false);
  });

  test("group expansion unions grants from user's groups", async () => {
    // User has no direct grant, but their group does
    const groupAdapter = createMemoryPermissionsAdapter();
    await groupAdapter.createGrant({
      subjectId: 'group-alpha',
      subjectType: 'group',
      tenantId: null,
      resourceType: null,
      resourceId: null,
      roles: ['editor'],
      effect: 'allow',
      grantedBy: 'system',
    });

    const groupResolver = {
      async getGroupsForUser(userId: string, tenantId: string | null) {
        if (userId === 'user-1') return ['group-alpha'];
        return [];
      },
    };

    const groupEvaluator = createPermissionEvaluator({
      registry,
      adapter: groupAdapter,
      groupResolver,
    });
    const result = await groupEvaluator.can({ subjectId: 'user-1', subjectType: 'user' }, 'read', {
      resourceType: 'post',
    });
    expect(result).toBe(true);
  });

  test('group expansion: deny grant on group blocks user access', async () => {
    const groupAdapter = createMemoryPermissionsAdapter();
    // User has allow grant directly
    await groupAdapter.createGrant({
      subjectId: 'user-1',
      subjectType: 'user',
      tenantId: null,
      resourceType: null,
      resourceId: null,
      roles: ['editor'],
      effect: 'allow',
      grantedBy: 'system',
    });
    // Group has deny grant
    await groupAdapter.createGrant({
      subjectId: 'group-alpha',
      subjectType: 'group',
      tenantId: null,
      resourceType: null,
      resourceId: null,
      roles: ['editor'],
      effect: 'deny',
      grantedBy: 'system',
    });

    const groupResolver = {
      async getGroupsForUser(userId: string, tenantId: string | null) {
        if (userId === 'user-1') return ['group-alpha'];
        return [];
      },
    };

    const groupEvaluator = createPermissionEvaluator({
      registry,
      adapter: groupAdapter,
      groupResolver,
    });
    const result = await groupEvaluator.can({ subjectId: 'user-1', subjectType: 'user' }, 'read', {
      resourceType: 'post',
    });
    expect(result).toBe(false);
  });

  test('scope cascade level 2: type-wide tenant grant covers specific resource', async () => {
    await adapter.createGrant({
      subjectId: 'user-1',
      subjectType: 'user',
      tenantId: 'tenant-a',
      resourceType: 'post',
      resourceId: null,
      roles: ['editor'],
      effect: 'allow',
      grantedBy: 'system',
    });
    const result = await evaluator.can({ subjectId: 'user-1', subjectType: 'user' }, 'read', {
      tenantId: 'tenant-a',
      resourceType: 'post',
      resourceId: 'post-42',
    });
    expect(result).toBe(true);
  });

  test('scope cascade level 1: resource-specific grant does not cover other resources', async () => {
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
    const pass = await evaluator.can({ subjectId: 'user-1', subjectType: 'user' }, 'read', {
      tenantId: 'tenant-a',
      resourceType: 'post',
      resourceId: 'post-42',
    });
    expect(pass).toBe(true);

    const fail = await evaluator.can({ subjectId: 'user-1', subjectType: 'user' }, 'read', {
      tenantId: 'tenant-a',
      resourceType: 'post',
      resourceId: 'post-99',
    });
    expect(fail).toBe(false);
  });

  test('super-admin deny grant blocks super-admin access', async () => {
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
    await adapter.createGrant({
      subjectId: 'user-1',
      subjectType: 'user',
      tenantId: null,
      resourceType: null,
      resourceId: null,
      roles: ['super-admin'],
      effect: 'deny',
      grantedBy: 'system',
    });
    // deny wins over allow even for super-admin
    const result = await evaluator.can({ subjectId: 'user-1', subjectType: 'user' }, 'delete', {
      resourceType: 'post',
    });
    expect(result).toBe(false);
  });

  test('can() with no scope: super-admin passes, other roles denied', async () => {
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
    // editor with no resourceType in scope — getActionsForRole('', 'editor') returns []
    const editorResult = await evaluator.can({ subjectId: 'user-1', subjectType: 'user' }, 'read');
    expect(editorResult).toBe(false);

    await adapter.createGrant({
      subjectId: 'user-2',
      subjectType: 'user',
      tenantId: null,
      resourceType: null,
      resourceId: null,
      roles: ['super-admin'],
      effect: 'allow',
      grantedBy: 'system',
    });
    const superAdminResult = await evaluator.can(
      { subjectId: 'user-2', subjectType: 'user' },
      'read',
    );
    expect(superAdminResult).toBe(true);
  });
});
