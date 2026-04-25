import { getPluginStateOrNull } from './pluginState';
import type { PluginStateCarrier, PluginStateMap } from './pluginState';

// ── Models ──────────────────────────────────────────────────────────────────

/**
 * The type of entity a permission grant applies to.
 *
 * - `'user'` — a concrete end-user identity; `subjectId` is the user's primary key
 *   as stored in the auth adapter (e.g. a UUID or nanoid)
 * - `'group'` — a named collection of users resolved at evaluation time via `GroupResolver`;
 *   `subjectId` is the group's ID; grants to a group apply to all current members
 * - `'service-account'` — a non-human M2M client or API service identity;
 *   `subjectId` is the service account's client ID or name; used for backend-to-backend
 *   trust grants that should not be confused with end-user permissions
 */
export type SubjectType = 'user' | 'group' | 'service-account';

/**
 * Whether the grant allows or denies the specified roles on a resource.
 *
 * @remarks
 * **Deny wins**: when the evaluator collects effective grants for a subject
 * (including group-expanded grants), any `'deny'` grant that covers the
 * requested action causes `can()` to return `false` — regardless of how many
 * `'allow'` grants also apply. This holds across all cascade levels: a specific-resource
 * deny overrides a global allow, and a global deny overrides a specific-resource allow.
 */
export type GrantEffect = 'allow' | 'deny';

/**
 * A reference to the subject of a permission grant (who the grant applies to).
 */
export interface SubjectRef {
  /**
   * The user ID, group ID, or service-account ID.
   *
   * No prefix convention is enforced by the framework — IDs are opaque strings.
   * However, it is strongly recommended that callers use a consistent scheme to
   * avoid collisions across subject types (e.g. `usr_<id>`, `grp_<id>`, `svc_<name>`).
   * The `subjectType` discriminator is always authoritative — do not rely on ID prefixes
   * for type distinction in evaluator logic.
   */
  subjectId: string;
  /** The kind of subject. */
  subjectType: SubjectType;
}

/**
 * A single row in the permissions store — a durable record that a subject holds
 * (or is denied) specific roles on a resource or scope.
 *
 * @remarks
 * Grants cascade through four levels of specificity:
 * 1. Global (tenantId=null, resourceType=null, resourceId=null)
 * 2. Tenant-wide (tenantId=T, resourceType=null, resourceId=null)
 * 3. Type-wide (tenantId=T, resourceType=RT, resourceId=null)
 * 4. Specific resource (tenantId=T, resourceType=RT, resourceId=RID)
 *
 * Deny effects at any level override allows from any other level.
 */
export interface PermissionGrant {
  /** Unique grant ID (nanoid or UUID). */
  id: string;
  /** The user, group, or service-account this grant belongs to. */
  subjectId: string;
  subjectType: SubjectType;
  /** `null` = global grant (applies across all tenants). */
  tenantId: string | null;
  /** `null` = all resource types. */
  resourceType: string | null;
  /** `null` = all resources of this type. */
  resourceId: string | null;
  /** One or more role names granted (or denied) by this record. */
  roles: string[];
  /** `'deny'` always wins over `'allow'` when both apply. */
  effect: GrantEffect;
  /**
   * Identity that issued this grant — recorded for audit purposes.
   *
   * Valid formats (not enforced, but by convention):
   * - A user ID (e.g. `'usr_abc123'`) when a human admin granted the permission
   * - A service name (e.g. `'slingshot-auth'`, `'system'`) when granted programmatically
   *   at bootstrap or by an automated process
   * - `'migration'` for grants applied during a data migration
   */
  grantedBy: string;
  /** When the grant was created. */
  grantedAt: Date;
  /** Human-readable reason for the grant (optional). */
  reason?: string;
  /** When the grant expires (must be in the future at creation time). */
  expiresAt?: Date;
  /**
   * Identity that revoked this grant.
   *
   * @remarks
   * **Invariant**: `revokedBy` and `revokedAt` are always set together or both absent.
   * A grant is considered revoked if and only if both fields are non-null. An adapter
   * that sets one without the other is in an invalid state. When revoking, always write
   * both fields atomically.
   */
  revokedBy?: string;
  /**
   * Timestamp when the grant was revoked.
   *
   * @remarks
   * **Invariant**: `revokedAt` and `revokedBy` are always set together or both absent.
   * See `revokedBy` for full invariant documentation.
   */
  revokedAt?: Date;
  /**
   * Human-readable reason for the revocation (optional).
   *
   * Recorded alongside `revokedBy` / `revokedAt` when the caller supplies context
   * for the revocation action. Useful for audit trails ("violated ToS", "role change").
   */
  revokedReason?: string;
}

