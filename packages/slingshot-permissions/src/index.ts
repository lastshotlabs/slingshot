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
/**
 * Core permission helpers and constants re-exported for permissions consumers.
 */
export { validateGrant, SUPER_ADMIN_ROLE } from '@lastshotlabs/slingshot-core';
/**
 * Create a group resolver that expands permission subjects through auth groups.
 */
export { createAuthGroupResolver } from './lib/authGroupResolver';
/**
 * Create an in-memory permission registry for resource action definitions.
 */
export { createPermissionRegistry } from './lib/registry';
/**
 * Create the permission evaluator and timeout error used during grant resolution.
 */
export { createPermissionEvaluator, PermissionQueryTimeoutError } from './lib/evaluator';
/**
 * Evaluator health, logging, and group-expansion failure types.
 */
export type {
  EvaluatorHealth,
  EvaluatorLogger,
  EvaluatorWithHealth,
  GroupExpansionFailure,
} from './lib/evaluator';
/**
 * Create the SQLite-backed permissions adapter.
 */
export { createSqlitePermissionsAdapter } from './adapters/sqlite';
/**
 * SQLite permissions adapter contract.
 */
export type { PermissionsSqliteAdapter } from './adapters/sqlite';
/**
 * Create the Postgres-backed permissions adapter.
 */
export { createPermissionsPostgresAdapter } from './adapters/postgres';
/**
 * Postgres permissions adapter contract and health type.
 */
export type {
  PermissionsPostgresAdapter,
  PermissionsPostgresAdapterHealth,
  CreatePermissionsPostgresAdapterOptions,
} from './adapters/postgres';
/**
 * Create the MongoDB-backed permissions adapter.
 */
export { createMongoPermissionsAdapter } from './adapters/mongo';
/**
 * MongoDB permissions adapter contract.
 */
export type { PermissionsMongoAdapter } from './adapters/mongo';
/**
 * Seed the super-admin grant into a permissions adapter.
 */
export { seedSuperAdmin } from './lib/bootstrap';
/**
 * Create the in-memory permissions adapter for local and test use.
 */
export { createMemoryPermissionsAdapter } from './adapters/memory';
/**
 * Adapter factory registry for first-party permissions stores.
 */
export { permissionsAdapterFactories } from './factories';
/**
 * Type map for first-party permissions adapter factories.
 */
export type { PermissionsAdapterFactories } from './factories';
/**
 * Create the permissions plugin wrapper.
 */
export { createPermissionsPlugin } from './plugin';
/**
 * Configuration accepted by `createPermissionsPlugin()`.
 */
export type { PermissionsPluginConfig } from './plugin';
