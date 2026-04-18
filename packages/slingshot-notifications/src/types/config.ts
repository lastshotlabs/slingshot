import { z } from 'zod';

export const notificationsPluginConfigSchema = z.object({
  mountPath: z
    .string()
    .startsWith('/')
    .default('/notifications')
    .describe('URL path prefix for notification routes. Default: /notifications.'),
  sseEnabled: z
    .boolean()
    .default(true)
    .describe('Whether the notification SSE stream is mounted. Default: true.'),
  ssePath: z
    .string()
    .startsWith('/')
    .default('/notifications/sse')
    .describe('URL path for the notification SSE endpoint. Default: /notifications/sse.'),
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
});

export type NotificationsPluginConfig = z.infer<typeof notificationsPluginConfigSchema>;
