import type {
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
  UserRecord,
} from '@lastshotlabs/slingshot-core';
import type { AuthAdapter } from '@lastshotlabs/slingshot-core';
import type { AuthResolvedConfig } from '../config/authConfig';
import type { SessionRepository } from '../lib/session';
import { setSuspended } from '../lib/suspension';

/**
 * Creates a `ManagedUserProvider` that exposes slingshot-auth's user store through the
 * framework's admin user management interface.
 *
 * Provides list, get, update, suspend/unsuspend, delete, session management, and role
 * management operations backed by the configured `AuthAdapter` and `SessionRepository`.
 *
 * Registered automatically by `bootstrapAuth` when the admin API is enabled. Exposed
 * publicly so advanced consumers can register it manually or substitute a custom provider.
 *
 * @param adapter - The active `AuthAdapter` instance.
 * @param config - The resolved auth config (used for session TTL and policy during session ops).
 * @param sessionRepo - The active session repository (used for session listing and revocation).
 * @returns A `ManagedUserProvider` implementation for the framework admin API.
 *
 * @example
 * import { createSlingshotManagedUserProvider } from '@lastshotlabs/slingshot-auth';
 *
 * // Manually wire up if you manage bootstrap yourself
 * const userProvider = createSlingshotManagedUserProvider(adapter, resolvedConfig, sessionRepo);
 * registrar.setManagedUserProvider(userProvider);
 *
 * @remarks
 * User listing is cursor-based (base64-encoded offset). The `search` parameter is passed
 * as an email prefix filter when supported by the adapter's `listUsers` implementation.
 * The built-in slingshot-auth adapter does not partition users or sessions by tenant, so
 * tenant-scoped admin requests fail closed: list/get/session/role operations return empty
 * results and mutating operations no-op rather than leaking global auth state.
 */
export function createSlingshotManagedUserProvider(
  adapter: AuthAdapter,
  config: AuthResolvedConfig,
  sessionRepo: SessionRepository,
): ManagedUserProvider {
  function hasTenantScope(scope?: ManagedUserScope): boolean {
    return typeof scope?.tenantId === 'string' && scope.tenantId.length > 0;
  }

  return {
    name: 'slingshot-auth',

    async listUsers(input: ListUsersInput): Promise<ListUsersResult> {
      if (hasTenantScope(input)) return { items: [] };
      const limit = input.limit ?? 50;
      const startIndex = input.cursor ? decodeAdminCursor(input.cursor) : 0;
      const result = await adapter.listUsers?.({
        ...(input.search ? { email: input.search } : {}),
        startIndex,
        count: limit + 1,
      });
      if (!result) return { items: [] };
      const hasMore = result.users.length > limit;
      const page = hasMore ? result.users.slice(0, limit) : result.users;
      return {
        items: page.map(toManagedUserRecord),
        nextCursor: hasMore ? encodeAdminCursor(startIndex + limit) : undefined,
      };
    },

    async getUser(userId: string, scope?: ManagedUserScope): Promise<ManagedUserRecord | null> {
      if (hasTenantScope(scope)) return null;
      const user = await adapter.getUser?.(userId);
      if (!user) return null;
      return {
        id: userId,
        email: user.email,
        displayName: user.displayName ?? undefined,
        firstName: user.firstName ?? undefined,
        lastName: user.lastName ?? undefined,
        externalId: user.externalId ?? undefined,
        status: user.suspended ? 'suspended' : 'active',
        provider: 'slingshot-auth',
      };
    },

    // eslint-disable-next-line @typescript-eslint/require-await -- interface requires Promise
    async getCapabilities(): Promise<ManagedUserCapabilities> {
      return {
        canListUsers: true,
        canSearchUsers: true,
        canViewUser: true,
        canEditUser: true,
        canSuspendUsers: true,
        canDeleteUsers: true,
        canViewSessions: true,
        canRevokeSessions: true,
        canManageRoles: true,
      };
    },

    async suspendUser(input: SuspendUserInput): Promise<void> {
      if (hasTenantScope(input)) return;
      await setSuspended(adapter, input.userId, true, input.reason);
    },

    async unsuspendUser(input: UnsuspendUserInput): Promise<void> {
      if (hasTenantScope(input)) return;
      await setSuspended(adapter, input.userId, false);
    },

    async updateUser(input: UpdateUserInput): Promise<ManagedUserRecord | null> {
      if (hasTenantScope(input)) return null;
      await adapter.updateProfile?.(input.userId, {
        displayName: input.displayName,
        firstName: input.firstName,
        lastName: input.lastName,
        externalId: input.externalId,
      });
      const user = await adapter.getUser?.(input.userId);
      if (!user) return null;
      return {
        id: input.userId,
        email: user.email,
        displayName: user.displayName ?? undefined,
        firstName: user.firstName ?? undefined,
        lastName: user.lastName ?? undefined,
        externalId: user.externalId ?? undefined,
        status: user.suspended ? 'suspended' : 'active',
        provider: 'slingshot-auth',
      };
    },

    async deleteUser(userId: string, scope?: ManagedUserScope): Promise<void> {
      if (hasTenantScope(scope)) return;
      const sessions = await sessionRepo.getUserSessions(userId, config);
      await Promise.all(sessions.map(s => sessionRepo.deleteSession(s.sessionId, config)));
      await adapter.deleteUser?.(userId);
    },

    async listSessions(userId: string, scope?: ManagedUserScope): Promise<SessionRecord[]> {
      if (hasTenantScope(scope)) return [];
      const sessions = await sessionRepo.getUserSessions(userId, config);
      return sessions.map(s => ({
        sessionId: s.sessionId,
        userId,
        createdAt: s.createdAt,
        lastActiveAt: s.lastActiveAt,
        ip: s.ipAddress ?? undefined,
        userAgent: s.userAgent ?? undefined,
      }));
    },

    async revokeSession(sessionId: string, scope?: ManagedUserScope): Promise<void> {
      if (hasTenantScope(scope)) return;
      await sessionRepo.deleteSession(sessionId, config);
    },

    async revokeAllSessions(userId: string, scope?: ManagedUserScope): Promise<void> {
      if (hasTenantScope(scope)) return;
      const sessions = await sessionRepo.getUserSessions(userId, config);
      await Promise.all(sessions.map(s => sessionRepo.deleteSession(s.sessionId, config)));
    },

    async getRoles(userId: string, scope?: ManagedUserScope): Promise<string[]> {
      if (hasTenantScope(scope)) return [];
      return (await adapter.getRoles?.(userId)) ?? [];
    },

    async setRoles(userId: string, roles: string[], scope?: ManagedUserScope): Promise<void> {
      if (hasTenantScope(scope)) return;
      await adapter.setRoles?.(userId, roles);
    },
  };
}

function encodeAdminCursor(offset: number): string {
  return btoa(JSON.stringify({ offset }));
}

function decodeAdminCursor(cursor: string): number {
  try {
    const parsed = JSON.parse(atob(cursor)) as { offset: number };
    return typeof parsed.offset === 'number' ? parsed.offset : 0;
  } catch {
    return 0;
  }
}

function toManagedUserRecord(user: UserRecord): ManagedUserRecord {
  return {
    id: user.id,
    email: user.email,
    displayName: user.displayName ?? undefined,
    firstName: user.firstName ?? undefined,
    lastName: user.lastName ?? undefined,
    externalId: user.externalId ?? undefined,
    status: user.suspended ? 'suspended' : 'active',
    provider: 'slingshot-auth',
  };
}
