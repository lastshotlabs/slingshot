import { z } from 'zod';
import type { NotificationRecord } from '@lastshotlabs/slingshot-core';
import type { PushMessage, PushPlatform } from './models';

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

/** Imperative formatter escape hatch used after config compilation. */
export type PushFormatterFn = (
  notification: NotificationRecord,
  defaults?: Partial<PushMessage>,
) => PushMessage;

/** Declarative formatter template. */
export interface PushFormatterTemplate {
  /** Notification title template. */
  readonly titleTemplate: string;
  /** Optional body template. */
  readonly bodyTemplate?: string;
  /** Optional JSON payload template map. */
  readonly dataTemplate?: Record<string, string>;
  /** Optional icon URL override. */
  readonly iconUrl?: string;
  /** Notification-data field whose value should become the badge URL/string. */
  readonly badgeField?: string;
}

/** Minimal FCM service-account fields required by the HTTP v1 provider. */
export interface FirebaseServiceAccount {
  readonly project_id: string;
  readonly client_email: string;
  readonly private_key: string;
  readonly token_uri?: string;
}

/** APNS auth input accepted by the plugin config and manifest bootstrap. */
export type ApnsAuthInput = {
  readonly kind: 'p8-token';
  readonly keyPem: string;
  readonly keyId: string;
  readonly teamId: string;
};

const pushFormatterTemplateSchema = z.object({
  titleTemplate: z
    .string()
    .min(1)
    .describe('Template string used to render the notification title.'),
  bodyTemplate: z
    .string()
    .optional()
    .describe('Template string used to render the notification body. Omit to send no body text.'),
  dataTemplate: z
    .record(z.string(), z.string())
    .optional()
    .describe(
      'Template map used to render the JSON payload sent with the notification. Omit to send no extra data payload.',
    ),
  iconUrl: z
    .string()
    .optional()
    .describe(
      'Icon URL override applied to notifications using this formatter. Omit to use the notification defaults.',
    ),
  badgeField: z
    .string()
    .optional()
    .describe(
      'Notification data field whose value becomes the badge URL or string. Omit to leave the badge unchanged.',
    ),
});

