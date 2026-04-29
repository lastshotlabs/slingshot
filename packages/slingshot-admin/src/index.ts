/**
 * Thin pass-through plugin — wires an AdminAccessProvider and ManagedUserProvider
 * into the Slingshot framework. Has no storage adapter of its own; persistence is
 * delegated to the configured providers (e.g. slingshot-auth).
 * If admin grows into a full plugin (own storage, queues, etc.), scaffold the
 * full canonical structure at that time.
 */
export { createAdminPlugin } from './plugin';
/**
 * Health payload returned by the admin plugin runtime.
 */
export type { AdminPluginHealth } from './plugin';
/**
 * Zod schema used to validate admin plugin configuration.
 */
export { adminPluginConfigSchema } from './types/config';
/**
 * Configuration shape accepted by `createAdminPlugin()`.
 */
export type { AdminPluginConfig } from './types/config';
/**
 * Hono environment and variable types installed by the admin plugin.
 */
export type { AdminEnv, AdminVariables } from './types/env';
/**
 * Create an Admin access provider backed by Auth0 management APIs.
 */
export { createAuth0AccessProvider } from './providers/auth0Access';
/**
 * Configuration accepted by the Auth0 admin access provider.
 */
export type { Auth0AccessProviderConfig } from './providers/auth0Access';
/**
 * Register admin-owned resource types with a Slingshot resource registry.
 */
export { registerAdminResourceTypes } from './lib/resourceTypes';
/**
 * Create in-memory or Redis-backed admin rate-limit stores.
 */
export { createMemoryRateLimitStore, createRedisRateLimitStore } from './lib/rateLimitStore';
/**
 * Rate-limit store contracts and Redis client types for admin routes.
 */
export type {
  AdminRateLimitStore,
  AdminRateLimitHitOptions,
  AdminRateLimitHitResult,
  CreateRedisRateLimitStoreOptions,
  RedisRateLimitClientLike,
  RedisRateLimitMultiLike,
} from './lib/rateLimitStore';
/**
 * Typed error classes thrown by the admin plugin.
 */
export {
  AdminAccessDeniedError,
  AdminAuditLogError,
  AdminConfigError,
  AdminRateLimitExceededError,
} from './errors';
