/**
 * Create the push package with subscriptions, topics, delivery tracking, and providers.
 */
export { createPushPackage } from './plugin';
/**
 * Provider-owned package contract for cross-package consumers.
 */
export { Push, PushRuntimeCap, PushHealthCap } from './public';
/** Aggregated health snapshot type for the push package. */
export type { PushPluginHealth } from './public';
/**
 * Runtime state and compiled formatter table exposed by the push plugin.
 */
export type { PushPluginState, CompiledPushFormatterTable } from './state';
/**
 * Zod schema used to validate push plugin configuration.
 */
export { pushPluginConfigSchema } from './types/config';
/**
 * Push plugin configuration, formatter, credential, and route key types.
 */
export type {
  PushPluginConfig,
  PushFormatterFn,
  PushFormatterTemplate,
  ApnsAuthInput,
  FirebaseServiceAccount,
  PushRouteKey,
} from './types/config';
/**
 * Push model, platform, message, defaults, and send-result types.
 */
export type {
  PushPlatform,
  PlatformData,
  PushSubscriptionRecord as PushSubscription,
  PushTopicRecord as PushTopic,
  PushTopicMembershipRecord as PushTopicMembership,
  PushDeliveryRecord as PushDelivery,
  PushMessage,
  NotificationDefaults,
  PushSendResult,
} from './types/models';
/**
 * Push subscription entity config and generated operations.
 */
export {
  PushSubscription as PushSubscriptionEntity,
  pushSubscriptionOperations,
} from './entities/pushSubscription';
/**
 * Push topic entity config and generated operations.
 */
export { PushTopic as PushTopicEntity, pushTopicOperations } from './entities/pushTopic';
/**
 * Push topic membership entity config and generated operations.
 */
export {
  PushTopicMembership as PushTopicMembershipEntity,
  pushTopicMembershipOperations,
} from './entities/pushTopicMembership';
/**
 * Push delivery entity config and generated operations.
 */
export {
  PushDelivery as PushDeliveryEntity,
  pushDeliveryOperations,
} from './entities/pushDelivery';
/**
 * Test factories for push subscriptions, topics, memberships, and delivery records.
 */
export {
  pushSubscriptionFactories,
  pushTopicFactories,
  pushTopicMembershipFactories,
  pushDeliveryFactories,
} from './entities/factories';
/**
 * Push provider contract and health payload shape.
 */
export type { PushProvider, PushProviderHealth } from './providers/provider';
/**
 * Create the push router used by routes and programmatic sends.
 */
export { createPushRouter } from './router';
/**
 * Push router contracts, repository dependencies, and send-result summaries.
 */
export type { PushRouter, PushRouterRepos, PushSendResultSummary } from './router';
/**
 * Compile configured formatter templates into executable formatter functions.
 */
export { compilePushFormatters } from './formatter';
/**
 * Create the delivery adapter used to persist push delivery attempts.
 */
export { createPushDeliveryAdapter } from './deliveryAdapter';
/**
 * Build deterministic provider idempotency keys and UUIDs from stable keys.
 */
export { buildProviderIdempotencyKey, deriveUuidV4FromKey } from './lib/idempotency';

/**
 * Typed error classes for push delivery failures and router-level issues.
 */
export {
  ApnsDeliveryError,
  FcmTokenError,
  PushRouterError,
  PushTopicFanoutError,
  WebPushDeliveryError,
} from './errors';
