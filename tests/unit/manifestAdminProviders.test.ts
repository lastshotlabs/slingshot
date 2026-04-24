import { describe, expect, it } from 'bun:test';
import {
  createDeferredAdminProviders,
  createInMemoryAuditLog,
} from '../../src/lib/manifestAdminProviders';

// ---------------------------------------------------------------------------
// Helpers / mock factory
// ---------------------------------------------------------------------------

/** Build a minimal mock Hono context with a get() method. */
function mockContext(vars: Record<string, unknown>) {
  return {
    get: (key: string) => vars[key],
  };
}

/** Build a minimal mock auth adapter. */
function mockAuthAdapter(overrides: Record<string, unknown> = {}) {
  return {
    ...overrides,
  };
}

/** Build a minimal mock auth runtime context suitable for pluginState. */
function mockAuthRuntime(adapterOverrides: Record<string, unknown> = {}) {
  return {
    adapter: mockAuthAdapter(adapterOverrides),
  };
}

/** Build a minimal permissions state suitable for pluginState. */
function mockPermissionsState() {
  const grants: unknown[] = [];
  const adapter = {
    createGrant: (grant: unknown) => {
      grants.push(grant);
      return Promise.resolve(grant as never);
    },
    revokeGrant: () => Promise.resolve(),
    getGrantsForSubject: () => Promise.resolve([]),
    getEffectiveGrantsForSubject: () => Promise.resolve([]),
    listGrantHistory: () => Promise.resolve([]),
    listGrantsOnResource: () => Promise.resolve([]),
    deleteAllGrantsForSubject: () => Promise.resolve(),
  };
  const registry = {
    register: () => {},
    getActionsForRole: () => [],
    getDefinition: () => undefined,
    listResourceTypes: () => [],
  };
  const evaluator = {
    can: () => Promise.resolve(false),
  };
  return { adapter, registry, evaluator };
}

// ---------------------------------------------------------------------------
// createDeferredAdminProviders — bind and provider methods
// ---------------------------------------------------------------------------

