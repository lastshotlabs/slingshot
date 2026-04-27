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
      async getGroupsForUser(userId: string) {
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
      async getGroupsForUser(userId: string) {
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

  test('super-admin allow grant is immune to deny grants — super-admin cannot be blocked', async () => {
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
    // An explicit deny on the super-admin role does NOT block them —
    // super-admin is evaluated first in the allow pass before any deny check.
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
    const result = await evaluator.can({ subjectId: 'user-1', subjectType: 'user' }, 'delete', {
      resourceType: 'post',
    });
    expect(result).toBe(true);
  });

  test('deny grant on a regular role still blocks a user who also has super-admin', async () => {
    // deny on a non-super-admin role doesn't matter — super-admin wins
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
      roles: ['editor'],
      effect: 'deny',
      grantedBy: 'system',
    });
    const result = await evaluator.can({ subjectId: 'user-1', subjectType: 'user' }, 'delete', {
      resourceType: 'post',
    });
    expect(result).toBe(true);
  });

  test('scope mismatch: grant with specific resourceType rejected when scope lacks resourceType', async () => {
    // Exercise grantMatchesScope line 35: grant.resourceType set but scope.resourceType undefined
    const mismatchGrant: PermissionGrant = {
      id: 'type-scoped',
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
        return [mismatchGrant];
      },
      async getEffectiveGrantsForSubject() {
        return [mismatchGrant];
      },
      async listGrantHistory() {
        return [];
      },
      async listGrantsOnResource() {
        return [];
      },
      async deleteAllGrantsForSubject() {},
    };
    const ev = createPermissionEvaluator({ registry, adapter: mockAdapter });
    // Scope has tenantId but NO resourceType — grant should not match
    const result = await ev.can({ subjectId: 'user-1', subjectType: 'user' }, 'read', {
      tenantId: 'tenant-a',
    });
    expect(result).toBe(false);
  });

  test('deny grant that does not cover the action falls through to allow', async () => {
    // Exercise evaluator lines 134-135: deny grant role does not include the requested action
    await adapter.createGrant({
      subjectId: 'user-1',
      subjectType: 'user',
      tenantId: null,
      resourceType: null,
      resourceId: null,
      roles: ['reader'], // reader can only 'read'
      effect: 'deny',
      grantedBy: 'system',
    });
    await adapter.createGrant({
      subjectId: 'user-1',
      subjectType: 'user',
      tenantId: null,
      resourceType: null,
      resourceId: null,
      roles: ['owner'], // owner can 'create', 'read', 'update', 'delete'
      effect: 'allow',
      grantedBy: 'system',
    });
    // 'delete' is denied by reader? No — reader only has ['read'], so deny loop falls through
    const result = await evaluator.can({ subjectId: 'user-1', subjectType: 'user' }, 'delete', {
      resourceType: 'post',
    });
    expect(result).toBe(true);
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

  test('can() without scope.resourceType emits a console.warn when active grants exist', async () => {
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
    const originalWarn = console.warn;
    let warnMessage: string | undefined;
    console.warn = (msg: string) => {
      warnMessage = msg;
    };
    try {
      await evaluator.can({ subjectId: 'user-1', subjectType: 'user' }, 'read');
    } finally {
      console.warn = originalWarn;
    }
    expect(warnMessage).toMatch(/scope\.resourceType/);
  });

  test('tenant-a grant does not satisfy a tenant-b scope evaluation', async () => {
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
    const resultA = await evaluator.can({ subjectId: 'user-1', subjectType: 'user' }, 'read', {
      tenantId: 'tenant-a',
      resourceType: 'post',
    });
    expect(resultA).toBe(true);

    const resultB = await evaluator.can({ subjectId: 'user-1', subjectType: 'user' }, 'read', {
      tenantId: 'tenant-b',
      resourceType: 'post',
    });
    expect(resultB).toBe(false);
  });

  test('maxGroups cap truncates group expansion and emits console.warn', async () => {
    const capAdapter = createMemoryPermissionsAdapter();
    const capRegistry = createPermissionRegistry();
    capRegistry.register(postDef);

    // Create a group grant for group-5 (which is beyond the cap of 3)
    await capAdapter.createGrant({
      subjectId: 'group-4',
      subjectType: 'group',
      tenantId: null,
      resourceType: null,
      resourceId: null,
      roles: ['editor'],
      effect: 'allow',
      grantedBy: 'system',
    });

    // User belongs to groups 1-4 (4 groups), but cap is 3
    const groupResolver = {
      getGroupsForUser: async () => ['group-1', 'group-2', 'group-3', 'group-4'],
    };
    const cappedEvaluator = createPermissionEvaluator({
      registry: capRegistry,
      adapter: capAdapter,
      groupResolver,
      maxGroups: 3,
    });

    const originalWarn = console.warn;
    let warnMessage: string | undefined;
    console.warn = (msg: string) => {
      if (msg.includes('truncated')) warnMessage = msg;
    };
    try {
      const result = await cappedEvaluator.can(
        { subjectId: 'user-1', subjectType: 'user' },
        'read',
        { resourceType: 'post' },
      );
      // group-4 was truncated, so no editor grant → false
      expect(result).toBe(false);
    } finally {
      console.warn = originalWarn;
    }
    expect(warnMessage).toMatch(/truncated/);
    expect(warnMessage).toMatch(/4.*3|maxGroups/);
  });

  test('queryTimeoutMs rejects can() when adapter hangs past the deadline', async () => {
    const hangingAdapter: PermissionsAdapter = {
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
        return new Promise(() => {}) as Promise<PermissionGrant[]>; // hangs forever
      },
      async listGrantHistory() {
        return [];
      },
      async listGrantsOnResource() {
        return [];
      },
      async deleteAllGrantsForSubject() {},
    };

    const timedEvaluator = createPermissionEvaluator({
      registry,
      adapter: hangingAdapter,
      queryTimeoutMs: 50,
    });

    await expect(
      timedEvaluator.can({ subjectId: 'user-1', subjectType: 'user' }, 'read', {
        resourceType: 'post',
      }),
    ).rejects.toThrow('Permission query timed out');
  });

  test('can() continues with other group grants when one group grant fetch fails', async () => {
    // group-good has the required grant; group-bad fails its fetch
    const groupAdapter = createMemoryPermissionsAdapter();
    await groupAdapter.createGrant({
      subjectId: 'group-good',
      subjectType: 'group',
      tenantId: null,
      resourceType: null,
      resourceId: null,
      roles: ['editor'],
      effect: 'allow',
      grantedBy: 'system',
    });

    const failingAdapter: PermissionsAdapter = {
      async createGrant() {
        return '';
      },
      async revokeGrant() {
        return false;
      },
      async getGrantsForSubject() {
        return [];
      },
      async getEffectiveGrantsForSubject(subjectId) {
        if (subjectId === 'group-bad') throw new Error('db connection lost');
        return groupAdapter.getEffectiveGrantsForSubject(subjectId, 'group');
      },
      async listGrantHistory() {
        return [];
      },
      async listGrantsOnResource() {
        return [];
      },
      async deleteAllGrantsForSubject() {},
    };

    const groupResolver = {
      async getGroupsForUser(userId: string) {
        if (userId === 'user-1') return ['group-bad', 'group-good'];
        return [];
      },
    };

    const warnMessages: string[] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => {
      warnMessages.push(String(args[0]));
    };
    let result: boolean;
    try {
      result = await createPermissionEvaluator({
        registry,
        adapter: failingAdapter,
        groupResolver,
      }).can({ subjectId: 'user-1', subjectType: 'user' }, 'read', { resourceType: 'post' });
    } finally {
      console.warn = originalWarn;
    }

    // group-good's grant should still be applied even though group-bad failed
    expect(result!).toBe(true);
    expect(warnMessages.some(m => m.includes('group-bad'))).toBe(true);
  });
});
