import { z } from 'zod';
import type { MailRenderer, SlingshotEventMap } from '@lastshotlabs/slingshot-core';
import type { MailAddress, MailProvider } from './provider';
import type { MailQueue, MailQueueConfig } from './queue';
import type { MailJob } from './queue';

/**
 * Declarative binding from a bus event to a mail template.
 *
 * When the bus emits `event`, the plugin resolves the recipient via `recipientMapper`,
 * renders `template` with data from `dataMapper`, and enqueues a delivery.
 *
 * @template K - The event key from `SlingshotEventMap`.
 */
export interface MailSubscription<K extends keyof SlingshotEventMap = keyof SlingshotEventMap> {
  /** Bus event key to subscribe to. */
  event: K;
  /** Template name passed to the renderer's `render()` method. */
  template: string;
  /**
   * Overrides the subject produced by the renderer.
   * If the renderer already returns a subject, this value takes precedence.
   */
  subject?: string;
  /** Transforms the event payload into a data bag for the renderer. Defaults to passing the payload as-is. */
  dataMapper?: (payload: SlingshotEventMap[K]) => Record<string, unknown>;
  /**
   * Extracts the recipient email or `MailAddress` from the event payload.
   * When omitted, `config.from` is used as a fallback (generally not useful — provide this).
   */
  recipientMapper?: (payload: SlingshotEventMap[K]) => string | MailAddress;
  /** Provider-specific tags forwarded verbatim to the mail provider (e.g. for analytics). */
  tags?: Record<string, string>;
}

export interface MailSubscriptionDrop {
  /** Event bus key that triggered the subscription handler. */
  event: string;
  /** Template configured for the subscription. */
  template: string;
  /** Why the subscription did not produce an enqueued mail job. */
  reason:
    | 'missing-recipient'
    | 'template-not-found'
    | 'enqueue-timeout'
    | 'enqueue-error'
    | 'handler-error';
  /** Original event payload. Avoid logging this wholesale in production. */
  payload: unknown;
  /** Error that caused the drop, when available. */
  error?: Error;
}

const mailAddressSchema = z.union([
  z.string(),
  z
    .object({
      name: z
        .string()
        .optional()
        .describe(
          'Display name used with the email address. Omit to send the address without a name.',
        ),
      email: z.string().describe('Email address used for the sender or recipient.'),
    })
    .loose(),
]);

/**
 * Zod schema for validating `MailPluginConfig` at runtime.
 * Used internally by `createMailPlugin` — call `validatePluginConfig` against this.
 *
 * @example
 * ```ts
 * import { mailPluginConfigSchema } from '@lastshotlabs/slingshot-mail';
 * const result = mailPluginConfigSchema.safeParse(rawConfig);
 * ```
 */
export const mailPluginConfigSchema = z.object({
  /** Mail delivery provider (Resend, SES, etc.) */
  provider: z
    .custom<MailProvider>(v => v != null && typeof v === 'object', {
      message: 'Expected a MailProvider instance',
    })
    .describe('Mail delivery provider implementation used to send rendered messages.'),
  /** Template renderer (React Email, raw HTML, etc.) */
  renderer: z
    .custom<MailRenderer>(v => v != null && typeof v === 'object', {
      message: 'Expected a MailRenderer instance',
    })
    .describe('Template renderer used to turn mail templates into subjects and bodies.'),
  /** Default "from" address for all mail */
  from: mailAddressSchema.describe('Default sender address used for outgoing mail.'),
  /** Mail queue for async delivery */
  queue: z
    .custom<MailQueue>(v => v != null && typeof v === 'object', {
      message: 'Expected a MailQueue instance',
    })
    .optional()
    .describe(
      'Queue implementation for asynchronous mail delivery. Omit to use immediate delivery.',
    ),
  /** Queue configuration overrides */
  queueConfig: z
    .custom<MailQueueConfig>(v => v != null && typeof v === 'object', {
      message: 'Expected a MailQueueConfig object',
    })
    .optional()
    .describe(
      'Queue configuration overrides for the configured mail queue. Omit to use the queue defaults.',
    ),
  /** Default "reply-to" address */
  replyTo: mailAddressSchema
    .optional()
    .describe('Default reply-to address for outgoing mail. Omit to leave reply-to unset.'),
  /** Event bus subscriptions that trigger mail sends */
  subscriptions: z
    .array(
      z.custom<MailSubscription>(v => v != null && typeof v === 'object', {
        message: 'Expected a MailSubscription object',
      }),
    )
    .optional()
    .describe(
      'Event-bus subscriptions that trigger mail sends. Omit to disable event-driven mail delivery.',
    ),
  /** Timeout for subscription-triggered queue.enqueue() calls. Default: 30000. */
  subscriptionEnqueueTimeoutMs: z
    .number()
    .int()
    .nonnegative()
    .optional()
    .describe(
      'Maximum milliseconds a subscription handler may wait for queue.enqueue(). Set 0 to disable the timeout.',
    ),
  /** Called when a subscription event cannot be converted into an enqueued mail job. */
  onSubscriptionDrop: z
    .custom<(drop: MailSubscriptionDrop) => void | Promise<void>>(v => typeof v === 'function', {
      message: 'Expected a function',
    })
    .optional()
    .describe(
      'Callback invoked when an event-driven mail subscription drops a payload before enqueueing.',
    ),
  /** Use durable bus subscriptions (requires BullMQ adapter). Default: false */
  durableSubscriptions: z
    .boolean()
    .optional()
    .describe(
      'Whether event-bus subscriptions use durable queue-backed delivery. Omit to use transient subscriptions.',
    ),
  /** Called when a mail job exhausts all retries */
  onDeadLetter: z
    .custom<(job: MailJob, error: Error) => void>(v => typeof v === 'function', {
      message: 'Expected a function',
    })
    .optional()
    .describe(
      'Callback invoked when a mail job exhausts all retries. Omit to leave dead-letter handling to the queue.',
    ),
  /** Validate that all subscription templates exist on startup. Default: true */
  validateTemplatesOnStartup: z
    .boolean()
    .optional()
    .describe(
      'Whether all subscription templates are checked at startup. Omit to use the plugin default startup validation behavior.',
    ),
});

/**
 * Configuration object accepted by `createMailPlugin`.
 * Inferred from `mailPluginConfigSchema` — use the schema for runtime validation.
 */
export type MailPluginConfig = z.infer<typeof mailPluginConfigSchema>;
