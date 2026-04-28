import type {
  PushMessage,
  PushPlatform,
  PushProviderSendContext,
  PushSendResult,
  PushSubscriptionRecord,
} from '../types/models';

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
}
