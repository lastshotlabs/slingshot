import webpush from 'web-push';
import type { PushSendResult } from '../types/models';
import type { PushProvider } from './provider';

function classify(statusCode?: number): PushSendResult['reason'] {
  if (statusCode === 404 || statusCode === 410) return 'invalidToken';
  if (statusCode === 413) return 'payloadTooLarge';
  if (statusCode === 429) return 'rateLimited';
  return 'transient';
}

function parseRetryAfterMs(value: string | null | undefined): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.trunc(seconds * 1000);
  const dateMs = Date.parse(value);
  if (!Number.isNaN(dateMs)) return Math.max(0, dateMs - Date.now());
  return undefined;
}

function extractRetryAfterHeader(headers: unknown): string | null | undefined {
  if (!headers || typeof headers !== 'object') return undefined;
  // web-push surfaces response headers via the error object. Normalize the
  // common shapes (plain object vs. fetch-style Headers) to a string.
  const h = headers as { get?: (k: string) => string | null } & Record<string, unknown>;
  if (typeof h.get === 'function') {
    return h.get('retry-after');
  }
  const direct = h['retry-after'] ?? h['Retry-After'];
  if (typeof direct === 'string') return direct;
  if (Array.isArray(direct) && typeof direct[0] === 'string') return direct[0];
  return undefined;
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
    async send(subscription, message, context) {
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

      const idempotencyKey = context?.idempotencyKey;
      const headers: Record<string, string> = {};
      if (idempotencyKey) headers['X-Idempotency-Key'] = idempotencyKey;

      try {
        await webpush.sendNotification(
          {
            endpoint: subscription.platformData.endpoint,
            keys: subscription.platformData.keys,
          },
          JSON.stringify(message),
          {
            vapidDetails: config.vapid,
            headers,
          },
        );
        return { ok: true, providerIdempotencyKey: idempotencyKey };
      } catch (error) {
        const errObj = error as { statusCode?: number; headers?: unknown; body?: unknown };
        const statusCode = errObj.statusCode;
        const retryAfterMs = parseRetryAfterMs(extractRetryAfterHeader(errObj.headers));
        return {
          ok: false,
          reason: classify(statusCode),
          error: error instanceof Error ? error.message : 'web push send failed',
          retryAfterMs,
          providerIdempotencyKey: idempotencyKey,
        };
      }
    },
  };
}
