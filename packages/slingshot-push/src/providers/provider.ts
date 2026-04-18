import type {
  PushMessage,
  PushPlatform,
  PushSendResult,
  PushSubscriptionRecord,
} from '../types/models';

/** Provider contract implemented by Web Push, APNS, and FCM adapters. */
export interface PushProvider {
  /** Platform served by this provider instance. */
  readonly platform: PushPlatform;
  /** Send one normalized push message to one subscription. */
  send(subscription: PushSubscriptionRecord, message: PushMessage): Promise<PushSendResult>;
}
