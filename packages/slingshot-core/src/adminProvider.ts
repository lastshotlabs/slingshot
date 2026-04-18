// Admin provider contracts — shared between slingshot-admin and slingshot-auth.
// These live in core because both plugin packages depend on them (plugin→core is the only allowed edge).
import type { Context } from 'hono';
import type { AppEnv } from './context';

/**
 * The authenticated admin identity extracted from a verified admin request.
 * Produced by `AdminAccessProvider.verifyRequest()` and carried through admin routes.
 */
export interface AdminPrincipal {
  /**
   * The admin's subject identifier.
   *
   * Must be unique within the issuing provider's namespace (e.g. a user ID from
   * slingshot-auth, or a service account name for M2M tokens). The framework records
   * this value in audit logs and uses it for `grantedBy` attribution — it is never
   * interpreted programmatically outside of the provider that issued it. Format is
   * provider-dependent; slingshot-auth uses the user's primary key (nanoid).
   */
  subject: string;
  /** Email address, if available from the provider. */
  email?: string;
  /** Display name for logging and audit trails. */
  displayName?: string;
  /** Roles granted to this admin principal. */
  roles?: string[];
  /** Explicit permission strings, if the provider issues fine-grained permissions. */
  permissions?: string[];
  /** Tenant scope, for tenant-restricted admin principals. */
  tenantId?: string;
  /** The name of the provider that issued this principal (e.g., `'slingshot-auth'`). */
  provider: string;
  /**
   * Raw claims from the underlying token, for provider-specific extensions.
   *
   * Populated when the provider needs to expose token data that does not map to
   * a standard `AdminPrincipal` field (e.g. custom JWT claims, OIDC `amr` values,
   * or vendor-specific metadata). Admin route handlers may read `rawClaims` for
   * provider-specific logic, but must not depend on its shape in generic framework code.
   * May be omitted when no extension claims are present.
   */
  rawClaims?: Record<string, unknown>;
}

/**
 * A pluggable admin authentication provider.
 *
 * Verifies incoming requests to the admin API and returns an `AdminPrincipal`.
 * Implement this interface to integrate any identity provider (JWT, OIDC, API key, etc.)
 * as an admin access mechanism.
 *
 * @example
 * ```ts
 * const myProvider: AdminAccessProvider = {
 *   name: 'my-admin-provider',
 *   async verifyRequest(c) {
 *     const token = c.req.header('x-admin-token');
 *     if (!token || !isValid(token)) return null;
 *     return { subject: 'admin', provider: 'my-admin-provider' };
 *   },
 * };
 * ```
 */
export interface AdminAccessProvider {
  /** Unique provider name (used in audit logs and debug output). */
  name: string;
  /**
   * Verify the request and extract an admin principal.
   * Return `null` to reject the request (401).
   * Context is typed as `any` because providers only read HTTP headers/cookies.
   */
  verifyRequest(c: Context<AppEnv>): Promise<AdminPrincipal | null>;
}

/**
 * A user record as exposed by the admin API.
 * Normalised across auth providers — source-specific fields are in `metadata`.
 */
export interface ManagedUserRecord {
  /** User's unique identifier. */
  id: string;
  /** Tenant scope for the record, when the underlying provider partitions users by tenant. */
  tenantId?: string;
  email?: string;
  displayName?: string;
  firstName?: string;
  lastName?: string;
  externalId?: string;
  /** Account status. */
  status?: 'active' | 'suspended';
  /** Roles assigned to this user. */
  roles?: string[];
  /** The auth provider that manages this user (e.g., `'slingshot-auth'`). */
  provider: string;
  /** Provider-specific metadata. */
  metadata?: Record<string, unknown>;
}

/**
 * Filters and pagination options for listing users via the admin API.
 */
export interface ListUsersInput {
  /** Restrict results to a tenant when the admin principal is tenant-scoped. */
  tenantId?: string;
  /** Maximum number of users to return. */
  limit?: number;
  /** Opaque pagination cursor from a previous response. */
  cursor?: string;
  /** Full-text search query applied to email and display name. */
  search?: string;
  /** Filter by account status. */
  status?: 'active' | 'suspended';
  /** Filter by role name. */
  role?: string;
  /** ISO 8601 date string — return users created after this date. */
  createdAfter?: string;
  /** ISO 8601 date string — return users created before this date. */
  createdBefore?: string;
  /** Sort field. */
  sortBy?: 'createdAt' | 'email';
  /** Sort direction. */
  sortDir?: 'asc' | 'desc';
}

/**
 * Paginated list of managed user records returned by `ManagedUserProvider.listUsers()`.
 */
export interface ListUsersResult {
  /** The page of user records. */
  items: ManagedUserRecord[];
  /** Cursor for the next page, or `undefined` if this is the last page. */
  nextCursor?: string;
}

/**
 * Tenant scope applied to admin managed-user operations.
 */