describe('createDeferredAdminProviders', () => {
  it('returns deps and bind with no string strategies (no providers)', () => {
    const result = createDeferredAdminProviders({});
    expect(result.deps).toEqual([]);
    expect(typeof result.bind).toBe('function');
    expect(result.accessProvider).toBeUndefined();
    expect(result.managedUserProvider).toBeUndefined();
    expect(result.permissions).toBeUndefined();
    expect(result.auditLog).toBeUndefined();
  });

  it('adds accessProvider when accessProvider is "slingshot-auth"', () => {
    const result = createDeferredAdminProviders({ accessProvider: 'slingshot-auth' });
    expect(result.deps).toContain('slingshot-auth');
    expect(result.accessProvider).toBeDefined();
  });

  it('accessProvider.verifyRequest returns null when no userId (line 92)', async () => {
    const result = createDeferredAdminProviders({ accessProvider: 'slingshot-auth' });
    const c = mockContext({
      actor: Object.freeze({
        id: null,
        kind: 'anonymous' as const,
        tenantId: null,
        sessionId: null,
        roles: null,
        claims: {},
      }),
    });
    const principal = await result.accessProvider!.verifyRequest(c as never);
    expect(principal).toBeNull();
  });

  it('accessProvider.verifyRequest returns null when no super-admin role (lines 85-93)', async () => {
    const result = createDeferredAdminProviders({ accessProvider: 'slingshot-auth' });
    const c = mockContext({
      actor: Object.freeze({
        id: 'u1',
        kind: 'user' as const,
        tenantId: null,
        sessionId: null,
        roles: ['admin'],
        claims: {},
      }),
    });
    const principal = await result.accessProvider!.verifyRequest(c as never);
    expect(principal).toBeNull();
  });

  it('accessProvider.verifyRequest returns principal when userId and super-admin role (line 94)', async () => {
    const result = createDeferredAdminProviders({ accessProvider: 'slingshot-auth' });
    const c = mockContext({
      actor: Object.freeze({
        id: 'u1',
        kind: 'user' as const,
        tenantId: null,
        sessionId: null,
        roles: ['super-admin'],
        claims: {},
      }),
    });
    const principal = await result.accessProvider!.verifyRequest(c as never);
    expect(principal).not.toBeNull();
    expect(principal!.subject).toBe('u1');
    expect(principal!.provider).toBe('slingshot-auth');
  });

  it('accessProvider.verifyRequest handles non-array roles (line 88)', async () => {
    const result = createDeferredAdminProviders({ accessProvider: 'slingshot-auth' });
    const c = mockContext({
      actor: Object.freeze({
        id: 'u1',
        kind: 'user' as const,
        tenantId: null,
        sessionId: null,
        roles: 'not-an-array' as any,
        claims: {},
      }),
    });
    const principal = await result.accessProvider!.verifyRequest(c as never);
    expect(principal).toBeNull();
  });

  it('bind() sets authRuntime when accessProvider is slingshot-auth (lines 68-76)', () => {
    const result = createDeferredAdminProviders({ accessProvider: 'slingshot-auth' });
    const pluginState = new Map<string, unknown>();
    pluginState.set('slingshot-auth', mockAuthRuntime());
    // Should not throw
    result.bind(pluginState);
  });

  it('bind() sets authRuntime when managedUserProvider is slingshot-auth (lines 68-76)', () => {
    const result = createDeferredAdminProviders({ managedUserProvider: 'slingshot-auth' });
    const pluginState = new Map<string, unknown>();
    pluginState.set('slingshot-auth', mockAuthRuntime());
    result.bind(pluginState);
  });

  it('bind() sets permsState when permissions is slingshot-permissions (line 75-76)', () => {
    const result = createDeferredAdminProviders({ permissions: 'slingshot-permissions' });
    const pluginState = new Map<string, unknown>();
    pluginState.set('slingshot-permissions', mockPermissionsState());
    result.bind(pluginState);
  });

  it('adds managedUserProvider when managedUserProvider is "slingshot-auth"', () => {
    const result = createDeferredAdminProviders({ managedUserProvider: 'slingshot-auth' });
    expect(result.deps).toContain('slingshot-auth');
    expect(result.managedUserProvider).toBeDefined();
  });

  it('managedUserProvider throws when adapter not bound (requireAdapter, lines 102-108)', async () => {
    const result = createDeferredAdminProviders({ managedUserProvider: 'slingshot-auth' });
    // Do NOT call bind — adapter not bound
    await expect(result.managedUserProvider!.listUsers({})).rejects.toThrow(
      '[manifestAdminProviders] Auth runtime not bound.',
    );
  });

  it('managedUserProvider.listUsers returns empty when adapter.listUsers is absent', async () => {
    const result = createDeferredAdminProviders({ managedUserProvider: 'slingshot-auth' });
    const pluginState = new Map<string, unknown>();
    // adapter without listUsers
    pluginState.set('slingshot-auth', mockAuthRuntime({}));
    result.bind(pluginState);
    const listResult = await result.managedUserProvider!.listUsers({});
    expect(listResult.items).toEqual([]);
  });

  it('managedUserProvider.listUsers calls adapter.listUsers when present (lines 115-143)', async () => {
    const result = createDeferredAdminProviders({ managedUserProvider: 'slingshot-auth' });
    const pluginState = new Map<string, unknown>();
    const listUsersMock = async () => ({
      users: [
        {
          id: 'u1',
          email: 'a@b.com',
          displayName: 'A',
          firstName: 'A',
          lastName: 'B',
          externalId: null,
          suspended: false,
          userMetadata: { plan: 'free' },
        },
      ],
      totalResults: 1,
    });
    pluginState.set('slingshot-auth', mockAuthRuntime({ listUsers: listUsersMock }));
    result.bind(pluginState);
    const listResult = await result.managedUserProvider!.listUsers({ limit: 10 });
    expect(listResult.items).toHaveLength(1);
    expect(listResult.items[0].id).toBe('u1');
    expect(listResult.items[0].status).toBe('active');
    expect(listResult.items[0].metadata).toEqual({ plan: 'free' });
    expect(listResult.nextCursor).toBeUndefined();
  });

  it('managedUserProvider.listUsers sets nextCursor when more results remain', async () => {
    const result = createDeferredAdminProviders({ managedUserProvider: 'slingshot-auth' });
    const pluginState = new Map<string, unknown>();
    const users = Array.from({ length: 5 }, (_, i) => ({
      id: `u${i}`,
      email: `u${i}@b.com`,
      displayName: null,
      firstName: null,
      lastName: null,
      externalId: null,
      suspended: false,
      userMetadata: null,
    }));
    pluginState.set(
      'slingshot-auth',
      mockAuthRuntime({
        listUsers: async () => ({ users, totalResults: 100 }),
      }),
    );
    result.bind(pluginState);
    const listResult = await result.managedUserProvider!.listUsers({ limit: 5 });
    expect(listResult.nextCursor).toBe('5');
  });

  it('managedUserProvider.listUsers handles suspended status filter', async () => {
    const result = createDeferredAdminProviders({ managedUserProvider: 'slingshot-auth' });
    const pluginState = new Map<string, unknown>();
    let capturedQuery: unknown;
    pluginState.set(
      'slingshot-auth',
      mockAuthRuntime({
        listUsers: async (query: unknown) => {
          capturedQuery = query;
          return { users: [], totalResults: 0 };
        },
      }),
    );
    result.bind(pluginState);
    await result.managedUserProvider!.listUsers({ status: 'suspended' });
    expect((capturedQuery as Record<string, unknown>).suspended).toBe(true);

    await result.managedUserProvider!.listUsers({ status: 'active' });
    expect((capturedQuery as Record<string, unknown>).suspended).toBe(false);
  });

  it('managedUserProvider.listUsers handles cursor for pagination', async () => {
    const result = createDeferredAdminProviders({ managedUserProvider: 'slingshot-auth' });
    const pluginState = new Map<string, unknown>();
    let capturedQuery: unknown;
    pluginState.set(
      'slingshot-auth',
      mockAuthRuntime({
        listUsers: async (query: unknown) => {
          capturedQuery = query;
          return { users: [], totalResults: 0 };
        },
      }),
    );
    result.bind(pluginState);
    await result.managedUserProvider!.listUsers({ cursor: '10' });
    expect((capturedQuery as Record<string, unknown>).startIndex).toBe(10);
  });

  it('managedUserProvider.getUser returns null when adapter.getUser is absent (line 148)', async () => {
    const result = createDeferredAdminProviders({ managedUserProvider: 'slingshot-auth' });
    const pluginState = new Map<string, unknown>();
    pluginState.set('slingshot-auth', mockAuthRuntime({}));
    result.bind(pluginState);
    const user = await result.managedUserProvider!.getUser('u1');
    expect(user).toBeNull();
  });

  it('managedUserProvider.getUser returns null when user not found (line 150)', async () => {
    const result = createDeferredAdminProviders({ managedUserProvider: 'slingshot-auth' });
    const pluginState = new Map<string, unknown>();
    pluginState.set('slingshot-auth', mockAuthRuntime({ getUser: async () => null }));
    result.bind(pluginState);
    const user = await result.managedUserProvider!.getUser('u1');
    expect(user).toBeNull();
  });

  it('managedUserProvider.getUser returns mapped record (lines 151-161)', async () => {
    const result = createDeferredAdminProviders({ managedUserProvider: 'slingshot-auth' });
    const pluginState = new Map<string, unknown>();
    pluginState.set(
      'slingshot-auth',
      mockAuthRuntime({
        getUser: async () => ({
          email: 'a@b.com',
          displayName: 'A B',
          firstName: 'A',
          lastName: 'B',
          externalId: 'ext-1',
          suspended: true,
          userMetadata: null,
        }),
      }),
    );
    result.bind(pluginState);
    const user = await result.managedUserProvider!.getUser('u1');
    expect(user).not.toBeNull();
    expect(user!.id).toBe('u1');
    expect(user!.status).toBe('suspended');
    expect(user!.provider).toBe('slingshot-auth');
  });

  it('managedUserProvider.getCapabilities reflects adapter method presence (lines 164-177)', async () => {
    const result = createDeferredAdminProviders({ managedUserProvider: 'slingshot-auth' });
    const pluginState = new Map<string, unknown>();
    pluginState.set(
      'slingshot-auth',
      mockAuthRuntime({
        listUsers: async () => ({ users: [], totalResults: 0 }),
        getUser: async () => null,
        deleteUser: async () => {},
        setSuspended: async () => {},
        setUserMetadata: async () => {},
      }),
    );
    result.bind(pluginState);
    const caps = await result.managedUserProvider!.getCapabilities();
    expect(caps.canListUsers).toBe(true);
    expect(caps.canViewUser).toBe(true);
    expect(caps.canDeleteUsers).toBe(true);
    expect(caps.canSuspendUsers).toBe(true);
    expect(caps.canEditUser).toBe(true);
    expect(caps.canViewSessions).toBe(false);
    expect(caps.canManageRoles).toBe(false);
  });

  it('managedUserProvider.deleteUser throws when adapter.deleteUser is absent (lines 179-183)', async () => {
    const result = createDeferredAdminProviders({ managedUserProvider: 'slingshot-auth' });
    const pluginState = new Map<string, unknown>();
    pluginState.set('slingshot-auth', mockAuthRuntime({}));
    result.bind(pluginState);
    await expect(result.managedUserProvider!.deleteUser('u1')).rejects.toThrow(
      'does not support deleteUser',
    );
  });

  it('managedUserProvider.deleteUser calls adapter.deleteUser (line 184)', async () => {
    const result = createDeferredAdminProviders({ managedUserProvider: 'slingshot-auth' });
    const pluginState = new Map<string, unknown>();
    let deleted: string | undefined;
    pluginState.set(
      'slingshot-auth',
      mockAuthRuntime({
        deleteUser: async (id: string) => {
          deleted = id;
        },
      }),
    );
    result.bind(pluginState);
    await result.managedUserProvider!.deleteUser('u1');
    expect(deleted).toBe('u1');
  });

  it('adds permissions provider when permissions is "slingshot-permissions" (lines 189-251)', () => {
    const result = createDeferredAdminProviders({ permissions: 'slingshot-permissions' });
    expect(result.deps).toContain('slingshot-permissions');
    expect(result.permissions).toBeDefined();
    expect(result.permissions!.evaluator).toBeDefined();
    expect(result.permissions!.registry).toBeDefined();
    expect(result.permissions!.adapter).toBeDefined();
  });

  it('permissions.evaluator.can delegates to requirePerms (lines 192-198, 228-234)', async () => {
    const result = createDeferredAdminProviders({ permissions: 'slingshot-permissions' });
    // Without binding, requirePerms should throw (synchronously inside an async call)
    let threw = false;
    try {
      const subjectData = { id: 'u1', type: 'user' };
      const subject = subjectData as unknown as never;
      await result.permissions!.evaluator.can(subject, 'read');
    } catch (err) {
      threw = true;
      expect((err as Error).message).toContain(
        '[manifestAdminProviders] Permissions state not bound.',
      );
    }
    expect(threw).toBe(true);
  });

  it('permissions.evaluator.can works after bind (line 233)', async () => {
    const result = createDeferredAdminProviders({ permissions: 'slingshot-permissions' });
    const perms = mockPermissionsState();
    const pluginState = new Map<string, unknown>();
    pluginState.set('slingshot-permissions', perms);
    result.bind(pluginState);
    const canResult = await result.permissions!.evaluator.can({ id: 'u1', type: 'user' }, 'read');
    expect(typeof canResult).toBe('boolean');
  });

  it('permissions.registry methods delegate to requirePerms (lines 236-249)', async () => {
    const result = createDeferredAdminProviders({ permissions: 'slingshot-permissions' });
    const perms = mockPermissionsState();
    const pluginState = new Map<string, unknown>();
    pluginState.set('slingshot-permissions', perms);
    result.bind(pluginState);

    // register
    const defData = { resourceType: 'test', roles: {} };
    const def = defData as unknown as never;
    result.permissions!.registry.register(def);
    // getActionsForRole
    const actions = result.permissions!.registry.getActionsForRole('test', 'admin');
    expect(Array.isArray(actions)).toBe(true);
    // listResourceTypes
    const types = result.permissions!.registry.listResourceTypes();
    expect(Array.isArray(types)).toBe(true);
    // getDefinition
    const defResult = result.permissions!.registry.getDefinition('test');
    expect(defResult).toBeUndefined();
  });

  it('permissions.adapter methods delegate to requirePerms (lines 202-224)', async () => {
    const result = createDeferredAdminProviders({ permissions: 'slingshot-permissions' });
    const perms = mockPermissionsState();
    const pluginState = new Map<string, unknown>();
    pluginState.set('slingshot-permissions', perms);
    result.bind(pluginState);

    const adapter = result.permissions!.adapter;
    // All methods should delegate without throwing
    const grantData = { id: 'g1' };
    const grant = grantData as unknown as never;
    await adapter.createGrant(grant);
    await adapter.revokeGrant('g1', 'u1', null);
    await adapter.getGrantsForSubject('u1', 'user', null);
    await adapter.getEffectiveGrantsForSubject('u1', 'user', null);
    await adapter.listGrantHistory('u1', 'user');
    await adapter.listGrantsOnResource('resource', 'r1', null);
    const deleteSubjectData = { id: 'u1', type: 'user' };
    const deleteSubject = deleteSubjectData as unknown as never;
    await adapter.deleteAllGrantsForSubject(deleteSubject);
  });

  it('adds in-memory auditLog when auditLog is "memory"', () => {
    const result = createDeferredAdminProviders({ auditLog: 'memory' });
    expect(result.auditLog).toBeDefined();
    expect(typeof result.auditLog!.logEntry).toBe('function');
  });

  it('does not add slingshot-auth dep twice when both accessProvider and managedUserProvider are set', () => {
    const result = createDeferredAdminProviders({
      accessProvider: 'slingshot-auth',
      managedUserProvider: 'slingshot-auth',
    });
    const authDeps = result.deps.filter(d => d === 'slingshot-auth');
    expect(authDeps).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// In-memory audit log
// ---------------------------------------------------------------------------

describe('createInMemoryAuditLog', () => {
  it('stores and retrieves log entries', async () => {
    const log = createInMemoryAuditLog();

    const entryData = {
      userId: 'u1',
      action: 'user.suspend',
      path: '/admin/users/u2/suspend',
      method: 'POST',
      timestamp: new Date().toISOString(),
    };
    const entry = entryData as unknown as never;
    await log.logEntry(entry);

    const result = await log.getLogs({});
    expect(result.items).toHaveLength(1);
    expect(result.items[0].userId).toBe('u1');
  });

  it('filters by userId', async () => {
    const log = createInMemoryAuditLog();

    const e1Data = { userId: 'u1', action: 'a', path: '/a', method: 'GET' };
    const e1 = e1Data as unknown as never;
    const e2Data = { userId: 'u2', action: 'b', path: '/b', method: 'POST' };
    const e2 = e2Data as unknown as never;
    const e3Data = { userId: 'u1', action: 'c', path: '/c', method: 'PUT' };
    const e3 = e3Data as unknown as never;
    await log.logEntry(e1);
    await log.logEntry(e2);
    await log.logEntry(e3);

    const result = await log.getLogs({ userId: 'u1' });
    expect(result.items).toHaveLength(2);
    expect(result.items.every(e => e.userId === 'u1')).toBe(true);
  });

  it('filters by tenantId', async () => {
    const log = createInMemoryAuditLog();

    const t1EntryData = {
      userId: 'u1',
      action: 'a',
      path: '/a',
      method: 'GET',
      tenantId: 't1',
    };
    const t1Entry = t1EntryData as unknown as never;
    const t2EntryData = {
      userId: 'u1',
      action: 'b',
      path: '/b',
      method: 'GET',
      tenantId: 't2',
    };
    const t2Entry = t2EntryData as unknown as never;
    await log.logEntry(t1Entry);
    await log.logEntry(t2Entry);

    const result = await log.getLogs({ tenantId: 't1' });
    expect(result.items).toHaveLength(1);
    expect(result.items[0].tenantId).toBe('t1');
  });

  it('paginates with cursor', async () => {
    const log = createInMemoryAuditLog();

    for (let i = 0; i < 5; i++) {
      const pageEntryData = {
        userId: 'u1',
        action: `action_${i}`,
        path: `/path/${i}`,
        method: 'GET',
      };
      await log.logEntry(pageEntryData as unknown as never);
    }

    const page1 = await log.getLogs({ limit: 2 });
    expect(page1.items).toHaveLength(2);
    expect(page1.nextCursor).toBe('2');

    const page2 = await log.getLogs({ limit: 2, cursor: page1.nextCursor });
    expect(page2.items).toHaveLength(2);
    expect(page2.nextCursor).toBe('4');

    const page3 = await log.getLogs({ limit: 2, cursor: page2.nextCursor });
    expect(page3.items).toHaveLength(1);
    expect(page3.nextCursor).toBeUndefined();
  });

  it('filters by path and method', async () => {
    const log = createInMemoryAuditLog();

    const pathEntry1Data = { userId: 'u1', action: 'a', path: '/admin/users', method: 'GET' };
    const pathEntry1 = pathEntry1Data as unknown as never;
    const pathEntry2Data = {
      userId: 'u1',
      action: 'b',
      path: '/admin/users',
      method: 'DELETE',
    };
    const pathEntry2 = pathEntry2Data as unknown as never;
    const pathEntry3Data = { userId: 'u1', action: 'c', path: '/admin/roles', method: 'GET' };
    const pathEntry3 = pathEntry3Data as unknown as never;
    await log.logEntry(pathEntry1);
    await log.logEntry(pathEntry2);
    await log.logEntry(pathEntry3);

    const byPath = await log.getLogs({ path: '/admin/users' });
    expect(byPath.items).toHaveLength(2);

    const byMethod = await log.getLogs({ method: 'DELETE' });
    expect(byMethod.items).toHaveLength(1);
  });

  it('returns empty items when no entries match', async () => {
    const log = createInMemoryAuditLog();
    const result = await log.getLogs({ userId: 'nonexistent' });
    expect(result.items).toEqual([]);
    expect(result.nextCursor).toBeUndefined();
  });
});