/** Manifest-safe config schema for `createPushPlugin()`. */
export const pushPluginConfigSchema = z
  .object({
    web: z
      .object({
        vapid: z
          .object({
            publicKey: z
              .string()
              .min(1)
              .describe('Public VAPID key used by browser push subscriptions.'),
            privateKey: z
              .string()
              .min(1)
              .describe('Private VAPID key used to sign browser push requests.'),
            subject: z
              .string()
              .min(1)
              .describe('VAPID subject claim sent with browser push requests.'),
          })
          .describe('VAPID credentials for browser push delivery.'),
      })
      .optional()
      .describe('Web push configuration for browser clients. Omit when web push is not enabled.'),
    ios: z
      .object({
        auth: z
          .object({
            kind: z
              .literal('p8-token')
              .describe('APNS authentication mode. Only p8-token is supported.'),
            keyPem: z
              .string()
              .min(1)
              .describe('PEM-encoded APNS signing key used for token-based authentication.'),
            keyId: z.string().min(1).describe('Apple key ID for the APNS signing key.'),
            teamId: z.string().min(1).describe('Apple team ID that owns the APNS signing key.'),
          })
          .describe('APNS authentication credentials for iOS push delivery.'),
        defaultBundleId: z
          .string()
          .optional()
          .describe(
            'Default iOS app bundle identifier used when a notification does not provide one. Omit to require bundle IDs per target.',
          ),
        defaultEnvironment: z
          .enum(['sandbox', 'production'])
          .optional()
          .describe(
            'Default APNS environment. One of: sandbox, production. Omit to use the provider default.',
          ),
      })
      .optional()
      .describe('iOS push configuration for APNS delivery. Omit when iOS push is not enabled.'),
    android: z
      .object({
        serviceAccount: z
          .union([
            z.string().min(1),
            z.object({
              project_id: z
                .string()
                .min(1)
                .describe('Firebase project ID used for Android push delivery.'),
              client_email: z
                .email()
                .describe('Service-account client email used to authenticate with Firebase.'),
              private_key: z
                .string()
                .min(1)
                .describe('Service-account private key used to authenticate with Firebase.'),
              token_uri: z
                .url()
                .optional()
                .describe(
                  'OAuth token endpoint for the Firebase service account. Omit to use the Google default token URI.',
                ),
            }),
          ])
          .describe(
            'Firebase service account credentials or JSON string used for Android push delivery.',
          ),
      })
      .optional()
      .describe(
        'Android push configuration for Firebase delivery. Omit when Android push is not enabled.',
      ),
    enabledPlatforms: z
      .array(z.enum(['web', 'ios', 'android']))
      .min(1)
      .describe('Platforms this plugin should deliver to. One or more of: web, ios, android.'),
    notifications: z
      .object({
        icon: z
          .string()
          .optional()
          .describe('Default notification icon URL. Omit to send no default icon.'),
        badge: z
          .string()
          .optional()
          .describe(
            'Default badge URL or string for notifications. Omit to send no default badge.',
          ),
        defaultUrl: z
          .string()
          .optional()
          .describe(
            'Default URL opened when a notification is clicked. Omit to leave click handling to the client.',
          ),
      })
      .optional()
      .describe(
        'Default notification presentation settings. Omit to send notifications without plugin-level presentation defaults.',
      ),
    formatters: z
      .record(z.string(), pushFormatterTemplateSchema)
      .optional()
      .describe(
        'Named formatter templates used to turn notification records into push payloads. Omit to register no formatter templates.',
      ),
    retries: z
      .object({
        maxAttempts: z
          .number()
          .int()
          .positive()
          .optional()
          .describe(
            'Maximum delivery attempts before a push job is abandoned. Omit to use the plugin default.',
          ),
        initialDelayMs: z
          .number()
          .int()
          .nonnegative()
          .optional()
          .describe(
            'Initial retry delay in milliseconds for push redelivery. Omit to use the plugin default.',
          ),
      })
      .optional()
      .describe(
        'Retry policy for failed push deliveries. Omit to use the plugin default retry policy.',
      ),
    mountPath: z
      .string()
      .default('/push')
      .transform(value => normalizeMountPath(value))
      .describe(
        "URL path prefix for push routes. Must start with '/'. Trailing slashes are trimmed. Default: /push.",
      ),
    providerTimeoutMs: z
      .number()
      .int()
      .nonnegative()
      .optional()
      .describe(
        'Maximum milliseconds for a single provider.send() call. Default: 30000. Set 0 to disable.',
      ),
    topicMaxRecipients: z
      .number()
      .int()
      .positive()
      .optional()
      .describe(
        'Hard cap on subscriptions delivered per publishTopic call. Default: 10000. Excess members are skipped and surfaced via push:topic.fanout.truncated.',
      ),
  })
  .superRefine((config, ctx) => {
    for (const platform of config.enabledPlatforms) {
      if (platform === 'web' && !config.web) {
        ctx.addIssue({
          code: 'custom',
          message: 'web config is required when web is enabled',
        });
      }
      if (platform === 'ios' && !config.ios) {
        ctx.addIssue({
          code: 'custom',
          message: 'ios config is required when ios is enabled',
        });
      }
      if (platform === 'android' && !config.android) {
        ctx.addIssue({
          code: 'custom',
          message: 'android config is required when android is enabled',
        });
      }
    }
  });

/** Validated and transformed push plugin configuration produced by {@link pushPluginConfigSchema}. */
export type PushPluginConfig = z.output<typeof pushPluginConfigSchema>;
/** Bespoke routes owned by the push plugin. */
export type PushRouteKey =
  | 'GET /vapid-public-key'
  | 'POST /topics/:topicName/subscribe'
  | 'POST /topics/:topicName/unsubscribe'
  | 'POST /ack/:deliveryId';
export type { PushPlatform };
