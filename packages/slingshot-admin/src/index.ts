/**
 * Thin pass-through plugin — wires an AdminAccessProvider and ManagedUserProvider
 * into the Slingshot framework. Has no storage adapter of its own; persistence is
 * delegated to the configured providers (e.g. slingshot-auth).
 * If admin grows into a full plugin (own storage, queues, etc.), scaffold the
 * full canonical structure at that time.
 */
export { createAdminPlugin } from './plugin';
export { adminPluginConfigSchema } from './types/config';
export type { AdminPluginConfig } from './types/config';
export type { AdminEnv, AdminVariables } from './types/env';
export { createAuth0AccessProvider } from './providers/auth0Access';
export type { Auth0AccessProviderConfig } from './providers/auth0Access';
export { registerAdminResourceTypes } from './lib/resourceTypes';
export { createMemoryRateLimitStore, createRedisRateLimitStore } from './lib/rateLimitStore';
export type {
  AdminRateLimitStore,
  AdminRateLimitHitOptions,
  AdminRateLimitHitResult,
  CreateRedisRateLimitStoreOptions,
  RedisRateLimitClientLike,
  RedisRateLimitMultiLike,
} from './lib/rateLimitStore';
