import { z } from 'zod';

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
 * Runtime schema for validating notifications plugin configuration.
 */
export const notificationsPluginConfigSchema = z.object({
  mountPath: z
    .string()
    .default('/notifications')
    .transform(value => normalizeMountPath(value))
    .describe(
      "URL path prefix for notification routes. Must start with '/'. Trailing slashes are trimmed. Default: /notifications.",
    ),
  sseEnabled: z
    .boolean()
    .default(true)
    .describe('Whether the notification SSE stream is mounted. Default: true.'),
  ssePath: z
    .string()
    .default('/notifications/sse')
    .transform(value => normalizeMountPath(value))
    .describe(
      "URL path for the notification SSE endpoint. Must start with '/'. Trailing slashes are trimmed. Default: /notifications/sse.",
    ),
  dispatcher: z
    .object({
      enabled: z
        .boolean()
        .default(true)
        .describe('Whether the notification dispatcher loop runs. Default: true.'),
      intervalMs: z
        .number()
        .int()
        .positive()
        .default(30_000)
        .describe('Dispatcher polling interval in milliseconds. Default: 30,000.'),
      maxPerTick: z
        .number()
        .int()
        .positive()
        .default(500)
        .describe('Maximum queued notifications processed per dispatcher tick. Default: 500.'),
    })
    .default({
      enabled: true,
      intervalMs: 30_000,
      maxPerTick: 500,
    })
    .describe(
      'Dispatcher loop settings for queued notification delivery. Default: enabled=true, intervalMs=30000, maxPerTick=500.',
    ),
  rateLimit: z
    .object({
      perSourcePerUserPerWindow: z
        .number()
        .int()
        .positive()
        .default(100)
        .describe(
          'Maximum notifications allowed per source and user within one window. Default: 100.',
        ),
      windowMs: z
        .number()
        .int()
        .positive()
        .default(3_600_000)
        .describe('Rate-limit window duration in milliseconds. Default: 3,600,000.'),
      backend: z
        .string()
        .default('memory')
        .describe('Backend used to track notification rate limits. Default: memory.'),
    })
    .default({
      perSourcePerUserPerWindow: 100,
      windowMs: 3_600_000,
      backend: 'memory',
    })
    .describe(
      'Rate-limiting settings for notification fan-out. Default: perSourcePerUserPerWindow=100, windowMs=3600000, backend=memory.',
    ),
  defaultPreferences: z
    .object({
      pushEnabled: z
        .boolean()
        .default(true)
        .describe('Default push-notification preference for new subscriptions. Default: true.'),
      emailEnabled: z
        .boolean()
        .default(true)
        .describe('Default email-notification preference for new subscriptions. Default: true.'),
      inAppEnabled: z
        .boolean()
        .default(true)
        .describe('Default in-app notification preference for new subscriptions. Default: true.'),
    })
    .default({
      pushEnabled: true,
      emailEnabled: true,
      inAppEnabled: true,
    })
    .describe(
      'Default channel preferences applied when a user has not stored explicit notification preferences. Default: push=true, email=true, inApp=true.',
    ),
  /**
   * Maximum age (ms) a notification is retained. When set, listByUser /
   * listUnread results filter out rows older than this, and a periodic
   * sweep deletes them outright. `0` disables both filtering and the
   * sweeper. Default: `0` (no TTL).
   */
  notificationTtlMs: z
    .number()
    .int()
    .nonnegative()
    .default(0)
    .describe(
      'Maximum age (ms) a notification record is retained before being filtered from list responses and deleted by the periodic sweeper. 0 disables.',
    ),
  /**
   * Interval (ms) for the periodic sweep that deletes notifications older
   * than `notificationTtlMs`. Ignored when `notificationTtlMs === 0`.
   * Default: 1 hour.
   */
  notificationSweepIntervalMs: z
    .number()
    .int()
    .positive()
    .default(60 * 60_000)
    .describe(
      'Interval (ms) for the periodic notification expiry sweep. Default: 3,600,000 (1 hour).',
    ),
});

/** Resolved configuration object for the notifications plugin, inferred from {@link notificationsPluginConfigSchema}. */
export type NotificationsPluginConfig = z.infer<typeof notificationsPluginConfigSchema>;
