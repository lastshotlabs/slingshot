/**
 * Library package — does not implement SlingshotPlugin.
 * Import and wire directly: create an evaluator, registry, and adapter, then
 * pass them to plugins that require permissions (e.g. createCommunityPlugin).
 */
export type {
  PermissionGrant,
  SubjectRef,
  SubjectType,
  GrantEffect,
  PermissionsAdapter,
  TestablePermissionsAdapter,
  PermissionRegistry,
  ResourceTypeDefinition,
  PermissionEvaluator,
  GroupResolver,
} from '@lastshotlabs/slingshot-core';
export { validateGrant, SUPER_ADMIN_ROLE } from '@lastshotlabs/slingshot-core';
export { createAuthGroupResolver } from './lib/authGroupResolver';
export { createPermissionRegistry } from './lib/registry';
export { createPermissionEvaluator } from './lib/evaluator';
export { createSqlitePermissionsAdapter } from './adapters/sqlite';
export type { PermissionsSqliteAdapter } from './adapters/sqlite';
export { createPermissionsPostgresAdapter } from './adapters/postgres';
export type { PermissionsPostgresAdapter } from './adapters/postgres';
export { createMongoPermissionsAdapter } from './adapters/mongo';
export type { PermissionsMongoAdapter } from './adapters/mongo';
export { seedSuperAdmin } from './lib/bootstrap';
export { createMemoryPermissionsAdapter } from './adapters/memory';
export { permissionsAdapterFactories } from './factories';
export type { PermissionsAdapterFactories } from './factories';
export { createPermissionsPlugin } from './plugin';
