import webpush from 'web-push';
import type { PushSendResult } from '../types/models';
import type { PushProvider, PushProviderHealth } from './provider';

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
 * Default consecutive transient/server-side send failures before the provider's
 * circuit breaker opens. Token-specific failures (`invalidToken`,
 * `payloadTooLarge`) do not contribute to the counter.
 */
const DEFAULT_WEB_FAILURE_CIRCUIT = 5;

/**
 * Default cooldown (ms) the breaker stays open before admitting a half-open
 * probe send.
 */
const DEFAULT_WEB_CIRCUIT_COOLDOWN_MS = 30_000;

/**
 * Create a Web Push provider using the VAPID protocol.
 *
 * Uses the `web-push` npm package to sign and deliver push messages to browser
 * subscription endpoints. Only supports alert (non-silent) pushes — silent push
 * is not a Web Push concept and will return a `payloadTooLarge` failure.
 *
 * Send-side resilience: a per-provider-instance counter tracks consecutive
 * provider-wide failures (transient / rateLimited responses, network errors).
 * After `failureCircuitThreshold` consecutive failures (default 5), the breaker
 * opens and further sends short-circuit with a transient failure carrying a
 * `retryAfterMs` hint until the cooldown elapses; one half-open probe is
 * admitted after cooldown. Token-specific failures (`invalidToken`,
 * `payloadTooLarge`) do not increment the counter — they are subscription-level
 * and would not trip a provider-wide breaker. The counter resets on every
 * successful send.
 *
 * @param config - VAPID credentials for signing outgoing push requests.
 * @param config.vapid.publicKey - URL-safe base64-encoded VAPID public key.
 * @param config.vapid.privateKey - URL-safe base64-encoded VAPID private key.
 * @param config.vapid.subject - `mailto:` or `https:` URI identifying the push sender.
 * @param config.failureCircuitThreshold - Consecutive provider-wide failures
 *   before the breaker opens. Defaults to 5.
 * @param config.circuitCooldownMs - Milliseconds the breaker stays open before
 *   admitting a half-open probe. Defaults to 30_000.
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
  failureCircuitThreshold?: number;
  circuitCooldownMs?: number;
}): PushProvider {
  const circuitThreshold = Math.max(
    1,
    config.failureCircuitThreshold ?? DEFAULT_WEB_FAILURE_CIRCUIT,
  );
  const circuitCooldownMs = Math.max(
    0,
    config.circuitCooldownMs ?? DEFAULT_WEB_CIRCUIT_COOLDOWN_MS,
  );
  let consecutiveFailures = 0;
  let lastFailureAt: number | null = null;

  function computeCircuitState(now: number): 'closed' | 'open' | 'half-open' {
    if (consecutiveFailures < circuitThreshold) return 'closed';
    if (lastFailureAt === null) return 'closed';
    if (now - lastFailureAt >= circuitCooldownMs) return 'half-open';
    return 'open';
  }

  function recordFailure(): void {
    consecutiveFailures += 1;
    lastFailureAt = Date.now();
  }

  function recordSuccess(): void {
    consecutiveFailures = 0;
    lastFailureAt = null;
  }

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

      // Circuit breaker short-circuit. When fully open (cooldown not elapsed),
      // refuse the send and return a transient failure with the remaining
      // cooldown so the router/caller can back off without burning attempts.
      const now = Date.now();
      const state = computeCircuitState(now);
      if (state === 'open') {
        const remaining =
          lastFailureAt !== null ? Math.max(0, circuitCooldownMs - (now - lastFailureAt)) : 0;
        const result: PushSendResult = {
          ok: false,
          reason: 'transient',
          error: `web push circuit breaker open (consecutiveFailures=${consecutiveFailures})`,
          retryAfterMs: remaining,
          providerIdempotencyKey: idempotencyKey,
        };
        return result;
      }

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
        recordSuccess();
        return { ok: true, providerIdempotencyKey: idempotencyKey };
      } catch (error) {
        const errObj = error as { statusCode?: number; headers?: unknown; body?: unknown };
        const statusCode = errObj.statusCode;
        const retryAfterMs = parseRetryAfterMs(extractRetryAfterHeader(errObj.headers));
        const reason = classify(statusCode);
        // Token-specific and payload-specific failures do not contribute to the
        // provider-wide breaker. All other failures (rateLimited, transient,
        // network errors with no statusCode) increment the counter.
        if (reason !== 'invalidToken' && reason !== 'payloadTooLarge') {
          recordFailure();
        }
        return {
          ok: false,
          reason,
          error: error instanceof Error ? error.message : 'web push send failed',
          retryAfterMs,
          providerIdempotencyKey: idempotencyKey,
        };
      }
    },
    getHealth(): PushProviderHealth {
      const circuitState = computeCircuitState(Date.now());
      return {
        consecutiveFailures,
        circuitState,
        circuitThreshold,
        lastFailureAt,
      };
    },
  };
}
