import { z } from 'zod';
import { disableRoutesSchema } from '@lastshotlabs/slingshot-core';
import { WEBHOOK_ROUTES } from '../routes/index';
import type { InboundProvider } from './inbound';
import type { WebhookQueue } from './queue';

/**
 * Zod schema for validating `WebhookPluginConfig`.
 */
export const webhookPluginConfigSchema = z.object({
  /** Subscribable event keys. Defaults to `['*']`. */
  events: z
    .array(z.string())
    .optional()
    .describe(
      "Event keys clients are allowed to subscribe to. Omit to allow the built-in default of ['*'].",
    ),
  /** Additional event keys to make subscribable beyond the built-in list. */
  extraEventKeys: z
    .array(z.string())
    .readonly()
    .optional()
    .describe(
      'Additional event keys exposed beyond the built-in webhook event list. Omit to use only the built-in keys.',
    ),
  /** Delivery queue implementation. Defaults to the in-process memory queue. */
  queue: z
    .union([
      z.literal('memory').describe('In-memory webhook delivery queue (development only).'),
      z.custom<WebhookQueue>(value => value != null && typeof value === 'object', {
        message: 'Expected a WebhookQueue instance',
      }),
    ])
    .optional()
    .describe(
      'Webhook delivery queue or built-in strategy. Defaults to in-memory queue when omitted.',
    ),
  /** Queue configuration overrides. */
  queueConfig: z
    .object({
      maxAttempts: z
        .number()
        .int()
        .positive()
        .optional()
        .describe(
          'Maximum delivery attempts before a webhook is marked failed. Omit to use the queue default.',
        ),
      retryBaseDelayMs: z
        .number()
        .positive()
        .optional()
        .describe(
          'Base retry delay in milliseconds for webhook redelivery backoff. Omit to use the queue default.',
        ),
    })
    .optional()
    .describe(
      'Retry configuration overrides for the webhook delivery queue. Omit to use the queue defaults.',
    ),
  /** Inbound webhook providers mounted under `<mountPath>/inbound/:provider`. */
  inbound: z
    .array(
      z.custom<InboundProvider>(value => value != null && typeof value === 'object', {
        message: 'Expected an InboundProvider instance',
      }),
    )
    .optional()
    .describe(
      'Inbound webhook providers mounted under the inbound webhook route. Omit to disable inbound providers.',
    ),
  /** Mount path for webhook routes. Default: `'/webhooks'`. */
  mountPath: z
    .string()
    .optional()
    .describe("URL path prefix for webhook routes. Omit to use '/webhooks'."),
  /** Role required for webhook management routes. Default: `'admin'`. */
  managementRole: z
    .string()
    .min(1)
    .optional()
    .describe("Role required for webhook management routes. Omit to use 'admin'."),
  /** Route groups to skip mounting. */
  disableRoutes: disableRoutesSchema(Object.values(WEBHOOK_ROUTES)).describe(
    'Route groups to skip when mounting webhook routes. Omit to mount all webhook routes.',
  ),
});

/**
 * Configuration object accepted by `createWebhookPlugin`.
 */
export type WebhookPluginConfig = z.infer<typeof webhookPluginConfigSchema>;
