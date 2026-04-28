import { createPrivateKey, createSign } from 'node:crypto';
import { deriveUuidV4FromKey } from '../lib/idempotency';
import type { ApnsAuthInput } from '../types/config';
import type { PushProvider } from './provider';

function base64UrlEncode(input: Buffer | string): string {
  const buffer = Buffer.isBuffer(input) ? input : Buffer.from(input);
  return buffer.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function parseRetryAfterMs(value: string | null): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.trunc(seconds * 1000);
  const dateMs = Date.parse(value);
  if (!Number.isNaN(dateMs)) return Math.max(0, dateMs - Date.now());
  return undefined;
}

/**
 * JWT-based APNS auth token provider.
 *
 * Generates and caches a signed ES256 JWT for use as an APNs bearer token.
 * Tokens are cached for up to 50 minutes and auto-renewed when they are
 * within 30 seconds of expiry.
 */
export class ApnsTokenAuth {
  private cachedToken: { token: string; expiresAt: number } | null = null;

  constructor(private readonly input: ApnsAuthInput) {}

  /**
   * Return a valid APNS bearer token, generating a new one if the cached token
   * has expired or will expire within 30 seconds.
   */
  getToken(): string {
    const now = Date.now();
    if (this.cachedToken && this.cachedToken.expiresAt > now + 30_000) {
      return this.cachedToken.token;
    }

    const header = base64UrlEncode(JSON.stringify({ alg: 'ES256', kid: this.input.keyId }));
    const claims = base64UrlEncode(
      JSON.stringify({
        iss: this.input.teamId,
        iat: Math.floor(now / 1000),
      }),
    );
    const signer = createSign('SHA256');
    signer.update(`${header}.${claims}`);
    signer.end();
    const signature = signer.sign(createPrivateKey(this.input.keyPem));
    const token = `${header}.${claims}.${base64UrlEncode(signature)}`;
    this.cachedToken = {
      token,
      expiresAt: now + 50 * 60_000,
    };
    return token;
  }
}

/**
 * Create an Apple Push Notification Service (APNS) provider.
 *
 * Uses the APNS HTTP/2 API with JWT bearer auth (token-based auth, not
 * certificates). Supports both alert and silent (background) push messages.
 * Routes to the sandbox or production APNS endpoint based on the subscription
 * record's `environment` field, falling back to `defaultEnvironment`.
 *
 * @param config - APNS provider configuration.
 * @param config.auth - A pre-constructed `ApnsTokenAuth` instance that manages
 *   JWT generation and caching for the APNS API.
 * @param config.defaultBundleId - Fallback bundle ID when the subscription
 *   record doesn't specify one.
 * @param config.defaultEnvironment - Fallback APNS environment (`'sandbox'` or
 *   `'production'`). Defaults to `'production'`.
 * @returns A `PushProvider` for the `ios` platform.
 *
 * @example
 * ```ts
 * import { ApnsTokenAuth, createApnsProvider } from './providers/apns';
 * const auth = new ApnsTokenAuth({
 *   kind: 'p8-token',
 *   keyPem: process.env.APNS_KEY_PEM!,
 *   keyId: process.env.APNS_KEY_ID!,
 *   teamId: process.env.APNS_TEAM_ID!,
 * });
 * const provider = createApnsProvider({
 *   auth,
 *   defaultBundleId: 'com.example.app',
 *   defaultEnvironment: 'production',
 * });
 * ```
 */
export function createApnsProvider(config: {
  auth: ApnsTokenAuth;
  defaultBundleId?: string;
  defaultEnvironment?: 'sandbox' | 'production';
}): PushProvider {
  return {
    platform: 'ios',
    async send(subscription, message, context) {
      if (subscription.platformData.platform !== 'ios') {
        return { ok: false, reason: 'transient', error: 'subscription platform mismatch' };
      }
      const idempotencyKey = context?.idempotencyKey;
      const apnsId = idempotencyKey ? deriveUuidV4FromKey(idempotencyKey) : undefined;

      const platformData: {
        deviceToken: string;
        bundleId?: string;
        environment?: 'sandbox' | 'production';
      } = subscription.platformData;
      const environment = platformData.environment ?? config.defaultEnvironment ?? 'production';
      // Use `||` (not `??`) so an empty-string platformData.bundleId falls back to defaultBundleId.
      const bundleId = platformData.bundleId || config.defaultBundleId;
      if (!bundleId) {
        return { ok: false, reason: 'transient', error: 'missing APNS bundle id' };
      }

      const origin =
        environment === 'sandbox'
          ? 'https://api.sandbox.push.apple.com'
          : 'https://api.push.apple.com';

      const payload = message.silent
        ? { aps: { 'content-available': 1 }, data: message.data ?? {} }
        : {
            aps: {
              alert: {
                title: message.title,
                body: message.body,
              },
              sound: 'default',
            },
            data: message.data ?? {},
          };

      try {
        const headers: Record<string, string> = {
          authorization: `bearer ${config.auth.getToken()}`,
          'apns-topic': bundleId,
          'apns-push-type': message.silent ? 'background' : 'alert',
          'apns-priority': message.silent ? '5' : '10',
          'content-type': 'application/json',
        };
        if (apnsId) headers['apns-id'] = apnsId;
        const response = await fetch(`${origin}/3/device/${platformData.deviceToken}`, {
          method: 'POST',
          headers,
          body: JSON.stringify(payload),
        });

        if (response.ok) {
          return {
            ok: true,
            providerMessageId: response.headers.get('apns-id') ?? apnsId ?? undefined,
            providerIdempotencyKey: idempotencyKey,
          };
        }

        if (response.status === 410 || response.status === 400 || response.status === 404) {
          return { ok: false, reason: 'invalidToken', error: await response.text() };
        }
        if (response.status === 413) {
          return { ok: false, reason: 'payloadTooLarge', error: await response.text() };
        }
        if (response.status === 429) {
          return {
            ok: false,
            reason: 'rateLimited',
            error: await response.text(),
            retryAfterMs: parseRetryAfterMs(response.headers.get('retry-after')),
          };
        }
        return {
          ok: false,
          reason: 'transient',
          error: await response.text(),
          retryAfterMs: parseRetryAfterMs(response.headers.get('retry-after')),
        };
      } catch (error) {
        return {
          ok: false,
          reason: 'transient',
          error: error instanceof Error ? error.message : 'apns request failed',
        };
      }
    },
  };
}