// ── Adapter ─────────────────────────────────────────────────────────────────

/**
 * A `PermissionsAdapter` that adds a `clear()` method for test isolation.
 * Implement this interface in test-only adapters to reset state between test cases.
 */
export interface TestablePermissionsAdapter extends PermissionsAdapter {
  /** Remove all grants from the store. Used in `beforeEach` blocks. */
  clear(): Promise<void>;
}

/**
 * The permission evaluation scope — narrows which grants are considered effective.
 * Omitting a field means "match any value at that level".
 */
export interface EvaluationScope {
  /** Tenant to scope the evaluation to. Omit for global grants only. */
  tenantId?: string;
  /** Resource type to scope the evaluation to. */
  resourceType?: string;
  /** Specific resource ID to scope the evaluation to. */
  resourceId?: string;
}

/**
 * Storage adapter for the slingshot-permissions plugin.
 *
 * Implementations are responsible for persisting `PermissionGrant` records
 * and answering effective-grant queries. A grant is "effective" when:
 * - It has not been revoked (`revokedAt` is null/undefined)
 * - It has not expired (`expiresAt` is null or in the future)
 * - Its stored scope is satisfied by the evaluation scope
 *
 * @remarks
 * Follow the swappable provider pattern: add a new implementation file and a case
 * in the factory dispatch — never modify this interface for adapter-specific needs.
 */
