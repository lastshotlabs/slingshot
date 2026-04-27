import type {
  AdminAccessProvider,
  AdminPrincipal,
  ListUsersInput,
  ListUsersResult,
  ManagedUserCapabilities,
  ManagedUserProvider,
  ManagedUserRecord,
  ManagedUserScope,
  SessionRecord,
  SuspendUserInput,
  UnsuspendUserInput,
  UpdateUserInput,
} from '@lastshotlabs/slingshot-core';

// ---------------------------------------------------------------------------
// MemoryAccessProvider
// ---------------------------------------------------------------------------

/**
 * In-memory `AdminAccessProvider` for use in tests.
 *
 * Returns a fixed principal for every request by default, bypassing any real
 * JWT verification. Pass `unauthenticated: true` to simulate a rejected request
 * (the provider returns `null`, and the admin middleware responds with 401).
 *
 * @param options.principal - The principal to return on every verified request.
 *   Defaults to `{ subject: 'test-admin', email: 'admin@test.local', ... }`.
 * @param options.unauthenticated - When `true`, `verifyRequest` always returns
 *   `null`, simulating an unauthenticated caller.
 * @returns An `AdminAccessProvider` backed purely by in-memory state.
 *
 * @example
 * ```ts
 * import { createMemoryAccessProvider } from '@lastshotlabs/slingshot-admin/testing';
 *
 * const access = createMemoryAccessProvider({ unauthenticated: false });
 * // Returns a fixed test principal on every call
 * ```
 */
export function createMemoryAccessProvider(options?: {
  principal?: AdminPrincipal;
  unauthenticated?: boolean;
}): AdminAccessProvider {
  const principal: AdminPrincipal = options?.principal ?? {
    subject: 'test-admin',
    email: 'admin@test.local',
    displayName: 'Test Admin',
    provider: 'memory',
  };
  return {
    name: 'memory',
    verifyRequest() {
      if (options?.unauthenticated) return Promise.resolve(null);
      return Promise.resolve(principal);
    },
  };
}

// ---------------------------------------------------------------------------
// MemoryManagedUserProvider
// ---------------------------------------------------------------------------

/**
 * Extended `ManagedUserProvider` returned by `createMemoryManagedUserProvider`.
 *
 * All optional `ManagedUserProvider` methods are declared required here — the
 * memory implementation always supports every operation. This makes test code
 * simpler: no capability checks or optional-chaining required.
 *
 * Three additional test-utility methods are provided:
 * - `seedUser` — insert a user record
 * - `seedSession` — insert a session record
 * - `clear` — wipe all state between tests
 */
export interface MemoryManagedUserProvider extends ManagedUserProvider {
  // Override optional ManagedUserProvider methods as required
  searchUsers(query: string, input?: Omit<ListUsersInput, 'search'>): Promise<ListUsersResult>;
  suspendUser(input: SuspendUserInput): Promise<void>;
  unsuspendUser(input: UnsuspendUserInput): Promise<void>;
  updateUser(input: UpdateUserInput): Promise<ManagedUserRecord | null>;
  deleteUser(userId: string, scope?: ManagedUserScope): Promise<void>;
  listSessions(userId: string, scope?: ManagedUserScope): Promise<SessionRecord[]>;
  revokeSession(sessionId: string, scope?: ManagedUserScope): Promise<void>;
  revokeAllSessions(userId: string, scope?: ManagedUserScope): Promise<void>;
  getRoles(userId: string, scope?: ManagedUserScope): Promise<string[]>;
  setRoles(userId: string, roles: string[], scope?: ManagedUserScope): Promise<void>;

  /**
   * Insert a user record into the in-memory store.
   * @param user - The full `ManagedUserRecord` to add, including its `id`.
   */
  seedUser(user: ManagedUserRecord): void;
  /**
   * Insert a session record into the in-memory store.
   * @param session - The full `SessionRecord` to add, including its `sessionId`.
   */
  seedSession(session: SessionRecord): void;
  /**
   * Wipe all state: users, sessions, and role assignments.
   * Call this in `afterEach` to prevent cross-test contamination.
   */
  clear(): void;
}

/**
 * Creates an in-memory `ManagedUserProvider` for testing admin user-management
 * routes without a real auth backend.
 *
 * All optional `ManagedUserProvider` methods are implemented so tests can
 * exercise every admin operation (list, search, suspend, delete, roles,
 * sessions). State is closure-private — create a fresh instance per test suite
 * and call `clear()` in `afterEach` to prevent leakage.
 *
 * @returns A `MemoryManagedUserProvider` with seed / clear helpers.
 *
 * @example
 * ```ts
 * import {
 *   createMemoryManagedUserProvider,
 * } from '@lastshotlabs/slingshot-admin/testing';
 *
 * const provider = createMemoryManagedUserProvider();
 * provider.seedUser({ id: 'u1', email: 'alice@example.com', status: 'active' });
 *
 * const result = await provider.listUsers({ limit: 10 });
 * // result.items => [{ id: 'u1', ... }]
 *
 * provider.clear(); // run in afterEach
 * ```
 */
