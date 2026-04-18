import { createPrivateKey, createSign } from 'node:crypto';
import type { FirebaseServiceAccount } from '../types/config';
import type { PushProvider } from './provider';

function base64UrlEncode(input: Buffer | string): string {
  const buffer = Buffer.isBuffer(input) ? input : Buffer.from(input);
  return buffer.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

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

class FcmAccessTokenProvider {
  private cached: { token: string; expiresAt: number } | null = null;

  constructor(private readonly serviceAccount: FirebaseServiceAccount) {}

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

    const response = await fetch(
      this.serviceAccount.token_uri ?? 'https://oauth2.googleapis.com/token',
      {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
          assertion,
        }),
      },
    );
    const json: unknown = await response.json();
    if (!isTokenResponse(json)) {
      throw new Error('FCM token endpoint returned an invalid response payload');
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
 * @param config - FCM provider configuration.
 * @param config.serviceAccount - Firebase service-account credentials. Must
 *   include `project_id`, `client_email`, and `private_key`. `token_uri`
 *   defaults to `https://oauth2.googleapis.com/token`.
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
export function createFcmProvider(config: {
  serviceAccount: FirebaseServiceAccount;
}): PushProvider {
  const tokens = new FcmAccessTokenProvider(config.serviceAccount);
  const stringifyPayload = (value: unknown): string => {
    if (value === undefined || typeof value === 'function' || typeof value === 'symbol') {
      return String(value);
    }
    return JSON.stringify(value);
  };

  return {
    platform: 'android',
    async send(subscription, message) {
      if (subscription.platformData.platform !== 'android') {
        return { ok: false, reason: 'transient', error: 'subscription platform mismatch' };
      }

      const accessToken = await tokens.getToken();
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
        const response = await fetch(url, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${accessToken}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify(body),
        });
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
          };
        }

        if (response.status === 404 || response.status === 410) {
          return { ok: false, reason: 'invalidToken', error: stringifyPayload(json) };
        }
        if (response.status === 413) {
          return { ok: false, reason: 'payloadTooLarge', error: stringifyPayload(json) };
        }
        if (response.status === 429) {
          return { ok: false, reason: 'rateLimited', error: stringifyPayload(json) };
        }
        return { ok: false, reason: 'transient', error: stringifyPayload(json) };
      } catch (error) {
        return {
          ok: false,
          reason: 'transient',
          error: error instanceof Error ? error.message : 'fcm request failed',
        };
      }
    },
  };
}
