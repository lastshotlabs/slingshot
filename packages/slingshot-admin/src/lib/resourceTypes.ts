import type { PermissionRegistry } from '@lastshotlabs/slingshot-core';

/**
 * Registers all admin resource types and their role-to-action mappings into a
 * `PermissionRegistry`.
 *
 * Call this once during application bootstrap, before `createApp()`.
 * Registries become immutable after the server starts.
 *
 * Registered resource types:
 * - `admin:user` - read / write / suspend / delete
 * - `admin:session` - read / revoke
 * - `admin:role` - read / write
 * - `admin:audit` - read
 * - `admin:permission` - read / write
 * - `admin:mail` - read
 *
 * @remarks
 * The `super-admin` role is not listed in any roles map. The permission
 * registry handles `super-admin` specially: `getActionsForRole(*, 'super-admin')`
 * always returns `['*']`.
 *
 * @param registry - The application's `PermissionRegistry` instance.
 *
 * @example
 * ```ts
 * import { registerAdminResourceTypes } from '@lastshotlabs/slingshot-admin';
 * import { createPermissionRegistry } from '@lastshotlabs/slingshot-core';
 *
 * const registry = createPermissionRegistry();
 * registerAdminResourceTypes(registry);
 *
 * const adminPlugin = createAdminPlugin({
 *   permissions: { registry, evaluator, adapter },
 * });
 * ```
 */
export function registerAdminResourceTypes(registry: PermissionRegistry): void {
  registry.register({
    resourceType: 'admin:user',
    actions: ['read', 'write', 'suspend', 'delete'],
    roles: { 'tenant-admin': ['read', 'write', 'suspend'], support: ['read'] },
  });
  registry.register({
    resourceType: 'admin:session',
    actions: ['read', 'revoke'],
    roles: { 'tenant-admin': ['read', 'revoke'], support: ['read'] },
  });
  registry.register({
    resourceType: 'admin:role',
    actions: ['read', 'write'],
    roles: { 'tenant-admin': ['read', 'write'] },
  });
  registry.register({
    resourceType: 'admin:audit',
    actions: ['read'],
    roles: { 'tenant-admin': ['read'], support: ['read'], auditor: ['read'] },
  });
  registry.register({
    resourceType: 'admin:permission',
    actions: ['read', 'write'],
    roles: { 'tenant-admin': ['read', 'write'] },
  });
  registry.register({
    resourceType: 'admin:mail',
    actions: ['read'],
    roles: { 'tenant-admin': ['read'] },
  });
}