export interface PermissionsAdapter {
  /** Persist a new grant and return its generated ID. */
  createGrant(grant: Omit<PermissionGrant, 'id' | 'grantedAt'>): Promise<string>;
  /**
   * Revoke an existing grant by ID.
   *
   * @param grantId - The grant to revoke.
   * @param revokedBy - Identity performing the revocation (recorded for audit).
   * @param tenantScope - When provided, the revocation only succeeds if the grant's
   *   `tenantId` matches this value. Use this to prevent tenant admins from revoking
   *   grants that belong to a different tenant or global grants.
   * @returns `true` if the grant was found and successfully revoked; `false` if not found
   *   or if `tenantScope` did not match.
   *
   * @remarks
   * `tenantScope` is a safety guard for multi-tenant deployments. Passing it ensures
   * that a tenant-scoped admin cannot escalate privileges by revoking grants outside
   * their own tenant boundary.
   */
  revokeGrant(
    grantId: string,
    revokedBy: string,
    tenantScope?: string,
    revokedReason?: string,
  ): Promise<boolean>;
  /**
   * Return all grants stored for a subject, with optional scope filtering.
   *
   * @remarks
   * This method is **unfiltered** with respect to revocation and expiry: it returns
   * revoked and expired grants alongside active ones. Callers that need only currently
   * active grants should use `getEffectiveGrantsForSubject()` instead. This method is
   * intended for administrative views (e.g., displaying a user's full grant history in
   * the admin UI) and for internal adapter operations that need the full picture.
   */
  getGrantsForSubject(
    subjectId: string,
    subjectType?: SubjectType,
    scope?: Partial<Pick<PermissionGrant, 'tenantId' | 'resourceType' | 'resourceId'>>,
  ): Promise<PermissionGrant[]>;
  /**
   * Return only grants that are currently effective (not revoked, not expired) AND whose
   * stored scope matches one of the cascade levels for the given evaluation scope.
   *
   * @remarks
   * Cascade level matching — only grants whose stored scope satisfies the requested
   * evaluation scope are included. A grant at a broader level is always included when
   * the evaluation scope is narrower:
   * - Level 4 (global):      `tenantId=null,  resourceType=null, resourceId=null`
   * - Level 3 (tenant-wide): `tenantId=T,     resourceType=null, resourceId=null`
   * - Level 2 (type-wide):   `tenantId=T,     resourceType=RT,   resourceId=null`
   * - Level 1 (specific):    `tenantId=T,     resourceType=RT,   resourceId=RID`
   *
   * Only levels that can be satisfied by the provided `scope` are included. For example,
   * passing `{ tenantId: 'T', resourceType: 'post', resourceId: '42' }` returns grants
   * from all four levels. Passing `{ tenantId: 'T' }` returns only levels 4 and 3.
   */
  getEffectiveGrantsForSubject(
    subjectId: string,
    subjectType: SubjectType,
    scope?: EvaluationScope,
  ): Promise<PermissionGrant[]>;
  /**
   * Return all grants for a subject regardless of revocation or expiry status.
   *
   * @remarks
   * Intended for audit trails and history views. Unlike `getGrantsForSubject()` this
   * includes every grant ever created for the subject — active, revoked, and expired.
   * Do not use this for permission evaluation; use `getEffectiveGrantsForSubject()` instead.
   */
  listGrantHistory(subjectId: string, subjectType: SubjectType): Promise<PermissionGrant[]>;
  listGrantsOnResource(
    resourceType: string,
    resourceId: string,
    tenantId?: string | null,
    limit?: number,
    offset?: number,
  ): Promise<PermissionGrant[]>;
  /**
   * Persist multiple grants atomically and return their generated IDs.
   *
   * All grants are validated before any are written. On failure, no grants are
   * persisted (atomicity). Adapters backed by a transactional store (Postgres, SQLite)
   * wrap the batch in a single transaction; the memory adapter validates-then-inserts
   * synchronously in one microtask.
   *
   * @param grants - Array of grant inputs (without `id` / `grantedAt` — generated by the adapter).
   * @returns Array of generated IDs in the same order as the input.
   * @throws If any individual grant fails `validateGrant()`, or on storage error.
   */
  createGrants(grants: Omit<PermissionGrant, 'id' | 'grantedAt'>[]): Promise<string[]>;
  deleteAllGrantsForSubject(subject: SubjectRef): Promise<void>;
  /**
   * Hard-delete all grants targeting a specific resource.
   *
   * Call this when the resource itself is permanently deleted to prevent unbounded
   * accumulation of orphaned grants. Pass `tenantId` to restrict deletion to a
   * single tenant's grants on that resource; omit to remove all grants across
   * all tenants.
   *
   * @param resourceType - The resource type (e.g. `'document'`).
   * @param resourceId - The specific resource ID being deleted.
   * @param tenantId - Optional tenant scope. `null` targets only global grants
   *   on that resource; `undefined` removes all grants regardless of tenant.
   */
  deleteAllGrantsOnResource(
    resourceType: string,
    resourceId: string,
    tenantId?: string | null,
  ): Promise<void>;
}

// ── Registry ────────────────────────────────────────────────────────────────

/**
 * Declares the roles and actions available for a single resource type.
 *
 * Plugins call `PermissionRegistry.register()` during `setupPost` to declare which
 * actions exist and which roles imply which actions. The evaluator uses this to resolve
 * `can(subject, action, scope)` queries.
 *
 * @example
 * ```ts
 * registry.register({
 *   resourceType: 'post',
 *   actions: ['post:read', 'post:write', 'post:delete'],
 *   roles: {
 *     reader: ['post:read'],
 *     editor: ['post:read', 'post:write'],
 *     admin:  ['post:read', 'post:write', 'post:delete'],
 *   },
 * });
 * ```
 */
export interface ResourceTypeDefinition {
  /** Machine-readable resource type string (e.g. `'post'`, `'document'`). */
  resourceType: string;
  /**
   * All valid action strings for this resource type.
   *
   * By convention, actions follow the `'resourceType:verb'` naming pattern
   * (e.g. `'post:read'`, `'post:write'`, `'post:delete'`). This is not enforced
   * by the framework but is required for consistent evaluator behaviour and
   * readable audit logs. Actions must be unique within a resource type definition.
   */
  actions: string[];
  /** Maps role names to the actions they grant. Super-admin is handled separately. */
  roles: { [roleName: string]: string[] };
}

/**
 * In-memory registry that maps resource types to their role/action definitions.
 *
 * Created once per app instance during bootstrap. Plugins register their resource
 * types during `setupPost`. The permissions evaluator queries this registry when
 * resolving `can()` checks.
 */
