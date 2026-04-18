import type { SlingshotEventBus } from '@lastshotlabs/slingshot-core';
import type { AuthAdapter } from '@lastshotlabs/slingshot-core';

function requireMethod<T>(method: string, fn: T | undefined): asserts fn is T {
  if (!fn) {
    throw new Error(
      `Auth adapter does not implement ${method} — add it to your adapter to manage roles`,
    );
  }
}

/**
 * Replaces the full set of app-level roles for a user.
 *
 * Delegates to `adapter.setRoles`, then emits a `security.admin.role.changed`
 * event with `action: "set"` so the role change is auditable.
 *
 * @param userId - The user whose roles should be replaced.
 * @param roles - Complete new role list (replaces existing roles entirely).
 * @param changedBy - Optional ID of the actor making the change (for the audit event).
 * @param adapter - The active `AuthAdapter`.  Must implement `setRoles`.
 * @param eventBus - Optional event bus for emitting the role-change audit event.
 * @throws {Error} When `adapter` is not provided.
 * @throws {Error} When `adapter.setRoles` is not implemented.
 *
 * @example
 * import { setUserRoles } from '@lastshotlabs/slingshot-auth';
 *
 * await setUserRoles(userId, ['admin', 'editor'], adminId, adapter, eventBus);
 */
export const setUserRoles = async (
  userId: string,
  roles: string[],
  changedBy?: string,
  adapter?: AuthAdapter,
  eventBus?: SlingshotEventBus,
): Promise<void> => {
  if (!adapter) throw new Error('Auth adapter is required');
  requireMethod('setRoles', adapter.setRoles);
  await adapter.setRoles(userId, roles);
  eventBus?.emit('security.admin.role.changed', {
    userId,
    meta: { targetUserId: userId, changedBy, scope: 'app', roles, action: 'set' },
  });
};

/**
 * Adds a single app-level role to a user.
 *
 * Delegates to `adapter.addRole` (which should be idempotent — duplicate
 * adds are silently ignored by well-behaved adapters), then emits a
 * `security.admin.role.changed` event with `action: "add"`.
 *
 * @param userId - The user to grant the role to.
 * @param role - Role identifier to add (e.g. `"admin"`).
 * @param changedBy - Optional ID of the actor making the change.
 * @param adapter - The active `AuthAdapter`.  Must implement `addRole`.
 * @param eventBus - Optional event bus for the audit event.
 * @throws {Error} When `adapter` is not provided.
 * @throws {Error} When `adapter.addRole` is not implemented.
 *
 * @example
 * await addUserRole(userId, 'moderator', adminId, adapter, eventBus);
 */
export const addUserRole = async (
  userId: string,
  role: string,
  changedBy?: string,
  adapter?: AuthAdapter,
  eventBus?: SlingshotEventBus,
): Promise<void> => {
  if (!adapter) throw new Error('Auth adapter is required');
  requireMethod('addRole', adapter.addRole);
  await adapter.addRole(userId, role);
  eventBus?.emit('security.admin.role.changed', {
    userId,
    meta: { targetUserId: userId, changedBy, scope: 'app', roles: [role], action: 'add' },
  });
};

/**
 * Removes a single app-level role from a user.
 *
 * Delegates to `adapter.removeRole`, then emits a `security.admin.role.changed`
 * event with `action: "remove"`.
 *
 * @param userId - The user to revoke the role from.
 * @param role - Role identifier to remove.
 * @param changedBy - Optional ID of the actor making the change.
 * @param adapter - The active `AuthAdapter`.  Must implement `removeRole`.
 * @param eventBus - Optional event bus for the audit event.
 * @throws {Error} When `adapter` is not provided.
 * @throws {Error} When `adapter.removeRole` is not implemented.
 *
 * @example
 * await removeUserRole(userId, 'moderator', adminId, adapter, eventBus);
 */
export const removeUserRole = async (
  userId: string,
  role: string,
  changedBy?: string,
  adapter?: AuthAdapter,
  eventBus?: SlingshotEventBus,
): Promise<void> => {
  if (!adapter) throw new Error('Auth adapter is required');
  requireMethod('removeRole', adapter.removeRole);
  await adapter.removeRole(userId, role);
  eventBus?.emit('security.admin.role.changed', {
    userId,
    meta: { targetUserId: userId, changedBy, scope: 'app', roles: [role], action: 'remove' },
  });
};

// ---------------------------------------------------------------------------
// Tenant-scoped role helpers
// ---------------------------------------------------------------------------

/**
 * Returns the tenant-scoped roles for a user in a specific tenant.
 *
 * Delegates to `adapter.getTenantRoles`.  The returned array may be empty
 * when the user has no tenant-specific roles.
 *
 * @param userId - The user whose tenant roles should be retrieved.
 * @param tenantId - The tenant to query roles within.
 * @param adapter - The active `AuthAdapter`.  Must implement `getTenantRoles`.
 * @returns Array of role identifiers (may be empty).
 * @throws {Error} When `adapter` is not provided.
 * @throws {Error} When `adapter.getTenantRoles` is not implemented.
 *
 * @example
 * const roles = await getTenantRoles(userId, tenantId, adapter);
 * // roles: ['tenant-admin', 'billing-manager']
 */
