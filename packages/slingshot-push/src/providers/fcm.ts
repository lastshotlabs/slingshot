import { createPrivateKey, createSign } from 'node:crypto';
import { TimeoutError, createConsoleLogger, withTimeout } from '@lastshotlabs/slingshot-core';
import type { FirebaseServiceAccount } from '../types/config';
import type { PushSendResult } from '../types/models';
import type { PushProvider } from './provider';

const logger = createConsoleLogger({ base: { component: 'slingshot-push' } });

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
 * Default consecutive token-fetch failures before classifying further attempts
 * as `permanent`. Prevents infinite retry loops when service-account credentials
 * are invalid or the FCM project is misconfigured.
 */
const DEFAULT_FCM_TOKEN_FAILURE_CIRCUIT = 5;

function isTokenResponse(value: unknown): value is { access_token: string; expires_in: number } {
  return (
    typeof value === 'object' &&
    value !== null &&
    'access_token' in value &&
    'expires_in' in value &&
    typeof value.access_token === 'string' &&
    typeof value.expires_in === 'number'
  );
}

/**
 * Error thrown by `FcmAccessTokenProvider.getToken()` when the OAuth token
 * exchange returns an HTTP error. `statusCode` is set when the failure was an
 * HTTP response (vs. a network/parse error) so callers can distinguish
 * permanent auth failures (401/403) from transient ones (5xx, network).
 */
export class FcmTokenError extends Error {
  readonly statusCode?: number;
  constructor(message: string, statusCode?: number) {
    super(message);
    this.name = 'FcmTokenError';
    this.statusCode = statusCode;
  }
}

class FcmAccessTokenProvider {
  private cached: { token: string; expiresAt: number } | null = null;

  constructor(
    private readonly serviceAccount: FirebaseServiceAccount,
    private readonly timeoutMs: number,
  ) {}

  async getToken(): Promise<string> {
    const now = Date.now();
    if (this.cached && this.cached.expiresAt > now + 30_000) {
      return this.cached.token;
    }

    const header = base64UrlEncode(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
    const claims = base64UrlEncode(
      JSON.stringify({
        iss: this.serviceAccount.client_email,
        scope: 'https://www.googleapis.com/auth/firebase.messaging',
        aud: this.serviceAccount.token_uri ?? 'https://oauth2.googleapis.com/token',
        iat: Math.floor(now / 1000),
        exp: Math.floor(now / 1000) + 3600,
      }),
    );
    const signer = createSign('RSA-SHA256');
    signer.update(`${header}.${claims}`);
    signer.end();
    const signature = signer.sign(createPrivateKey(this.serviceAccount.private_key));
    const assertion = `${header}.${claims}.${base64UrlEncode(signature)}`;

    const response = await withTimeout(
      fetch(
        this.serviceAccount.token_uri ?? 'https://oauth2.googleapis.com/token',
        {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
            assertion,
          }),
        },
      ),
      this.timeoutMs,
      'fcm.token-fetch',
    );
    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new FcmTokenError(
        `FCM token endpoint responded with status ${response.status}: ${body}`,
        response.status,
      );
    }
    const json: unknown = await response.json();
    if (!isTokenResponse(json)) {
      throw new FcmTokenError('FCM token endpoint returned an invalid response payload');
    }
    this.cached = {
      token: json.access_token,
      expiresAt: now + json.expires_in * 1000,
    };
    return json.access_token;
  }
}

/**
 * Create a Firebase Cloud Messaging (FCM) provider using the HTTP v1 API.
 *
 * Authenticates via a service-account RS256 JWT and exchanges it for a
 * short-lived Google OAuth2 access token. The token is cached and auto-renewed.
 * Supports both alert and data-only (silent) push messages.
 *
 * Token-fetch resilience: a per-provider-instance counter tracks consecutive
 * OAuth token failures. After `tokenFailureCircuitThreshold` consecutive
 * failures (default 5) further failures classify as `permanent` so the router
 * stops retrying. HTTP 401/403 from the token endpoint classify as `permanent`
 * immediately because they almost always indicate invalid service-account
 * credentials. The counter resets on every successful token fetch.
 *
 * @param config - FCM provider configuration.
 * @param config.serviceAccount - Firebase service-account credentials. Must
 *   include `project_id`, `client_email`, and `private_key`. `token_uri`
 *   defaults to `https://oauth2.googleapis.com/token`.
 * @param config.tokenFailureCircuitThreshold - Consecutive token-fetch
 *   failures before classifying further attempts as `permanent`. Defaults to 5.
 * @returns A `PushProvider` for the `android` platform.
 *
 * @example
 * ```ts
 * import { createFcmProvider } from './providers/fcm';
 * const provider = createFcmProvider({
 *   serviceAccount: {
 *     project_id: 'my-firebase-project',
 *     client_email: 'firebase-adminsdk@my-firebase-project.iam.gserviceaccount.com',
 *     private_key: process.env.FIREBASE_PRIVATE_KEY!,
 *   },
 * });
 * ```
 */
/**
 * Default timeout (ms) for FCM HTTP requests (token fetch and message send).
 * A network hang should not block push delivery indefinitely.
 */
const DEFAULT_FCM_TIMEOUT_MS = 10_000;

