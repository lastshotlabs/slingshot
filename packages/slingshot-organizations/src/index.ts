/**
 * Create the organizations package with org services, entity adapters, and
 * reconciliation hooks. Authored via `definePackage(...)` and consumed
 * through `createApp({ packages: [createOrganizationsPackage(...)] })`.
 */
export { createOrganizationsPackage } from './plugin';
/**
 * Configuration accepted by `createOrganizationsPackage()`.
 */
export type { OrganizationsPluginConfig, OrganizationsPluginDeps } from './plugin';
/**
 * Organization slug conflict error and unique-constraint classifier.
 */
export { SlugConflictError, isUniqueViolationError } from './errors';
/**
 * Accessors for the organization service registered by the package (resolves
 * through the typed `OrganizationsOrgServiceCap` capability under the hood).
 */
export { getOrganizationsOrgService, getOrganizationsOrgServiceOrNull } from './orgService';
/**
 * Organization service contract exposed by the package state.
 */
export type { OrganizationsOrgService } from './orgService';
/**
 * Provider-owned package contract for cross-package consumers.
 */
export { Organizations, OrganizationsOrgServiceCap } from './public';
/**
 * State key and accessors for the organizations reconciliation service.
 */
export {
  ORGANIZATIONS_RECONCILE_STATE_KEY,
  getOrganizationsReconcile,
  getOrganizationsReconcileOrNull,
} from './reconcile';
/**
 * Reconciliation service contracts and result payloads for orphaned organization records.
 */
export type { OrganizationsReconcileService, ReconcileOrphanedOrgRecordsResult } from './reconcile';
/**
 * Group-management configuration used by organization integrations.
 */
export type { GroupsConfig, GroupsManagementConfig } from './types/groups';

/**
 * Rate limit store contract and implementations.
 */
export type { OrganizationsRateLimitStore, OrganizationsRateLimitDecision } from './lib/rateLimit';
/**
 * Create the in-memory rate-limit store used by organizations routes in tests and local apps.
 */
export { createMemoryOrganizationsRateLimitStore } from './lib/rateLimit';
/**
 * Create the Redis-backed organizations rate-limit store and its minimal Redis client contract.
 */
export { createRedisOrganizationsRateLimitStore, type RedisLike } from './lib/rateLimitRedis';
