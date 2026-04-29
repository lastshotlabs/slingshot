import { z } from 'zod';
import { disableRoutesSchema } from '@lastshotlabs/slingshot-core';
import type { DispatchOptions } from '../lib/dispatcher';
import type { RateLimiter } from '../lib/rateLimit';
import type { SecretEncryptor } from '../lib/secretCipher';
import { WEBHOOK_ROUTES } from '../routes/index';
import type { WebhookAdapter } from './adapter';
import type { InboundProvider } from './inbound';
import type { WebhookQueue } from './queue';

function normalizeMountPath(value: string): string {
  const trimmed = value.trim();
  if (!trimmed.startsWith('/')) {
    throw new Error("mountPath must start with '/'");
  }

  const normalized = trimmed.replace(/\/+$/, '');
  if (normalized.length === 0) {
    throw new Error("mountPath must not be '/'");
  }

  return normalized;
}

/**
 * Zod schema for validating `WebhookPluginConfig`.
 */
export const webhookPluginConfigSchema = z.object({
  /** Registry-backed webhook event filters. Defaults to `['*']`. */
  events: z
    .array(z.string())
    .optional()
    .describe(
      "Registry-backed event filters the webhook plugin subscribes to. Omit to allow the default of ['*'].",
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
  /** Optional event-bus subscription settings for webhook intake. */
  busSubscription: z
    .object({
      durable: z
        .boolean()
        .optional()
        .describe(
          'When true, request a durable event-bus subscription so source events can survive process restarts on adapters that support it.',
        ),
      name: z
        .string()
        .min(1)
        .optional()
        .describe(
          'Stable durable subscriber name. Required when durable is true on queue-backed event bus adapters.',
        ),
    })
    .optional()
    .refine(
      value => !value?.durable || !!value.name,
      'busSubscription.name is required when busSubscription.durable is true',
    )
    .describe(
      'Controls how the webhook plugin subscribes to source events on the application bus. Omit to use a normal in-process subscription.',
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
    .transform(normalizeMountPath)
    .optional()
    .describe("URL path prefix for webhook routes. Omit to use '/webhooks'."),
  /** Role required for webhook management routes. Default: `'admin'`. */
  managementRole: z
    .string()
    .min(1)
    .optional()
    .describe("Role required for webhook management routes. Omit to use 'admin'."),
  /** Custom persistence adapter. When provided, slingshot-entity is not required. */
  adapter: z
    .custom<WebhookAdapter>(value => value != null && typeof value === 'object', {
      message: 'Expected a WebhookAdapter instance',
    })
    .optional()
    .describe(
      'Custom persistence adapter for webhook endpoints and deliveries. When provided, slingshot-entity is not required and entity-backed CRUD routes are skipped.',
    ),
  /**
   * Plugin-wide default timeout in milliseconds for outbound webhook delivery
   * requests. Per-endpoint `deliveryTimeoutMs` overrides this when set.
   * Must be a positive integer no greater than 120_000 ms (2 minutes) to
   * prevent worker starvation. Default: 30000.
   */
  deliveryTimeoutMs: z
    .number()
    .int()
    .positive()
    .max(120_000)
    .optional()
    .describe(
      'Default timeout in milliseconds for outbound webhook HTTP delivery requests. Per-endpoint overrides win when set. Maximum 120000 (2 minutes). Omit to use the default of 30000.',
    ),
  /**
   * Advanced outbound dispatch overrides. Production traffic should normally
   * use the default safeFetch transport; tests can inject `fetchImpl` and a
   * deterministic resolver without weakening SSRF validation.
   */
  dispatch: z
    .object({
      fetchImpl: z
        .custom<NonNullable<DispatchOptions['fetchImpl']>>(value => typeof value === 'function', {
          message: 'Expected a fetch-compatible function',
        })
        .optional()
        .describe(
          'Fetch-compatible transport override for outbound deliveries. Intended for tests or custom runtimes; SSRF validation still runs unless allowPrivateIps is passed per delivery.',
        ),
      safeFetchOverrides: z
        .object({
          isIpAllowed: z
            .custom<NonNullable<NonNullable<DispatchOptions['safeFetchOverrides']>['isIpAllowed']>>(
              value => typeof value === 'function',
              {
                message: 'Expected an IP allow predicate',
              },
            )
            .optional()
            .describe('Optional IP allow predicate override for outbound delivery validation.'),
          resolveHost: z
            .custom<NonNullable<NonNullable<DispatchOptions['safeFetchOverrides']>['resolveHost']>>(
              value => typeof value === 'function',
              {
                message: 'Expected a host resolver function',
              },
            )
            .optional()
            .describe('Optional host resolver override for outbound delivery validation.'),
        })
        .optional()
        .describe(
          'safeFetch resolver/IP-policy overrides shared by pre-fetch validation and the safe transport.',
        ),
    })
    .optional()
    .describe(
      'Advanced outbound delivery transport overrides. Omit to use the default safeFetch transport.',
    ),
  /**
   * Base64-encoded 32-byte AES-256-GCM key used to encrypt webhook endpoint
   * secrets at rest. When omitted, secrets are stored as plaintext and a
   * warning is logged at boot. Pre-existing plaintext secrets remain readable
   * after a key is configured; rotate them by re-saving the endpoint.
   */
  secretEncryptionKey: z
    .string()
    .min(1)
    .optional()
    .describe(
      'Base64 32-byte AES-256-GCM key for encrypting webhook endpoint secrets at rest. Recommended for production.',
    ),
  /**
   * Pluggable encryptor for webhook endpoint secrets at rest. Apps can supply
   * a KMS- or Vault-backed implementation. Takes precedence over
   * `secretEncryptionKey` when provided.
   */
  encryptor: z
    .custom<SecretEncryptor>(
      value =>
        value != null &&
        typeof value === 'object' &&
        typeof (value as SecretEncryptor).encrypt === 'function' &&
        typeof (value as SecretEncryptor).decrypt === 'function',
      {
        message: 'Expected a SecretEncryptor with encrypt() and decrypt() methods',
      },
    )
    .optional()
    .describe(
      'Custom secret encryptor. When provided, the runtime envelope-encrypts endpoint secrets through this implementation instead of using secretEncryptionKey.',
    ),
  /**
   * Explicitly permit plaintext endpoint secret storage in production when no
   * `secretEncryptionKey` or custom `encryptor` is configured. Defaults to false.
   */
  allowPlaintextSecrets: z
    .boolean()
    .optional()
    .describe(
      'Explicitly allow plaintext webhook endpoint secrets when encryption is not configured. Do not enable in production unless a custom adapter encrypts at rest.',
    ),
  // P-WEBHOOKS-5: removed plugin-wide `validateResolvedIp` opt-out. SSRF
  // protection now defaults on with no global escape hatch. Apps that
  // intentionally need to deliver to a private IP for a specific endpoint
  // (closed test environment) must pass `allowPrivateIps: true` per call
  // through `deliverWebhook` and accept the loud per-call warning.
  /**
   * Maximum body size accepted on inbound webhook routes, in bytes. Default: 1 MiB.
   */
  inboundMaxBodyBytes: z
    .number()
    .int()
    .positive()
    .optional()
    .describe('Maximum body size (bytes) accepted on inbound webhook routes. Defaults to 1 MiB.'),
  /**
   * Rate limiting for inbound webhook endpoints.
   *
   * When set, each inbound provider (e.g. 'stripe', 'github') is rate-limited
   * independently using an in-memory sliding window counter. Requests that exceed
   * the limit receive HTTP 429 with `Retry-After` and `X-RateLimit-*` headers.
   *
   * Provide a custom `RateLimiter` instance for distributed deployments (e.g. Redis
   * sliding window) or use the shorthand object form for the built-in per-process
   * limiter.
   *
   * Omit entirely to disable inbound rate limiting (not recommended in production).
   */
  inboundRateLimit: z
    .union([
      z
        .object({
          maxRequests: z
            .number()
            .int()
            .positive()
            .optional()
            .describe('Maximum requests per window per provider. Default: 100.'),
          windowMs: z
            .number()
            .int()
            .positive()
            .optional()
            .describe('Sliding window duration in milliseconds. Default: 60000 (1 minute).'),
        })
        .describe('Built-in sliding window rate limiter options.'),
      z
        .custom<RateLimiter>(
          (value): value is RateLimiter =>
            typeof value === 'object' &&
            value !== null &&
            typeof (value as { check?: unknown }).check === 'function',
          {
            message: 'Expected a RateLimiter with a check() method',
          },
        )
        .describe('Custom RateLimiter instance (e.g. Redis-backed).'),
    ])
    .optional()
    .describe(
      'Rate limiting for inbound webhook endpoints. Omit to disable inbound rate limiting.',
    ),
  /** Route groups to skip mounting. */
  disableRoutes: disableRoutesSchema(Object.values(WEBHOOK_ROUTES)).describe(
    'Route groups to skip when mounting webhook routes. Omit to mount all webhook routes.',
  ),
});

/**
 * Configuration object accepted by `createWebhookPlugin`.
 */
export type WebhookPluginConfig = z.infer<typeof webhookPluginConfigSchema>;