export function createFcmProvider(config: {
  serviceAccount: FirebaseServiceAccount;
  tokenFailureCircuitThreshold?: number;
  /** Maximum milliseconds for FCM HTTP requests. Default: 10000. */
  timeoutMs?: number;
}): PushProvider {
  const tokens = new FcmAccessTokenProvider(config.serviceAccount, timeoutMs);
  const circuitThreshold = Math.max(
    1,
    config.tokenFailureCircuitThreshold ?? DEFAULT_FCM_TOKEN_FAILURE_CIRCUIT,
  );
  const timeoutMs = Math.max(1, config.timeoutMs ?? DEFAULT_FCM_TIMEOUT_MS);
  let consecutiveTokenFailures = 0;
  let lastFailureAt: number | null = null;

  const stringifyPayload = (value: unknown): string => {
    if (value === undefined || typeof value === 'function' || typeof value === 'symbol') {
      return String(value);
    }
    return JSON.stringify(value);
  };

  return {
    platform: 'android',
    async send(subscription, message, context) {
      if (subscription.platformData.platform !== 'android') {
        return { ok: false, reason: 'transient', error: 'subscription platform mismatch' };
      }
      const idempotencyKey = context?.idempotencyKey;

      let accessToken: string;
      try {
        accessToken = await tokens.getToken();
        // Successful token fetch — reset the circuit-breaker counter.
        consecutiveTokenFailures = 0;
      } catch (err) {
        consecutiveTokenFailures += 1;
        lastFailureAt = Date.now();
        const errorMessage = err instanceof Error ? err.message : String(err);
        const statusCode = err instanceof FcmTokenError ? err.statusCode : undefined;
        // 401/403 from the OAuth token endpoint indicates invalid credentials.
        // These will not heal on retry, so classify as permanent immediately.
        const authPermanent = statusCode === 401 || statusCode === 403;
        const circuitTripped = consecutiveTokenFailures >= circuitThreshold;
        const isPermanent = authPermanent || circuitTripped;

        logger.error('fcm-oauth-failure', {
          code: 'fcm-oauth-failure',
          project: config.serviceAccount.project_id,
          providerIdempotencyKey: idempotencyKey,
          statusCode,
          consecutiveFailures: consecutiveTokenFailures,
          circuitThreshold,
          classification: isPermanent ? 'permanent' : 'transient',
          error: errorMessage,
        });

        if (isPermanent) {
          const result: PushSendResult = {
            ok: false,
            reason: 'permanent' as const,
            error: `fcm oauth failure (${authPermanent ? `auth-${statusCode}` : `circuit-open-after-${consecutiveTokenFailures}-failures`}): ${errorMessage}`,
            providerIdempotencyKey: idempotencyKey,
          };
          return result;
        }

        const result: PushSendResult = {
          ok: false,
          reason: 'transient',
          error: `fcm oauth failure: ${errorMessage}`,
          retryAfterMs: 30_000,
          providerIdempotencyKey: idempotencyKey,
        };
        return result;
      }
      const url = `https://fcm.googleapis.com/v1/projects/${config.serviceAccount.project_id}/messages:send`;
      const dataPayload = Object.fromEntries(
        Object.entries({
          title: message.title,
          body: message.body,
          url: message.url,
          ...message.data,
        })
          .filter(([, value]) => value != null)
          .map(([key, value]) => [key, String(value)]),
      );

      const body = message.silent
        ? {
            message: {
              token: subscription.platformData.registrationToken,
              data: dataPayload,
              android: { priority: 'HIGH' },
            },
          }
        : {
            message: {
              token: subscription.platformData.registrationToken,
              notification: {
                title: message.title,
                body: message.body,
              },
              data: dataPayload,
              android: { priority: 'HIGH' },
            },
          };

      try {
        const response = await withTimeout(
          fetch(url, {
            method: 'POST',
            headers: {
              authorization: `Bearer ${accessToken}`,
              'content-type': 'application/json',
            },
            body: JSON.stringify(body),
          }),
          timeoutMs,
          'fcm.message-send',
        );
        const json: unknown = await response.json().catch(() => ({}));
        const providerMessageId =
          typeof json === 'object' &&
          json !== null &&
          'name' in json &&
          typeof json.name === 'string'
            ? json.name
            : undefined;

        if (response.ok) {
          return {
            ok: true,
            providerMessageId,
            providerIdempotencyKey: idempotencyKey,
          };
        }

        const retryAfterMs = parseRetryAfterMs(response.headers.get('retry-after'));

        if (response.status === 404 || response.status === 410) {
          return { ok: false, reason: 'invalidToken', error: stringifyPayload(json) };
        }
        if (response.status === 413) {
          return { ok: false, reason: 'payloadTooLarge', error: stringifyPayload(json) };
        }
        if (response.status === 429) {
          return {
            ok: false,
            reason: 'rateLimited',
            error: stringifyPayload(json),
            retryAfterMs,
          };
        }
        return {
          ok: false,
          reason: 'transient',
          error: stringifyPayload(json),
          retryAfterMs,
        };
      } catch (error) {
        return {
          ok: false,
          reason: 'transient',
          error: error instanceof Error ? error.message : 'fcm request failed',
        };
      }
    },
    getHealth() {
      const open = consecutiveTokenFailures >= circuitThreshold;
      return {
        consecutiveFailures: consecutiveTokenFailures,
        circuitState: open ? ('open' as const) : ('closed' as const),
        circuitThreshold,
        lastFailureAt,
      };
    },
  };
}
