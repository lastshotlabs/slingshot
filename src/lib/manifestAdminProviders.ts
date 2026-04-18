/**
 * Deferred provider implementations for admin plugin manifest auto-wiring.
 *
 * These providers satisfy the admin plugin's `validateAdapterShape()` checks at
 * construction time, then resolve real implementations from plugin state at
 * request time (for context-aware methods) or after binding (for data methods).
 *
 * Usage: call `createDeferredAdminProviders()` to get all providers plus a `bind()`
 * function. Call `bind(ctx)` during the admin plugin's `setupRoutes` phase after
 * auth and permissions plugins have initialized their state.
 */
import type { Context } from 'hono';
import type { AuthRuntimeContext } from '@lastshotlabs/slingshot-auth';
import type {
  AdminAccessProvider,
  AdminPrincipal,
  AppEnv,
  AuditLogEntry,
  AuditLogProvider,
  AuditLogQuery,
  ListUsersInput,
  ListUsersResult,
  ManagedUserCapabilities,
  ManagedUserProvider,
  ManagedUserRecord,
  PermissionEvaluator,
  PermissionRegistry,
  PermissionsAdapter,
  PermissionsState,
  SubjectRef,
} from '@lastshotlabs/slingshot-core';
import { PERMISSIONS_STATE_KEY, SUPER_ADMIN_ROLE } from '@lastshotlabs/slingshot-core';

/**
 * Create deferred admin providers that resolve real implementations lazily.
 *
 * Returns an object with:
 * - `accessProvider` — verifies admin access using auth context variables
 * - `managedUserProvider` — delegates user CRUD to the auth adapter
 * - `permissions` — delegates to the permissions plugin state
 * - `auditLog` — in-memory audit log (optional, for development)
 * - `bind(ctx)` — must be called during setupRoutes to bind real adapters
 * - `deps` — plugin dependency names that must be declared
 */