export function createMemoryManagedUserProvider(): MemoryManagedUserProvider {
  const users = new Map<string, ManagedUserRecord>();
  const sessions = new Map<string, SessionRecord>();
  const roles = new Map<string, string[]>();

  function listUsers(input: ListUsersInput): Promise<ListUsersResult> {
    let items = Array.from(users.values());
    if (input.tenantId) items = items.filter(u => u.tenantId === input.tenantId);
    if (input.status) items = items.filter(u => u.status === input.status);
    if (input.role) {
      const role = input.role;
      items = items.filter(u => u.roles?.includes(role));
    }
    if (input.search) {
      const q = input.search.toLowerCase();
      items = items.filter(
        u => u.email?.toLowerCase().includes(q) || u.displayName?.toLowerCase().includes(q),
      );
    }
    const limit = input.limit ?? 20;
    const startIdx = input.cursor ? items.findIndex(u => u.id === input.cursor) + 1 : 0;
    const page = items.slice(startIdx, startIdx + limit);
    const nextCursor = page.length === limit ? page[page.length - 1]?.id : undefined;
    return Promise.resolve({ items: page, nextCursor });
  }

  return {
    name: 'memory',

    seedUser(user: ManagedUserRecord): void {
      users.set(user.id, user);
    },

    seedSession(session: SessionRecord): void {
      sessions.set(session.sessionId, session);
    },

    clear(): void {
      users.clear();
      sessions.clear();
      roles.clear();
    },

    listUsers,

    getUser(userId: string, scope?): Promise<ManagedUserRecord | null> {
      const user = users.get(userId) ?? null;
      if (!user) return Promise.resolve(null);
      if (scope?.tenantId && user.tenantId !== scope.tenantId) return Promise.resolve(null);
      return Promise.resolve(user);
    },

    searchUsers(
      query: string,
      input: Omit<ListUsersInput, 'search'> = {},
    ): Promise<ListUsersResult> {
      return listUsers({ ...input, search: query });
    },

    getCapabilities(): Promise<ManagedUserCapabilities> {
      return Promise.resolve({
        canListUsers: true,
        canSearchUsers: true,
        canViewUser: true,
        canEditUser: true,
        canSuspendUsers: true,
        canDeleteUsers: true,
        canViewSessions: true,
        canRevokeSessions: true,
        canManageRoles: true,
      });
    },

    suspendUser(input: SuspendUserInput): Promise<void> {
      const user = users.get(input.userId);
      if (!user) return Promise.resolve();
      if (input.tenantId && user.tenantId !== input.tenantId) return Promise.resolve();
      users.set(input.userId, { ...user, status: 'suspended' });
      return Promise.resolve();
    },

    unsuspendUser(input: UnsuspendUserInput): Promise<void> {
      const user = users.get(input.userId);
      if (!user) return Promise.resolve();
      if (input.tenantId && user.tenantId !== input.tenantId) return Promise.resolve();
      users.set(input.userId, { ...user, status: 'active' });
      return Promise.resolve();
    },

    updateUser(input: UpdateUserInput): Promise<ManagedUserRecord | null> {
      const user = users.get(input.userId);
      if (!user) return Promise.resolve(null);
      if (input.tenantId && user.tenantId !== input.tenantId) return Promise.resolve(null);
      const updated: ManagedUserRecord = {
        ...user,
        ...(input.displayName !== undefined && { displayName: input.displayName }),
        ...(input.firstName !== undefined && { firstName: input.firstName }),
        ...(input.lastName !== undefined && { lastName: input.lastName }),
        ...(input.externalId !== undefined && { externalId: input.externalId }),
      };
      users.set(input.userId, updated);
      return Promise.resolve(updated);
    },

    deleteUser(userId: string, scope?): Promise<void> {
      const user = users.get(userId);
      if (!user) return Promise.resolve();
      if (scope?.tenantId && user.tenantId !== scope.tenantId) return Promise.resolve();
      users.delete(userId);
      for (const [id, s] of sessions) {
        if (s.userId === userId) sessions.delete(id);
      }
      roles.delete(userId);
      return Promise.resolve();
    },

    listSessions(userId: string, scope?): Promise<SessionRecord[]> {
      const user = users.get(userId);
      if (!user) return Promise.resolve([]);
      if (scope?.tenantId && user.tenantId !== scope.tenantId) return Promise.resolve([]);
      return Promise.resolve(Array.from(sessions.values()).filter(s => s.userId === userId));
    },

    revokeSession(sessionId: string, scope?): Promise<void> {
      if (scope?.tenantId) {
        const session = sessions.get(sessionId);
        if (!session) return Promise.resolve();
        const user = users.get(session.userId);
        if (!user || user.tenantId !== scope.tenantId) return Promise.resolve();
      }
      sessions.delete(sessionId);
      return Promise.resolve();
    },

    revokeAllSessions(userId: string, scope?): Promise<void> {
      const user = users.get(userId);
      if (!user) return Promise.resolve();
      if (scope?.tenantId && user.tenantId !== scope.tenantId) return Promise.resolve();
      for (const [id, s] of sessions) {
        if (s.userId === userId) sessions.delete(id);
      }
      return Promise.resolve();
    },

    getRoles(userId: string, scope?): Promise<string[]> {
      const user = users.get(userId);
      if (!user) return Promise.resolve([]);
      if (scope?.tenantId && user.tenantId !== scope.tenantId) return Promise.resolve([]);
      return Promise.resolve(roles.get(userId) ?? []);
    },

    setRoles(userId: string, newRoles: string[], scope?): Promise<void> {
      const user = users.get(userId);
      if (!user) return Promise.resolve();
      if (scope?.tenantId && user.tenantId !== scope.tenantId) return Promise.resolve();
      roles.set(userId, newRoles);
      return Promise.resolve();
    },
  };
}