export interface PermissionRegistry {
  /**
   * Register a resource type definition.
   *
   * @remarks
   * The registry is consulted at plugin `setupPost` time — all plugins that expose
   * permissioned resources must call `register()` before any `can()` check is made.
   * Registering after the first `can()` call is allowed but will silently miss
   * early checks for unregistered types.
   *
   * @throws If `resourceType` is already registered.
   */
  register(definition: ResourceTypeDefinition): void;
  /**
   * Resolve the set of actions granted to a role on a resource type.
   *
   * @remarks
   * The registry is consulted by the evaluator every time `can()` is called.
   * For each effective grant, the evaluator calls this method to expand the grant's
   * role names into concrete action strings, then checks whether the requested action
   * is in that set. If the resource type or role is not registered, `[]` is returned
   * and the grant contributes no permissions.
   *
   * @param resourceType - The resource type (must be registered).
   * @param role - The role name to look up.
   * @returns The list of actions granted by this role, or `[]` if unknown.
   */
  getActionsForRole(resourceType: string, role: string): string[];
  /**
   * Retrieve a resource type definition by name.
   *
   * @remarks
   * The registry is consulted by admin tooling and the permissions evaluator when
   * validating that a requested action is a known action for a resource type.
   *
   * @returns The definition, or `null` if not registered.
   */
  getDefinition(resourceType: string): ResourceTypeDefinition | null;
  /** Return all registered resource type definitions. */
  listResourceTypes(): ResourceTypeDefinition[];
}

// ── Evaluator ───────────────────────────────────────────────────────────────

/**
 * Resolves the group memberships for a user.
 *
 * Provided to the permissions evaluator so group-based grants can be expanded
 * into per-user effective grants without the evaluator depending on the
 * `GroupsAdapter` directly.
 */
export interface GroupResolver {
  /**
   * Return all group IDs the user belongs to within a tenant (or globally when `tenantId` is null).
   *
   * @param userId - The user whose group memberships to resolve.
   * @param tenantId - The tenant scope, or `null` for global groups.
   * @returns Array of group IDs. Order is not guaranteed and callers must not depend on it.
   *   Implementations must deduplicate — the evaluator assumes each ID appears at most once
   *   and will not perform its own deduplication pass.
   */
  getGroupsForUser(userId: string, tenantId: string | null): Promise<string[]>;
}

/**
 * High-level permission evaluator that answers `can(subject, action, scope)` queries.
 *
 * The evaluator fetches effective grants for the subject (expanding group memberships via
 * `GroupResolver`), resolves the actions granted by each role using `PermissionRegistry`,
 * and applies deny-wins semantics.
 */
export interface PermissionEvaluator {
  /**
   * Determine whether a subject can perform an action within an optional scope.
   *
   * @param subject - The user, group, or service account to check.
   * @param action - The action string (e.g., `'post:write'`).
   * @param scope - Optional tenant/resource scoping. Omit for global checks.
   * @returns `true` if at least one allow grant covers the action and no deny grant overrides it.
   *
   * @example
   * ```ts
   * const allowed = await evaluator.can(
   *   { subjectId: userId, subjectType: 'user' },
   *   'post:write',
   *   { tenantId: 'org_1', resourceType: 'post', resourceId: postId },
   * );
   * ```
   */
  can(
    subject: SubjectRef,
    action: string,
    scope?: { tenantId?: string; resourceType?: string; resourceId?: string },
  ): Promise<boolean>;
}

// ── Constants ───────────────────────────────────────────────────────────────

/**
 * The magic role name that bypasses all permission checks.
 *
 * Any subject with this role in their effective grants is allowed to perform
 * any action on any resource without the evaluator consulting the registry.
 * Grant this role with extreme caution.
 */
export const SUPER_ADMIN_ROLE = 'super-admin';

/**
 * The key used to store `PermissionsState` in `SlingshotContext.pluginState`.
 * Used by slingshot-permissions to retrieve its runtime state from the context map.
 */
export const PERMISSIONS_STATE_KEY = 'slingshot-permissions';

/**
 * Runtime state stored in `ctx.pluginState.get(PERMISSIONS_STATE_KEY)` by the
 * slingshot-permissions plugin after it initialises.
 */
