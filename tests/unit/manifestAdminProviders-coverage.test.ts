/**
 * Coverage tests for src/lib/manifestAdminProviders.ts
 *
 * Targets uncovered lines: 75, 84-92, 101-107, 112-159, 163-182, 191-197, 202-242
 */
import { describe, expect, mock, test } from 'bun:test';
import {
  createDeferredAdminProviders,
  createInMemoryAuditLog,
} from '../../src/lib/manifestAdminProviders';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mockContext(vars: Record<string, unknown>) {
  return { get: (key: string) => vars[key] };
}

function mockAuthRuntime(adapterOverrides: Record<string, unknown> = {}) {
  return { adapter: { ...adapterOverrides } };
}

function mockPermissionsState() {
  const grants: unknown[] = [];
  return {
    adapter: {
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
    },
    registry: {
      register: () => {},
      getActionsForRole: () => ['read', 'write'],
      getDefinition: (rt: string) => (rt === 'known' ? { resourceType: 'known' } : undefined),
      listResourceTypes: () => ['known'],
    },
    evaluator: {
      can: () => Promise.resolve(true),
    },
  };
}

// ---------------------------------------------------------------------------
// Top-level shape
// ---------------------------------------------------------------------------

describe('createDeferredAdminProviders — coverage', () => {
  test('returns empty deps and no providers with empty config', () => {
    const result = createDeferredAdminProviders({});
    expect(result.deps).toEqual([]);
    expect(result.accessProvider).toBeUndefined();
    expect(result.managedUserProvider).toBeUndefined();
    expect(result.permissions).toBeUndefined();
    expect(result.auditLog).toBeUndefined();
  });

  // -----------------------------------------------------------------------
  // bind — line 75 (permissions branch)
  // -----------------------------------------------------------------------
  test('bind resolves permissions state when config.permissions is slingshot-permissions', () => {
    const result = createDeferredAdminProviders({ permissions: 'slingshot-permissions' });
    const pluginState = new Map<string, unknown>();
    pluginState.set('slingshot-permissions', mockPermissionsState());
    // Should not throw; exercises line 75
    result.bind(pluginState);
  });

  test('bind resolves auth runtime for both accessProvider and managedUserProvider configs', () => {
    const result = createDeferredAdminProviders({
      accessProvider: 'slingshot-auth',
      managedUserProvider: 'slingshot-auth',
    });
    const pluginState = new Map<string, unknown>();
    pluginState.set('slingshot-auth', mockAuthRuntime());
    result.bind(pluginState);
    // slingshot-auth should appear only once in deps
    expect(result.deps.filter(d => d === 'slingshot-auth')).toHaveLength(1);
  });

  // -----------------------------------------------------------------------
  // accessProvider.verifyRequest — lines 84-94
  // -----------------------------------------------------------------------
  test('verifyRequest returns null when actor id is not a string', async () => {
    const result = createDeferredAdminProviders({ accessProvider: 'slingshot-auth' });
    const c = mockContext({
      actor: Object.freeze({
        id: null,
        kind: 'anonymous' as const,
        tenantId: null,
        sessionId: null,
        roles: ['super-admin'],
        claims: {},
      }),
    });
    expect(await result.accessProvider!.verifyRequest(c as never)).toBeNull();
  });

  test('verifyRequest returns null when roles is not an array', async () => {
    const result = createDeferredAdminProviders({ accessProvider: 'slingshot-auth' });
    const c = mockContext({
      actor: Object.freeze({
        id: 'u1',
        kind: 'user' as const,
        tenantId: null,
        sessionId: null,
        roles: 'not-array' as any,
        claims: {},
      }),
    });
    expect(await result.accessProvider!.verifyRequest(c as never)).toBeNull();
  });

  test('verifyRequest returns null when roles lacks super-admin', async () => {
    const result = createDeferredAdminProviders({ accessProvider: 'slingshot-auth' });
    const c = mockContext({
      actor: Object.freeze({
        id: 'u1',
        kind: 'user' as const,
        tenantId: null,
        sessionId: null,
        roles: ['editor'],
        claims: {},
      }),
    });
    expect(await result.accessProvider!.verifyRequest(c as never)).toBeNull();
  });

  test('verifyRequest filters non-string role values', async () => {
    const result = createDeferredAdminProviders({ accessProvider: 'slingshot-auth' });
    const c = mockContext({
      actor: Object.freeze({
        id: 'u1',
        kind: 'user' as const,
        tenantId: null,
        sessionId: null,
        roles: [42, 'super-admin', null] as any,
        claims: {},
      }),
    });
    const principal = await result.accessProvider!.verifyRequest(c as never);
    expect(principal).not.toBeNull();
    expect(principal!.subject).toBe('u1');
    expect(principal!.roles).toEqual(['super-admin']);
    expect(principal!.provider).toBe('slingshot-auth');
  });

  test('verifyRequest returns principal for valid super-admin user', async () => {
    const result = createDeferredAdminProviders({ accessProvider: 'slingshot-auth' });
    const c = mockContext({
      actor: Object.freeze({
        id: 'admin-1',
        kind: 'user' as const,
        tenantId: null,
        sessionId: null,
        roles: ['super-admin', 'editor'],
        claims: {},
      }),
    });
    const principal = await result.accessProvider!.verifyRequest(c as never);
    expect(principal).toEqual({
      subject: 'admin-1',
      roles: ['super-admin', 'editor'],
      provider: 'slingshot-auth',
    });
  });

  // -----------------------------------------------------------------------
  // requireAdapter (lines 101-108) — called by managedUserProvider methods
  // -----------------------------------------------------------------------
  test('managedUserProvider methods throw when auth runtime is not bound', async () => {
    const result = createDeferredAdminProviders({ managedUserProvider: 'slingshot-auth' });
    // Do NOT call bind
    await expect(result.managedUserProvider!.listUsers({})).rejects.toThrow(
      'Auth runtime not bound',
    );
    await expect(result.managedUserProvider!.getUser('u1')).rejects.toThrow(
      'Auth runtime not bound',
    );
    // getCapabilities throws synchronously from requireAdapter before returning a promise
    expect(() => result.managedUserProvider!.getCapabilities()).toThrow('Auth runtime not bound');
    await expect(result.managedUserProvider!.deleteUser('u1')).rejects.toThrow(
      'Auth runtime not bound',
    );
  });

  // -----------------------------------------------------------------------
  // managedUserProvider.listUsers — lines 114-143
  // -----------------------------------------------------------------------
  test('listUsers returns empty items when adapter.listUsers is undefined', async () => {
    const result = createDeferredAdminProviders({ managedUserProvider: 'slingshot-auth' });
    const pluginState = new Map<string, unknown>();
    pluginState.set('slingshot-auth', mockAuthRuntime({}));
    result.bind(pluginState);
    const list = await result.managedUserProvider!.listUsers({});
    expect(list.items).toEqual([]);
  });

  test('listUsers maps adapter users to ManagedUserRecord', async () => {
    const listUsers = mock(async () => ({
      users: [
        {
          id: 'u1',
          email: 'alice@example.com',
          displayName: 'Alice',
          firstName: 'Alice',
          lastName: 'Smith',
          externalId: 'ext-1',
          suspended: false,
          userMetadata: { plan: 'pro' },
        },
        {
          id: 'u2',
          email: 'bob@example.com',
          displayName: null,
          firstName: null,
          lastName: null,
          externalId: null,
          suspended: true,
          userMetadata: null,
        },
      ],
      totalResults: 2,
    }));
    const result = createDeferredAdminProviders({ managedUserProvider: 'slingshot-auth' });
    const pluginState = new Map<string, unknown>();
    pluginState.set('slingshot-auth', mockAuthRuntime({ listUsers }));
    result.bind(pluginState);

    const list = await result.managedUserProvider!.listUsers({ limit: 10 });
    expect(list.items).toHaveLength(2);
    expect(list.items[0]).toMatchObject({
      id: 'u1',
      email: 'alice@example.com',
      status: 'active',
      provider: 'slingshot-auth',
      metadata: { plan: 'pro' },
    });
    expect(list.items[1]).toMatchObject({
      id: 'u2',
      status: 'suspended',
    });
    expect(list.nextCursor).toBeUndefined();
  });

  test('listUsers computes nextCursor when more results exist', async () => {
    const listUsers = mock(async () => ({
      users: [{ id: 'u0', email: 'a@b.com', suspended: false }],
      totalResults: 50,
    }));
    const result = createDeferredAdminProviders({ managedUserProvider: 'slingshot-auth' });
    const pluginState = new Map<string, unknown>();
    pluginState.set('slingshot-auth', mockAuthRuntime({ listUsers }));
    result.bind(pluginState);

    const list = await result.managedUserProvider!.listUsers({ limit: 10 });
    expect(list.nextCursor).toBe('10');
  });

  test('listUsers parses cursor as startIndex', async () => {
    let capturedQuery: any;
    const listUsers = mock(async (q: any) => {
      capturedQuery = q;
      return { users: [], totalResults: 0 };
    });
    const result = createDeferredAdminProviders({ managedUserProvider: 'slingshot-auth' });
    const pluginState = new Map<string, unknown>();
    pluginState.set('slingshot-auth', mockAuthRuntime({ listUsers }));
    result.bind(pluginState);

    await result.managedUserProvider!.listUsers({ cursor: '20', limit: 5 });
    expect(capturedQuery.startIndex).toBe(20);
    expect(capturedQuery.count).toBe(5);
  });

  test('listUsers passes search as email filter', async () => {
    let capturedQuery: any;
    const listUsers = mock(async (q: any) => {
      capturedQuery = q;
      return { users: [], totalResults: 0 };
    });
    const result = createDeferredAdminProviders({ managedUserProvider: 'slingshot-auth' });
    const pluginState = new Map<string, unknown>();
    pluginState.set('slingshot-auth', mockAuthRuntime({ listUsers }));
    result.bind(pluginState);

    await result.managedUserProvider!.listUsers({ search: 'alice@example.com' });
    expect(capturedQuery.email).toBe('alice@example.com');
  });

  test('listUsers maps status filter to suspended boolean', async () => {
    let capturedQuery: any;
    const listUsers = mock(async (q: any) => {
      capturedQuery = q;
      return { users: [], totalResults: 0 };
    });
    const result = createDeferredAdminProviders({ managedUserProvider: 'slingshot-auth' });
    const pluginState = new Map<string, unknown>();
    pluginState.set('slingshot-auth', mockAuthRuntime({ listUsers }));
    result.bind(pluginState);

    await result.managedUserProvider!.listUsers({ status: 'suspended' });
    expect(capturedQuery.suspended).toBe(true);

    await result.managedUserProvider!.listUsers({ status: 'active' });
    expect(capturedQuery.suspended).toBe(false);

    await result.managedUserProvider!.listUsers({});
    expect(capturedQuery.suspended).toBeUndefined();
  });

  // -----------------------------------------------------------------------
  // managedUserProvider.getUser — lines 145-161
  // -----------------------------------------------------------------------
  test('getUser returns null when adapter.getUser is missing', async () => {
    const result = createDeferredAdminProviders({ managedUserProvider: 'slingshot-auth' });
    const pluginState = new Map<string, unknown>();
    pluginState.set('slingshot-auth', mockAuthRuntime({}));
    result.bind(pluginState);
    expect(await result.managedUserProvider!.getUser('u1')).toBeNull();
  });

  test('getUser returns null when adapter.getUser returns null', async () => {
    const result = createDeferredAdminProviders({ managedUserProvider: 'slingshot-auth' });
    const pluginState = new Map<string, unknown>();
    pluginState.set('slingshot-auth', mockAuthRuntime({ getUser: async () => null }));
    result.bind(pluginState);
    expect(await result.managedUserProvider!.getUser('u1')).toBeNull();
  });

  test('getUser returns mapped ManagedUserRecord', async () => {
    const result = createDeferredAdminProviders({ managedUserProvider: 'slingshot-auth' });
    const pluginState = new Map<string, unknown>();
    pluginState.set(
      'slingshot-auth',
      mockAuthRuntime({
        getUser: async () => ({
          email: 'bob@example.com',
          displayName: 'Bob',
          firstName: 'Bob',
          lastName: 'Jones',
          externalId: 'ext-bob',
          suspended: true,
          userMetadata: { role: 'viewer' },
        }),
      }),
    );
    result.bind(pluginState);
    const user = await result.managedUserProvider!.getUser('bob-id');
    expect(user).toEqual({
      id: 'bob-id',
      email: 'bob@example.com',
      displayName: 'Bob',
      firstName: 'Bob',
      lastName: 'Jones',
      externalId: 'ext-bob',
      status: 'suspended',
      provider: 'slingshot-auth',
      metadata: { role: 'viewer' },
    });
  });

  // -----------------------------------------------------------------------
  // managedUserProvider.getCapabilities — lines 163-176
  // -----------------------------------------------------------------------
  test('getCapabilities returns true for methods present on the adapter', async () => {
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
    expect(caps).toEqual({
      canListUsers: true,
      canSearchUsers: true,
      canViewUser: true,
      canDeleteUsers: true,
      canSuspendUsers: true,
      canEditUser: true,
      canViewSessions: false,
      canRevokeSessions: false,
      canManageRoles: false,
    });
  });

  test('getCapabilities returns false for missing adapter methods', async () => {
    const result = createDeferredAdminProviders({ managedUserProvider: 'slingshot-auth' });
    const pluginState = new Map<string, unknown>();
    pluginState.set('slingshot-auth', mockAuthRuntime({}));
    result.bind(pluginState);
    const caps = await result.managedUserProvider!.getCapabilities();
    expect(caps.canListUsers).toBe(false);
    expect(caps.canViewUser).toBe(false);
    expect(caps.canDeleteUsers).toBe(false);
    expect(caps.canSuspendUsers).toBe(false);
    expect(caps.canEditUser).toBe(false);
  });

  // -----------------------------------------------------------------------
  // managedUserProvider.deleteUser — lines 178-184
  // -----------------------------------------------------------------------
  test('deleteUser throws when adapter.deleteUser is not defined', async () => {
    const result = createDeferredAdminProviders({ managedUserProvider: 'slingshot-auth' });
    const pluginState = new Map<string, unknown>();
    pluginState.set('slingshot-auth', mockAuthRuntime({}));
    result.bind(pluginState);
    await expect(result.managedUserProvider!.deleteUser('u1')).rejects.toThrow(
      'does not support deleteUser',
    );
  });

  test('deleteUser calls adapter.deleteUser with the user id', async () => {
    const deleteFn = mock(async () => {});
    const result = createDeferredAdminProviders({ managedUserProvider: 'slingshot-auth' });
    const pluginState = new Map<string, unknown>();
    pluginState.set('slingshot-auth', mockAuthRuntime({ deleteUser: deleteFn }));
    result.bind(pluginState);
    await result.managedUserProvider!.deleteUser('user-42');
    expect(deleteFn).toHaveBeenCalledWith('user-42');
  });

  // -----------------------------------------------------------------------
  // requirePerms (lines 191-198) — permissions methods throw without bind
  // -----------------------------------------------------------------------
  test('permissions.evaluator.can throws when perms state is not bound', () => {
    const result = createDeferredAdminProviders({ permissions: 'slingshot-permissions' });
    // Do NOT call bind — requirePerms throws synchronously
    expect(() => result.permissions!.evaluator.can({ id: 'u1', type: 'user' }, 'read')).toThrow(
      'Permissions state not bound',
    );
  });

  test('permissions.registry.getActionsForRole throws when perms state is not bound', () => {
    const result = createDeferredAdminProviders({ permissions: 'slingshot-permissions' });
    expect(() => result.permissions!.registry.getActionsForRole('res', 'admin')).toThrow(
      'Permissions state not bound',
    );
  });

  // -----------------------------------------------------------------------
  // permissions adapter delegation — lines 202-223
  // -----------------------------------------------------------------------
  test('permissions.adapter methods delegate to the real adapter after bind', async () => {
    const perms = mockPermissionsState();
    const createGrantSpy = mock(perms.adapter.createGrant);
    const revokeGrantSpy = mock(perms.adapter.revokeGrant);
    const getGrantsSpy = mock(perms.adapter.getGrantsForSubject);
    const getEffectiveSpy = mock(perms.adapter.getEffectiveGrantsForSubject);
    const listHistorySpy = mock(perms.adapter.listGrantHistory);
    const listResourceSpy = mock(perms.adapter.listGrantsOnResource);
    const deleteAllSpy = mock(perms.adapter.deleteAllGrantsForSubject);

    perms.adapter.createGrant = createGrantSpy;
    perms.adapter.revokeGrant = revokeGrantSpy;
    perms.adapter.getGrantsForSubject = getGrantsSpy;
    perms.adapter.getEffectiveGrantsForSubject = getEffectiveSpy;
    perms.adapter.listGrantHistory = listHistorySpy;
    perms.adapter.listGrantsOnResource = listResourceSpy;
    perms.adapter.deleteAllGrantsForSubject = deleteAllSpy;

    const result = createDeferredAdminProviders({ permissions: 'slingshot-permissions' });
    const pluginState = new Map<string, unknown>();
    pluginState.set('slingshot-permissions', perms);
    result.bind(pluginState);

    const adapter = result.permissions!.adapter;
    const grantData = { id: 'g1' };
    const grant = grantData as unknown as never;
    await adapter.createGrant(grant);
    expect(createGrantSpy).toHaveBeenCalledWith(grant);

    await adapter.revokeGrant('g1', 'u1', null);
    expect(revokeGrantSpy).toHaveBeenCalledWith('g1', 'u1', null);

    await adapter.getGrantsForSubject('u1', 'user', null);
    expect(getGrantsSpy).toHaveBeenCalledWith('u1', 'user', null);

    await adapter.getEffectiveGrantsForSubject('u1', 'user', null);
    expect(getEffectiveSpy).toHaveBeenCalledWith('u1', 'user', null);

    await adapter.listGrantHistory('u1', 'user');
    expect(listHistorySpy).toHaveBeenCalledWith('u1', 'user');

    await adapter.listGrantsOnResource('posts', 'post-1', 'tenant-1');
    expect(listResourceSpy).toHaveBeenCalledWith('posts', 'post-1', 'tenant-1');

    const deleteSubjectData = { id: 'u1', type: 'user' };
    await adapter.deleteAllGrantsForSubject(deleteSubjectData as unknown as never);
    expect(deleteAllSpy).toHaveBeenCalled();
  });

  // -----------------------------------------------------------------------
  // permissions evaluator and registry delegation — lines 226-248
  // -----------------------------------------------------------------------
  test('permissions.evaluator.can delegates to real evaluator after bind', async () => {
    const perms = mockPermissionsState();
    const canSpy = mock(perms.evaluator.can);
    perms.evaluator.can = canSpy;

    const result = createDeferredAdminProviders({ permissions: 'slingshot-permissions' });
    const pluginState = new Map<string, unknown>();
    pluginState.set('slingshot-permissions', perms);
    result.bind(pluginState);

    const allowed = await result.permissions!.evaluator.can({ id: 'u1', type: 'user' }, 'write', {
      tenantId: 't1',
    });
    expect(allowed).toBe(true);
    expect(canSpy).toHaveBeenCalledWith({ id: 'u1', type: 'user' }, 'write', { tenantId: 't1' });
  });

  test('permissions.registry.register delegates to real registry after bind', () => {
    const perms = mockPermissionsState();
    const registerSpy = mock(perms.registry.register);
    perms.registry.register = registerSpy;

    const result = createDeferredAdminProviders({ permissions: 'slingshot-permissions' });
    const pluginState = new Map<string, unknown>();
    pluginState.set('slingshot-permissions', perms);
    result.bind(pluginState);

    const definitionData = { resourceType: 'test', roles: {} };
    const definition = definitionData as unknown as never;
    result.permissions!.registry.register(definition);
    expect(registerSpy).toHaveBeenCalledWith(definition);
  });

  test('permissions.registry.getActionsForRole delegates after bind', () => {
    const result = createDeferredAdminProviders({ permissions: 'slingshot-permissions' });
    const perms = mockPermissionsState();
    const pluginState = new Map<string, unknown>();
    pluginState.set('slingshot-permissions', perms);
    result.bind(pluginState);

    const actions = result.permissions!.registry.getActionsForRole('known', 'admin');
    expect(actions).toEqual(['read', 'write']);
  });

  test('permissions.registry.getDefinition delegates after bind', () => {
    const result = createDeferredAdminProviders({ permissions: 'slingshot-permissions' });
    const perms = mockPermissionsState();
    const pluginState = new Map<string, unknown>();
    pluginState.set('slingshot-permissions', perms);
    result.bind(pluginState);

    const def = result.permissions!.registry.getDefinition('known');
    expect(def).toEqual({ resourceType: 'known' });
    expect(result.permissions!.registry.getDefinition('unknown')).toBeUndefined();
  });

  test('permissions.registry.listResourceTypes delegates after bind', () => {
    const result = createDeferredAdminProviders({ permissions: 'slingshot-permissions' });
    const perms = mockPermissionsState();
    const pluginState = new Map<string, unknown>();
    pluginState.set('slingshot-permissions', perms);
    result.bind(pluginState);

    expect(result.permissions!.registry.listResourceTypes()).toEqual(['known']);
  });

  // -----------------------------------------------------------------------
  // auditLog memory provider
  // -----------------------------------------------------------------------
  test('config auditLog=memory creates in-memory audit log', () => {
    const result = createDeferredAdminProviders({ auditLog: 'memory' });
    expect(result.auditLog).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// createInMemoryAuditLog — additional coverage
// ---------------------------------------------------------------------------

describe('createInMemoryAuditLog — coverage', () => {
  test('stores and retrieves entries with all filter combinations', async () => {
    const log = createInMemoryAuditLog();
    const entryData = {
      userId: 'u1',
      action: 'create',
      path: '/api/items',
      method: 'POST',
      requestTenantId: 't1',
      timestamp: new Date().toISOString(),
    };
    const entry = entryData as unknown as never;
    await log.logEntry(entry);

    const byPath = await log.getLogs({ path: '/api/items' });
    expect(byPath.items).toHaveLength(1);

    const byMethod = await log.getLogs({ method: 'POST' });
    expect(byMethod.items).toHaveLength(1);

    const byTenant = await log.getLogs({ requestTenantId: 't1' });
    expect(byTenant.items).toHaveLength(1);

    const noMatch = await log.getLogs({ userId: 'nonexistent' });
    expect(noMatch.items).toHaveLength(0);
  });

  test('paginates correctly with cursor', async () => {
    const log = createInMemoryAuditLog();
    for (let i = 0; i < 7; i++) {
      const pageEntryData = {
        userId: 'u1',
        action: `action-${i}`,
        path: `/path/${i}`,
        method: 'GET',
      };
      await log.logEntry(pageEntryData as unknown as never);
    }

    const page1 = await log.getLogs({ limit: 3 });
    expect(page1.items).toHaveLength(3);
    expect(page1.nextCursor).toBe('3');

    const page2 = await log.getLogs({ limit: 3, cursor: page1.nextCursor });
    expect(page2.items).toHaveLength(3);
    expect(page2.nextCursor).toBe('6');

    const page3 = await log.getLogs({ limit: 3, cursor: page2.nextCursor });
    expect(page3.items).toHaveLength(1);
    expect(page3.nextCursor).toBeUndefined();
  });
});
