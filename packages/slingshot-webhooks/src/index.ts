/**
 * Register webhook event types on the Slingshot event map.
 */
import './events';

/**
 * Create the webhooks plugin with endpoint management, signing, queues, and delivery.
 */
export { createWebhookPlugin } from './plugin';
/**
 * Route identifiers mounted by the webhooks plugin.
 */
export { WEBHOOK_ROUTES } from './routes/index';
/**
 * Webhook route identifier type.
 */
export type { WebhookRoute } from './routes/index';
/**
 * Plugin state key used to retrieve webhooks runtime state from app context.
 */
export { WEBHOOKS_PLUGIN_STATE_KEY } from './types/public';

/**
 * Zod schema used to validate webhooks plugin configuration.
 */
export { webhookPluginConfigSchema } from './types/config';
/**
 * Configuration accepted by `createWebhookPlugin()`.
 */
export type { WebhookPluginConfig } from './types/config';
/**
 * Adapter contract for webhook endpoint and delivery persistence.
 */
export type { WebhookAdapter } from './types/adapter';
/**
 * Webhook endpoint, subscription, delivery, attempt, owner, and exposure model types.
 */
export type {
  WebhookEndpoint,
  WebhookEndpointSubscription,
  WebhookEndpointSubscriptionInput,
  WebhookDelivery,
  WebhookAttempt,
  DeliveryStatus,
  WebhookOwnerType,
  WebhookSubscriber,
  WebhookSubscriptionExposure,
} from './types/models';
/**
 * Queue contract and job payload type for webhook delivery.
 */
export type { WebhookQueue, WebhookJob } from './types/queue';
/**
 * Webhook delivery and secret-decryption errors raised by queue processing.
 */
export { WebhookDeliveryError, WebhookSecretDecryptError } from './types/queue';
/**
 * Provider contract for inbound webhook integrations.
 */
export type { InboundProvider } from './types/inbound';
/**
 * Safely parse an inbound webhook request body.
 */
export { safeParseInboundBody } from './lib/inbound';
/**
 * Result type returned by inbound body parsing.
 */
export type { SafeParseInboundBodyResult } from './lib/inbound';

/**
 * Create the in-memory webhook adapter for local and test use.
 */
export { createMemoryWebhookAdapter } from './adapters/memory';
/**
 * In-memory webhook adapter contract.
 */
export type { MemoryWebhookAdapter } from './adapters/memory';
/**
 * Create the in-memory delivery queue for webhook jobs.
 */
export { createWebhookMemoryQueue } from './queues/memory';

/**
 * Sign and verify webhook payloads using the framework signing helpers.
 */
export { signPayload, verifySignature } from './lib/signing';
/**
 * Secret encryption contracts used to protect webhook endpoint secrets.
 */
export type { SecretEncryptor, SecretCipher } from './lib/secretCipher';
/**
 * Create a secret cipher from the configured encryption provider.
 */
export { createSecretCipher } from './lib/secretCipher';

/**
 * Rate limiter contract and built-in sliding window implementation for inbound webhook endpoints.
 */
export { createSlidingWindowRateLimiter } from './lib/rateLimit';
/**
 * Rate limiter contract and result types.
 */
export type { RateLimiter, RateLimitResult, SlidingWindowRateLimiterOptions } from './lib/rateLimit';
