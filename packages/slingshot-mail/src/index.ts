/**
 * Mail plugin — deviates from the canonical adapter scaffold intentionally:
 *
 * - Uses providers/ + queues/ + renderers/ instead of adapters/, because mail
 *   delivery involves three orthogonal concerns (transport, buffering, templating)
 *   that don't collapse cleanly into a single adapter interface.
 * - Test factories live in `./testing` (see `src/testing.ts`); smoke/integration
 *   tests under `tests/smoke/` and `tests/integration/` organise by source type.
 */

/**
 * Create the mail plugin with providers, queues, renderers, and subscriptions.
 */
export { createMailPlugin } from './plugin';

/**
 * Subscription template validation helpers and template lookup errors.
 */
export { MailTemplateNotFoundError, validateSubscriptionTemplates } from './lib/subscriptionWiring';
/**
 * Circuit-breaker error thrown when the configured mail breaker is open.
 */
export { MailCircuitOpenError } from './lib/circuitBreaker';
/**
 * Circuit-breaker contracts, health shape, and tuning options for mail delivery.
 */
export type {
  MailCircuitBreaker,
  MailCircuitBreakerHealth,
  MailCircuitBreakerOptions,
} from './lib/circuitBreaker';

/**
 * Zod schema used to validate mail plugin configuration.
 */
export { mailPluginConfigSchema } from './types/config';
/**
 * Mail plugin configuration and subscription mapping types.
 */
export type { MailPluginConfig, MailSubscription } from './types/config';
/**
 * Provider contracts and message payload types used by mail transports.
 */
export type { MailProvider, MailMessage, SendResult, MailAddress } from './types/provider';
/**
 * Error raised when a provider fails to send a mail message.
 */
export { MailSendError } from './types/provider';
/**
 * Queue contract, job payload, and queue configuration for buffered mail delivery.
 */
export type { MailQueue, MailJob, MailQueueConfig } from './types/queue';

/**
 * Create a Resend-backed mail provider.
 */
export { createResendProvider } from './providers/resend';
/**
 * Create an AWS SES-backed mail provider.
 */
export { createSesProvider } from './providers/ses';
/**
 * Create a Postmark-backed mail provider.
 */
export { createPostmarkProvider } from './providers/postmark';
/**
 * Create a SendGrid-backed mail provider.
 */
export { createSendgridProvider } from './providers/sendgrid';

/**
 * Create the in-memory queue for local and test mail delivery.
 */
export { createMemoryQueue } from './queues/memory';
/**
 * Create the BullMQ-backed queue for durable mail delivery.
 */
export { createBullMQMailQueue } from './queues/bullmq';

/**
 * Create a renderer for raw HTML mail templates.
 */
export { createRawHtmlRenderer } from './renderers/rawHtml';
/**
 * Raw HTML template shape accepted by the raw HTML renderer.
 */
export type { RawHtmlTemplate } from './renderers/rawHtml';
/**
 * Create a renderer for React Email templates.
 */
export { createReactEmailRenderer } from './renderers/reactEmail';