export const getTenantRoles = async (
  userId: string,
  tenantId: string,
  adapter?: AuthAdapter,
): Promise<string[]> => {
  if (!adapter) throw new Error('Auth adapter is required');
  requireMethod('getTenantRoles', adapter.getTenantRoles);
  return adapter.getTenantRoles(userId, tenantId);
};

/**
 * Replaces the full set of tenant-scoped roles for a user within a tenant.
 *
 * Delegates to `adapter.setTenantRoles`, then emits a
 * `security.admin.role.changed` event with `scope: "tenant"` and
 * `action: "set"`.
 *
 * @param userId - The user whose tenant roles should be replaced.
 * @param tenantId - The tenant to apply the roles within.
 * @param roles - Complete new role list for this tenant.
 * @param changedBy - Optional ID of the actor making the change.
 * @param adapter - The active `AuthAdapter`.  Must implement `setTenantRoles`.
 * @param eventBus - Optional event bus for the audit event.
 * @throws {Error} When `adapter` is not provided.
 * @throws {Error} When `adapter.setTenantRoles` is not implemented.
 *
 * @example
 * await setTenantRoles(userId, tenantId, ['member', 'billing'], adminId, adapter, eventBus);
 */
export const setTenantRoles = async (
  userId: string,
  tenantId: string,
  roles: string[],
  changedBy?: string,
  adapter?: AuthAdapter,
  eventBus?: SlingshotEventBus,
): Promise<void> => {
  if (!adapter) throw new Error('Auth adapter is required');
  requireMethod('setTenantRoles', adapter.setTenantRoles);
  await adapter.setTenantRoles(userId, tenantId, roles);
  eventBus?.emit('security.admin.role.changed', {
    userId,
    meta: { targetUserId: userId, changedBy, scope: 'tenant', tenantId, roles, action: 'set' },
  });
};

/**
 * Adds a single tenant-scoped role to a user within a tenant.
 *
 * Delegates to `adapter.addTenantRole`, then emits a
 * `security.admin.role.changed` event with `scope: "tenant"` and
 * `action: "add"`.
 *
 * @param userId - The user to grant the tenant role to.
 * @param tenantId - The tenant to apply the role within.
 * @param role - Role identifier to add.
 * @param changedBy - Optional ID of the actor making the change.
 * @param adapter - The active `AuthAdapter`.  Must implement `addTenantRole`.
 * @param eventBus - Optional event bus for the audit event.
 * @throws {Error} When `adapter` is not provided.
 * @throws {Error} When `adapter.addTenantRole` is not implemented.
 *
 * @example
 * await addTenantRole(userId, tenantId, 'billing-manager', adminId, adapter, eventBus);
 */
export const addTenantRole = async (
  userId: string,
  tenantId: string,
  role: string,
  changedBy?: string,
  adapter?: AuthAdapter,
  eventBus?: SlingshotEventBus,
): Promise<void> => {
  if (!adapter) throw new Error('Auth adapter is required');
  requireMethod('addTenantRole', adapter.addTenantRole);
  await adapter.addTenantRole(userId, tenantId, role);
  eventBus?.emit('security.admin.role.changed', {
    userId,
    meta: {
      targetUserId: userId,
      changedBy,
      scope: 'tenant',
      tenantId,
      roles: [role],
      action: 'add',
    },
  });
};

/**
 * Removes a single tenant-scoped role from a user within a tenant.
 *
 * Delegates to `adapter.removeTenantRole`, then emits a
 * `security.admin.role.changed` event with `scope: "tenant"` and
 * `action: "remove"`.
 *
 * @param userId - The user to revoke the tenant role from.
 * @param tenantId - The tenant to remove the role within.
 * @param role - Role identifier to remove.
 * @param changedBy - Optional ID of the actor making the change.
 * @param adapter - The active `AuthAdapter`.  Must implement `removeTenantRole`.
 * @param eventBus - Optional event bus for the audit event.
 * @throws {Error} When `adapter` is not provided.
 * @throws {Error} When `adapter.removeTenantRole` is not implemented.
 *
 * @example
 * await removeTenantRole(userId, tenantId, 'billing-manager', adminId, adapter, eventBus);
 */
export const removeTenantRole = async (
  userId: string,
  tenantId: string,
  role: string,
  changedBy?: string,
  adapter?: AuthAdapter,
  eventBus?: SlingshotEventBus,
): Promise<void> => {
  if (!adapter) throw new Error('Auth adapter is required');
  requireMethod('removeTenantRole', adapter.removeTenantRole);
  await adapter.removeTenantRole(userId, tenantId, role);
  eventBus?.emit('security.admin.role.changed', {
    userId,
    meta: {
      targetUserId: userId,
      changedBy,
      scope: 'tenant',
      tenantId,
      roles: [role],
      action: 'remove',
    },
  });
};
