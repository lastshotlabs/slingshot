import type {
  PushMessage,
  PushPlatform,
  PushProviderSendContext,
  PushSendResult,
  PushSubscriptionRecord,
} from '../types/models';

/**
 * Per-provider observability snapshot exposed via `PushProvider.getHealth()`.
 *
 * Implementations must keep this cheap (no I/O) — it is read from a health
 * endpoint and may be polled.
 */
export interface PushProviderHealth {
  /** Number of consecutive failed sends (or token fetches) since the last success. */
  readonly consecutiveFailures: number;
  /** Circuit breaker state, when the provider implements one. */
  readonly circuitState: 'closed' | 'open' | 'half-open';
  /** Threshold at which the breaker opens (when applicable). */
  readonly circuitThreshold?: number;
  /** Wall-clock timestamp (ms) of the most recent failure, or `null`. */
  readonly lastFailureAt: number | null;
}

/** Provider contract implemented by Web Push, APNS, and FCM adapters. */
export interface PushProvider {
  /** Platform served by this provider instance. */
  readonly platform: PushPlatform;
  /**
   * Send one normalized push message to one subscription.
   *
   * @param context - Optional per-call info (e.g. idempotency key) the router
   *   passes through. Providers should treat the context as advisory; an
   *   unrecognised field must not break the call.
   */
  send(
    subscription: PushSubscriptionRecord,
    message: PushMessage,
    context?: PushProviderSendContext,
  ): Promise<PushSendResult>;
  /**
   * Optional health snapshot. Cheap to call (no I/O). Operators wire this
   * through the plugin's aggregated `getHealth()` for ops dashboards.
   */
  getHealth?(): PushProviderHealth;
}
