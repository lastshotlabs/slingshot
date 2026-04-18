import webpush from 'web-push';
import type { PushSendResult } from '../types/models';
import type { PushProvider } from './provider';

function classify(statusCode?: number): PushSendResult['reason'] {
  if (statusCode === 404 || statusCode === 410) return 'invalidToken';
  if (statusCode === 413) return 'payloadTooLarge';
  if (statusCode === 429) return 'rateLimited';
  return 'transient';
}

/**
 * Create a Web Push provider using the VAPID protocol.
 *
 * Uses the `web-push` npm package to sign and deliver push messages to browser
 * subscription endpoints. Only supports alert (non-silent) pushes — silent push
 * is not a Web Push concept and will return a `payloadTooLarge` failure.
 *
 * @param config - VAPID credentials for signing outgoing push requests.
 * @param config.vapid.publicKey - URL-safe base64-encoded VAPID public key.
 * @param config.vapid.privateKey - URL-safe base64-encoded VAPID private key.
 * @param config.vapid.subject - `mailto:` or `https:` URI identifying the push sender.
 * @returns A `PushProvider` for the `web` platform.
 *
 * @example
 * ```ts
 * import { createWebPushProvider } from './providers/web';
 * const provider = createWebPushProvider({
 *   vapid: {
 *     publicKey: process.env.VAPID_PUBLIC_KEY!,
 *     privateKey: process.env.VAPID_PRIVATE_KEY!,
 *     subject: 'mailto:push@example.com',
 *   },
 * });
 * ```
 */
export function createWebPushProvider(config: {
  vapid: { publicKey: string; privateKey: string; subject: string };
}): PushProvider {
  return {
    platform: 'web',
    async send(subscription, message) {
      if (message.silent) {
        return {
          ok: false,
          reason: 'payloadTooLarge',
          error: 'silent push is not supported on web push',
        };
      }

      if (subscription.platformData.platform !== 'web') {
        return { ok: false, reason: 'transient', error: 'subscription platform mismatch' };
      }

      try {
        await webpush.sendNotification(
          {
            endpoint: subscription.platformData.endpoint,
            keys: subscription.platformData.keys,
          },
          JSON.stringify(message),
          {
            vapidDetails: config.vapid,
          },
        );
        return { ok: true };
      } catch (error) {
        const statusCode = (error as { statusCode?: number }).statusCode;
        return {
          ok: false,
          reason: classify(statusCode),
          error: error instanceof Error ? error.message : 'web push send failed',
        };
      }
    },
  };
}
