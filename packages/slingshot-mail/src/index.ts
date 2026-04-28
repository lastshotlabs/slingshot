/**
 * Mail plugin — deviates from the canonical adapter scaffold intentionally:
 *
 * - Uses providers/ + queues/ + renderers/ instead of adapters/, because mail
 *   delivery involves three orthogonal concerns (transport, buffering, templating)
 *   that don't collapse cleanly into a single adapter interface.
 * - Test factories live in `./testing` (see `src/testing.ts`); smoke/integration
 *   tests under `tests/smoke/` and `tests/integration/` organise by source type.
 */

// Plugin
export { createMailPlugin } from './plugin';

// Errors
export { MailTemplateNotFoundError, validateSubscriptionTemplates } from './lib/subscriptionWiring';
export { MailCircuitOpenError } from './lib/circuitBreaker';
export type {
  MailCircuitBreaker,
  MailCircuitBreakerHealth,
  MailCircuitBreakerOptions,
} from './lib/circuitBreaker';

// Types
export { mailPluginConfigSchema } from './types/config';
export type { MailPluginConfig, MailSubscription } from './types/config';
export type { MailProvider, MailMessage, SendResult, MailAddress } from './types/provider';
export { MailSendError } from './types/provider';
export type { MailQueue, MailJob, MailQueueConfig } from './types/queue';

// Providers
export { createResendProvider } from './providers/resend';
export { createSesProvider } from './providers/ses';
export { createPostmarkProvider } from './providers/postmark';
export { createSendgridProvider } from './providers/sendgrid';

// Queues
export { createMemoryQueue } from './queues/memory';
export { createBullMQMailQueue } from './queues/bullmq';

// Renderers
export { createRawHtmlRenderer } from './renderers/rawHtml';
export type { RawHtmlTemplate } from './renderers/rawHtml';
export { createReactEmailRenderer } from './renderers/reactEmail';
