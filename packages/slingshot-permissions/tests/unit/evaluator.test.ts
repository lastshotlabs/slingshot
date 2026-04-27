import { beforeEach, describe, expect, spyOn, test } from 'bun:test';
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

  test('maxGroups batches large group expansion without dropping grants', async () => {
    const capAdapter = createMemoryPermissionsAdapter();
    const capRegistry = createPermissionRegistry();
    capRegistry.register(postDef);

    // Create a group grant for group-4, which used to be dropped when the
    // evaluator truncated group expansion at the batch size.
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

    // User belongs to groups 1-4 (4 groups), but the evaluator now processes
    // them in batches of 3 instead of truncating the tail.
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
      if (msg.includes('batches')) warnMessage = msg;
    };
    try {
      const result = await cappedEvaluator.can(
        { subjectId: 'user-1', subjectType: 'user' },
        'read',
        { resourceType: 'post' },
      );
      // group-4 is now included, so the editor grant applies.
      expect(result).toBe(true);
    } finally {
      console.warn = originalWarn;
    }
    expect(warnMessage).toMatch(/batches/);
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

  test('queryTimeoutMs clears the timer when the query resolves quickly', async () => {
    const clearTimeoutSpy = spyOn(globalThis, 'clearTimeout');
    const setTimeoutSpy = spyOn(globalThis, 'setTimeout').mockImplementation(((
      handler: TimerHandler,
      timeout?: number,
      ...args: unknown[]
    ) => {
      void handler;
      void timeout;
      void args;
      return 123 as ReturnType<typeof setTimeout>;
    }) as typeof setTimeout);

    const fastAdapter: PermissionsAdapter = {
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
        return [];
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
      adapter: fastAdapter,
      queryTimeoutMs: 50,
    });

    await expect(
      timedEvaluator.can({ subjectId: 'user-1', subjectType: 'user' }, 'read', {
        resourceType: 'post',
      }),
    ).resolves.toBe(false);

    expect(setTimeoutSpy).toHaveBeenCalledTimes(1);
    expect(clearTimeoutSpy).toHaveBeenCalledWith(123);

    setTimeoutSpy.mockRestore();
    clearTimeoutSpy.mockRestore();
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

  test('scope { tenantId: undefined } behaves identically to no scope for non-global grants', async () => {
    // Tenant-scoped grant — should NOT match when scope.tenantId is explicitly undefined
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

    // No scope at all
    const noScope = await evaluator.can(
      { subjectId: 'user-1', subjectType: 'user' },
      'read',
    );
    // Scope with tenantId explicitly undefined
    const explicitUndefined = await evaluator.can(
      { subjectId: 'user-1', subjectType: 'user' },
      'read',
      { tenantId: undefined, resourceType: 'post' },
    );

    expect(noScope).toBe(false);
    expect(explicitUndefined).toBe(false);
  });

  test('global grant matches when scope is { tenantId: undefined }', async () => {
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

    const result = await evaluator.can(
      { subjectId: 'user-1', subjectType: 'user' },
      'read',
      { tenantId: undefined, resourceType: 'post' },
    );
    expect(result).toBe(true);
  });

  test('scope with only resourceId (no tenantId / resourceType) does not match resource-scoped grants', async () => {
    await adapter.createGrant({
      subjectId: 'user-1',
      subjectType: 'user',
      tenantId: 'tenant-a',
      resourceType: 'post',
      resourceId: 'post-1',
      roles: ['editor'],
      effect: 'allow',
      grantedBy: 'system',
    });

    // Only passing resourceId with no tenantId — grant requires tenantId to match
    const result = await evaluator.can(
      { subjectId: 'user-1', subjectType: 'user' },
      'read',
      { resourceId: 'post-1' },
    );
    expect(result).toBe(false);
  });

  test('queryTimeoutMs fires for individual group grant fetches inside batch expansion', async () => {
    // Each collectGrantsForSubject for a group is also wrapped with maybeWithTimeout.
    // A hanging group grant fetch should reject (treated as allSettled failure) and
    // be skipped — the evaluator should continue with remaining groups.
    const hangingGroupAdapter: PermissionsAdapter = {
      async createGrant() { return ''; },
      async revokeGrant() { return false; },
      async getGrantsForSubject() { return []; },
      async getEffectiveGrantsForSubject(subjectId) {
        if (subjectId === 'group-hang') {
          return new Promise<PermissionGrant[]>(() => {}); // hangs forever
        }
        return []; // group-ok has no grants → user cannot access
      },
      async listGrantHistory() { return []; },
      async listGrantsOnResource() { return []; },
      async deleteAllGrantsForSubject() {},
    };

    const groupResolver = {
      async getGroupsForUser() {
        return ['group-hang', 'group-ok'];
      },
    };

    const timedGroupEvaluator = createPermissionEvaluator({
      registry,
      adapter: hangingGroupAdapter,
      groupResolver,
      queryTimeoutMs: 50,
    });

    const warnMessages: string[] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => { warnMessages.push(String(args[0])); };

    let result: boolean;
    try {
      result = await timedGroupEvaluator.can(
        { subjectId: 'user-1', subjectType: 'user' },
        'read',
        { resourceType: 'post' },
      );
    } finally {
      console.warn = originalWarn;
    }

    // group-hang timed out (treated as rejected by allSettled), group-ok had no grants
    expect(result!).toBe(false);
    // A warning about group-hang failure should have been emitted
    expect(warnMessages.some(m => m.includes('group-hang'))).toBe(true);
  });

  test('non-user subject type skips group expansion entirely', async () => {
    const groupAdapter = createMemoryPermissionsAdapter();
    await groupAdapter.createGrant({
      subjectId: 'service-group',
      subjectType: 'group',
      tenantId: null,
      resourceType: null,
      resourceId: null,
      roles: ['editor'],
      effect: 'allow',
      grantedBy: 'system',
    });

    let getGroupsCalled = false;
    const groupResolver = {
      async getGroupsForUser() {
        getGroupsCalled = true;
        return ['service-group'];
      },
    };

    const svcEvaluator = createPermissionEvaluator({
      registry,
      adapter: groupAdapter,
      groupResolver,
    });

    // Service account — group expansion must NOT run
    await svcEvaluator.can(
      { subjectId: 'svc-1', subjectType: 'service-account' },
      'read',
      { resourceType: 'post' },
    );
    expect(getGroupsCalled).toBe(false);
  });

  describe('queryTimeoutMs config validation', () => {
    test('throws when queryTimeoutMs is 0', () => {
      expect(() => createPermissionEvaluator({ registry, adapter, queryTimeoutMs: 0 })).toThrow(
        '[slingshot-permissions] queryTimeoutMs must be a positive number',
      );
    });

    test('throws when queryTimeoutMs is negative', () => {
      expect(() => createPermissionEvaluator({ registry, adapter, queryTimeoutMs: -100 })).toThrow(
        '[slingshot-permissions] queryTimeoutMs must be a positive number',
      );
    });

    test('accepts a positive queryTimeoutMs', () => {
      expect(() =>
        createPermissionEvaluator({ registry, adapter, queryTimeoutMs: 3000 }),
      ).not.toThrow();
    });
  });

  describe('maxGroups config validation', () => {
    test('throws when maxGroups is 0', () => {
      expect(() => createPermissionEvaluator({ registry, adapter, maxGroups: 0 })).toThrow(
        '[slingshot-permissions] maxGroups must be a positive number',
      );
    });

    test('throws when maxGroups is negative', () => {
      expect(() => createPermissionEvaluator({ registry, adapter, maxGroups: -10 })).toThrow(
        '[slingshot-permissions] maxGroups must be a positive number',
      );
    });

    test('accepts a positive maxGroups', () => {
      expect(() => createPermissionEvaluator({ registry, adapter, maxGroups: 100 })).not.toThrow();
    });
  });
});
