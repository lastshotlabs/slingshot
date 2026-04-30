/**
 * Create the organizations plugin with org services, manifests, and reconciliation hooks.
 */
export { createOrganizationsPlugin } from './plugin';
/**
 * Configuration accepted by `createOrganizationsPlugin()`.
 */
export type { OrganizationsPluginConfig } from './plugin';
/**
 * Organization slug conflict error and unique-constraint classifier.
 */
export { SlugConflictError, isUniqueViolationError } from './errors';
/**
 * Entity manifest describing organization resources.
 */
export { organizationsManifest } from './manifest/organizationsManifest';
/**
 * State key and accessors for the organization service registered by the plugin.
 */
export {
  ORGANIZATIONS_ORG_SERVICE_STATE_KEY,
  getOrganizationsOrgService,
  getOrganizationsOrgServiceOrNull,
} from './orgService';
/**
 * Organization service contract exposed by the plugin state.
 */
export type { OrganizationsOrgService } from './orgService';
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