export function createDeferredAdminProviders(config: Record<string, unknown>): {
  accessProvider?: AdminAccessProvider;
  managedUserProvider?: ManagedUserProvider;
  permissions?: {
    evaluator: PermissionEvaluator;
    registry: PermissionRegistry;
    adapter: PermissionsAdapter;
  };
  auditLog?: AuditLogProvider;
  bind: (pluginState: Map<string, unknown>) => void;
  deps: string[];
} {
  let authRuntime: AuthRuntimeContext | null = null;
  let permsState: PermissionsState | null = null;

  const deps: string[] = [];
  const result: ReturnType<typeof createDeferredAdminProviders> = {
    deps,
    bind(pluginState: Map<string, unknown>) {
      if (
        config['accessProvider'] === 'slingshot-auth' ||
        config['managedUserProvider'] === 'slingshot-auth'
      ) {
        authRuntime = pluginState.get('slingshot-auth') as AuthRuntimeContext | null;
      }
      if (config['permissions'] === 'slingshot-permissions') {
        permsState = pluginState.get(PERMISSIONS_STATE_KEY) as PermissionsState | null;
      }
    },
  };

  if (config['accessProvider'] === 'slingshot-auth') {
    deps.push('slingshot-auth');
    result.accessProvider = {
      name: 'slingshot-auth',
      verifyRequest(c: Context<AppEnv>): Promise<AdminPrincipal | null> {
        const userId = c.get('authUserId');
        const rolesValue = c.get('roles');
        const roles = Array.isArray(rolesValue)
          ? rolesValue.filter((role): role is string => typeof role === 'string')
          : [];
        if (typeof userId !== 'string' || !roles.includes(SUPER_ADMIN_ROLE)) {
          return Promise.resolve(null);
        }
        return Promise.resolve({ subject: userId, roles, provider: 'slingshot-auth' });
      },
    };
  }

  if (config['managedUserProvider'] === 'slingshot-auth') {
    if (!deps.includes('slingshot-auth')) deps.push('slingshot-auth');

    function requireAdapter() {
      if (!authRuntime) {
        throw new Error(
          '[manifestAdminProviders] Auth runtime not bound. ' +
            'Ensure slingshot-auth is in the plugin list and admin setupRoutes runs after auth initialization.',
        );
      }
      return authRuntime.adapter;
    }

    result.managedUserProvider = {
      name: 'slingshot-auth',

      async listUsers(input: ListUsersInput): Promise<ListUsersResult> {
        const adapter = requireAdapter();
        if (!adapter.listUsers) return { items: [] };
        const startIndex = input.cursor ? parseInt(input.cursor, 10) : 0;
        const count = input.limit ?? 50;
        const queryResult = await adapter.listUsers({
          startIndex,
          count,
          email: input.search,
          suspended:
            input.status === 'suspended' ? true : input.status === 'active' ? false : undefined,
        });
        const nextIndex = startIndex + count;
        return {
          items: queryResult.users.map(
            (u): ManagedUserRecord => ({
              id: u.id,
              email: u.email,
              displayName: u.displayName,
              firstName: u.firstName,
              lastName: u.lastName,
              externalId: u.externalId,
              status: u.suspended ? 'suspended' : 'active',
              provider: 'slingshot-auth',
              metadata: u.userMetadata,
            }),
          ),
          nextCursor: nextIndex < queryResult.totalResults ? String(nextIndex) : undefined,
        };
      },

      async getUser(userId: string): Promise<ManagedUserRecord | null> {
        const adapter = requireAdapter();
        if (!adapter.getUser) return null;
        const user = await adapter.getUser(userId);
        if (!user) return null;
        return {
          id: userId,
          email: user.email,
          displayName: user.displayName,
          firstName: user.firstName,
          lastName: user.lastName,
          externalId: user.externalId,
          status: user.suspended ? 'suspended' : 'active',
          provider: 'slingshot-auth',
          metadata: user.userMetadata,
        };
      },

      getCapabilities(): Promise<ManagedUserCapabilities> {
        const adapter = requireAdapter();
        return Promise.resolve({
          canListUsers: typeof adapter.listUsers === 'function',
          canSearchUsers: typeof adapter.listUsers === 'function',
          canViewUser: typeof adapter.getUser === 'function',
          canDeleteUsers: typeof adapter.deleteUser === 'function',
          canSuspendUsers: typeof adapter.setSuspended === 'function',
          canEditUser: typeof adapter.setUserMetadata === 'function',
          canViewSessions: false,
          canRevokeSessions: false,
          canManageRoles: false,
        });
      },

      async deleteUser(userId: string): Promise<void> {
        const adapter = requireAdapter();
        if (!adapter.deleteUser) {
          throw new Error('[slingshot-admin] Auth adapter does not support deleteUser');
        }
        await adapter.deleteUser(userId);
      },
    };
  }

  if (config['permissions'] === 'slingshot-permissions') {
    deps.push('slingshot-permissions');

    function requirePerms(): PermissionsState {
      if (!permsState) {
        throw new Error(
          '[manifestAdminProviders] Permissions state not bound. ' +
            'Ensure slingshot-permissions is in the plugin list.',
        );
      }
      return permsState;
    }

    const permissionsAdapter: PermissionsAdapter = {
      createGrant(grant) {
        return requirePerms().adapter.createGrant(grant);
      },
      revokeGrant(grantId, revokedBy, tenantScope) {
        return requirePerms().adapter.revokeGrant(grantId, revokedBy, tenantScope);
      },
      getGrantsForSubject(subjectId, subjectType, scope) {
        return requirePerms().adapter.getGrantsForSubject(subjectId, subjectType, scope);
      },
      getEffectiveGrantsForSubject(subjectId, subjectType, scope) {
        return requirePerms().adapter.getEffectiveGrantsForSubject(subjectId, subjectType, scope);
      },
      listGrantHistory(subjectId, subjectType) {
        return requirePerms().adapter.listGrantHistory(subjectId, subjectType);
      },
      listGrantsOnResource(resourceType, resourceId, tenantId) {
        return requirePerms().adapter.listGrantsOnResource(resourceType, resourceId, tenantId);
      },
      deleteAllGrantsForSubject(subject) {
        return requirePerms().adapter.deleteAllGrantsForSubject(subject);
      },
    };

    result.permissions = {
      evaluator: {
        can(
          subject: SubjectRef,
          action: string,
          scope?: { tenantId?: string; resourceType?: string; resourceId?: string },
        ): Promise<boolean> {
          return requirePerms().evaluator.can(subject, action, scope);
        },
      },
      registry: {
        register(definition) {
          requirePerms().registry.register(definition);
        },
        getActionsForRole(resourceType: string, role: string): string[] {
          return requirePerms().registry.getActionsForRole(resourceType, role);
        },
        getDefinition(resourceType: string) {
          return requirePerms().registry.getDefinition(resourceType);
        },
        listResourceTypes() {
          return requirePerms().registry.listResourceTypes();
        },
      },
      adapter: permissionsAdapter,
    };
  }

  if (config['auditLog'] === 'memory') {
    result.auditLog = createInMemoryAuditLog();
  }

  return result;
}

/**
 * Create an in-memory audit log provider for development use.
 * Logs are lost on process restart.
 */
export function createInMemoryAuditLog(): AuditLogProvider {
  const entries: AuditLogEntry[] = [];

  return {
    logEntry(entry: AuditLogEntry): Promise<void> {
      entries.push(entry);
      return Promise.resolve();
    },
    getLogs(query: AuditLogQuery): Promise<{ items: AuditLogEntry[]; nextCursor?: string }> {
      let filtered = entries;

      if (query.userId) filtered = filtered.filter(e => e.userId === query.userId);
      if (query.tenantId) filtered = filtered.filter(e => e.tenantId === query.tenantId);
      if (query.path) filtered = filtered.filter(e => e.path === query.path);
      if (query.method) filtered = filtered.filter(e => e.method === query.method);

      const limit = query.limit ?? 50;
      const startIndex = query.cursor ? parseInt(query.cursor, 10) : 0;
      const page = filtered.slice(startIndex, startIndex + limit);
      const nextCursor =
        startIndex + limit < filtered.length ? String(startIndex + limit) : undefined;

      return Promise.resolve({ items: page, nextCursor });
    },
  };
}