export interface ManagedUserScope {
  /** Tenant boundary to enforce for the operation. Omit for global admin access. */
  tenantId?: string;
}

/**
 * Input for suspending a user account via the admin API.
 */
export interface SuspendUserInput extends ManagedUserScope {
  /** The user to suspend. */
  userId: string;
  /** Human-readable reason recorded in the suspension log. */
  reason?: string;
  /** The admin performing the action (recorded in the audit log). */
  actorId: string;
}

/**
 * Input for unsuspending (reinstating) a user account via the admin API.
 */
export interface UnsuspendUserInput extends ManagedUserScope {
  /** The user to unsuspend. */
  userId: string;
  /** The admin performing the action (recorded in the audit log). */
  actorId: string;
}

/**
 * Input for updating a user's profile fields via the admin API.
 */
export interface UpdateUserInput extends ManagedUserScope {
  /** The user to update. */
  userId: string;
  displayName?: string;
  firstName?: string;
  lastName?: string;
  externalId?: string;
}

/**
 * An active or historical session record exposed by the admin API.
 */
export interface SessionRecord {
  /** Unique session identifier. */
  sessionId: string;
  /** The user who owns this session. */
  userId: string;
  /** When the session was created (epoch ms). */
  createdAt?: number;
  /** When the session last processed a request (epoch ms). */
  lastActiveAt?: number;
  /** The IP address that created the session. */
  ip?: string;
  /** The user agent string from the session creation request. */
  userAgent?: string;
  /** Whether the session is currently active (not revoked or expired). */
  active?: boolean;
}

/**
 * Capabilities advertised by a `ManagedUserProvider`.
 *
 * The admin UI uses these flags to show/hide features based on what the
 * underlying provider supports. Always call `getCapabilities()` before
 * attempting optional operations like `suspendUser` or `revokeSession`.
 */
export interface ManagedUserCapabilities {
  canListUsers: boolean;
  canSearchUsers: boolean;
  canViewUser: boolean;
  canEditUser?: boolean;
  canSuspendUsers?: boolean;
  canDeleteUsers?: boolean;
  canViewSessions?: boolean;
  canRevokeSessions?: boolean;
  canManageRoles?: boolean;
}

/**
 * A pluggable managed-user provider for the slingshot admin API.
 *
 * Abstracts over the auth adapter to provide a normalised user management interface.
 * The admin plugin discovers registered providers from `ctx.pluginState` and uses the
 * capabilities API to determine which admin operations are available.
 *
 * @remarks
 * Optional methods (`suspendUser`, `deleteUser`, etc.) are only called when
 * `getCapabilities()` returns `true` for the corresponding flag. Never call them
 * without checking capabilities first.
 */
export interface ManagedUserProvider {
  /** Unique provider name (used for logging and multi-provider disambiguation). */
  name: string;
  /**
   * List users with optional filters and cursor pagination.
   * @param input - Filter, sort, pagination, and tenant-scope options.
   * @returns A paginated list of managed user records.
   */
  listUsers(input: ListUsersInput): Promise<ListUsersResult>;
  /**
   * Retrieve a single user by ID.
   * @param scope - Optional tenant boundary to enforce while resolving the user.
   * @returns The user record, or `null` if not found.
   */
  getUser(userId: string, scope?: ManagedUserScope): Promise<ManagedUserRecord | null>;
  /** Full-text search across users (optional — check capabilities). */
  searchUsers?(query: string, input?: Omit<ListUsersInput, 'search'>): Promise<ListUsersResult>;
  /** Return the capabilities supported by this provider instance. */
  getCapabilities(): Promise<ManagedUserCapabilities>;
  /** Suspend a user account (optional — check capabilities). */
  suspendUser?(input: SuspendUserInput): Promise<void>;
  /** Reinstate a suspended user account (optional — check capabilities). */
  unsuspendUser?(input: UnsuspendUserInput): Promise<void>;
  /** Update profile fields for a user (optional — check capabilities). */
  updateUser?(input: UpdateUserInput): Promise<ManagedUserRecord | null>;
  /** Permanently delete a user account (optional — check capabilities). */
  deleteUser?(userId: string, scope?: ManagedUserScope): Promise<void>;
  /** List active sessions for a user (optional — check capabilities). */
  listSessions?(userId: string, scope?: ManagedUserScope): Promise<SessionRecord[]>;
  /** Revoke a specific session by ID (optional — check capabilities). */
  revokeSession?(sessionId: string, scope?: ManagedUserScope): Promise<void>;
  /** Revoke all sessions for a user (optional — check capabilities). */
  revokeAllSessions?(userId: string, scope?: ManagedUserScope): Promise<void>;
  /** Get roles for a user (optional — check capabilities). */
  getRoles?(userId: string, scope?: ManagedUserScope): Promise<string[]>;
  /** Replace a user's roles (optional — check capabilities). */
  setRoles?(userId: string, roles: string[], scope?: ManagedUserScope): Promise<void>;
}