export interface PermissionsState {
  /** The high-level evaluator used to answer `can()` queries. */
  evaluator: PermissionEvaluator;
  /** The resource type registry used to resolve role → action mappings. */
  registry: PermissionRegistry;
  /** The backing persistence adapter for grants. */
  adapter: PermissionsAdapter;
}

/**
 * Resolve `PermissionsState` from plugin state when the permissions plugin is present.
 *
 * Returns `null` for absent or malformed state so optional integrations can fail
 * closed without inspecting raw map entries themselves.
 */
export function getPermissionsStateOrNull(
  input: PluginStateMap | PluginStateCarrier | object | null | undefined,
): PermissionsState | null {
  const pluginState = getPluginStateOrNull(input);
  const state = pluginState?.get(PERMISSIONS_STATE_KEY) as PermissionsState | undefined;
  if (!state?.adapter || !state.registry || !state.evaluator) {
    return null;
  }
  return state;
}

/**
 * Resolve `PermissionsState` from plugin state.
 *
 * Throws when `slingshot-permissions` has not published its runtime state.
 */
export function getPermissionsState(
  input: PluginStateMap | PluginStateCarrier | object | null | undefined,
): PermissionsState {
  const state = getPermissionsStateOrNull(input);
  if (!state) {
    throw new Error('[slingshot-permissions] permissions state is not available in pluginState');
  }
  return state;
}

// ── Validation ──────────────────────────────────────────────────────────────

/**
 * Validate a permission grant before it is persisted.
 *
 * Enforces the following rules:
 * - `resourceId` requires `resourceType` to be non-null
 * - At least one role must be specified
 * - `effect` must be `'allow'` or `'deny'`
 * - `expiresAt`, when provided, must be a `Date` in the future
 * - `subjectType` must be one of `'user' | 'group' | 'service-account'`
 *
 * @param grant - The grant to validate (without the auto-generated `id` and `grantedAt`).
 * @throws `Error` with a descriptive message on any validation failure.
 *
 * @example
 * ```ts
 * import { validateGrant } from '@lastshotlabs/slingshot-core';
 *
 * validateGrant({
 *   subjectId: userId, subjectType: 'user',
 *   tenantId: 'org_1', resourceType: 'post', resourceId: null,
 *   roles: ['editor'], effect: 'allow', grantedBy: 'admin',
 * });
 * ```
 */
export function validateGrant(grant: Omit<PermissionGrant, 'id' | 'grantedAt'>): void {
  if (grant.resourceId !== null && grant.resourceType === null) {
    throw new Error('resourceId requires resourceType to be set');
  }

  if (grant.roles.length === 0) {
    throw new Error('grant must have at least one role');
  }

  if (!['allow', 'deny'].includes(grant.effect)) {
    throw new Error("effect must be 'allow' or 'deny'");
  }

  if (grant.expiresAt !== undefined) {
    if (!(grant.expiresAt instanceof Date)) {
      throw new Error('expiresAt must be a Date object');
    }
    if (grant.expiresAt < new Date()) {
      throw new Error('expiresAt must be in the future');
    }
  }

  const validSubjectTypes = ['user', 'group', 'service-account'];
  if (!validSubjectTypes.includes(grant.subjectType)) {
    throw new Error('invalid subjectType');
  }

  // Enforce string length limits to prevent storage bloat from malicious input
  const MAX_ID_LENGTH = 256;
  const MAX_REASON_LENGTH = 1024;
  const MAX_ROLES = 50;
  const checkLen = (field: string, value: string | null | undefined, max: number) => {
    if (value && value.length > max) throw new Error(`${field} exceeds maximum length of ${max}`);
  };
  checkLen('subjectId', grant.subjectId, MAX_ID_LENGTH);
  checkLen('grantedBy', grant.grantedBy, MAX_ID_LENGTH);
  checkLen('reason', grant.reason, MAX_REASON_LENGTH);
  checkLen('resourceType', grant.resourceType, MAX_ID_LENGTH);
  checkLen('resourceId', grant.resourceId, MAX_ID_LENGTH);
  checkLen('tenantId', grant.tenantId, MAX_ID_LENGTH);
  if (grant.roles.length > MAX_ROLES) {
    throw new Error(`roles array exceeds maximum length of ${MAX_ROLES}`);
  }
  for (const role of grant.roles) {
    checkLen('role', role, MAX_ID_LENGTH);
  }
}
