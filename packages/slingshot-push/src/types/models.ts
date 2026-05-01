/** Supported push delivery platforms. */
export type PushPlatform = 'web' | 'ios' | 'android';

/** Platform-specific credential payload stored on a push subscription. */
export type PlatformData =
  | {
      platform: 'web';
      endpoint: string;
      keys: {
        p256dh: string;
        auth: string;
      };
    }
  | {
      platform: 'ios';
      deviceToken: string;
      bundleId: string;
      environment: 'sandbox' | 'production';
    }
  | {
      platform: 'android';
      registrationToken: string;
      packageName: string;
    };

/** Persisted push-subscription record. */
export interface PushSubscriptionRecord {
  readonly id: string;
  readonly userId: string;
  readonly tenantId: string;
  readonly deviceId: string;
  readonly platform: PushPlatform;
  readonly platformData: PlatformData;
  readonly locale?: string | null;
  readonly appVersion?: string | null;
  readonly createdAt: Date | string;
  readonly lastSeenAt: Date | string;
}

/** Named push topic for multi-device fan-out. */
export interface PushTopicRecord {
  readonly id: string;
  readonly tenantId: string;
  readonly name: string;
  readonly createdAt: Date | string;
}

/** Membership record linking a subscription to a topic. */
export interface PushTopicMembershipRecord {
  readonly id: string;
  readonly topicId: string;
  readonly subscriptionId: string;
  readonly userId: string;
  readonly tenantId: string;
  readonly createdAt: Date | string;
}

/** Delivery-attempt record for one notification sent to one subscription. */
export interface PushDeliveryRecord {
  readonly id: string;
  readonly tenantId: string;
  readonly userId: string;
  readonly subscriptionId: string;
  readonly platform: PushPlatform;
  readonly notificationId?: string | null;
  readonly providerMessageId?: string | null;
  /** Deterministic key sent to the upstream provider for idempotent retries. */
  readonly providerIdempotencyKey?: string | null;
  readonly status: 'pending' | 'sent' | 'delivered' | 'failed';
  readonly failureReason?:
    | 'invalidToken'
    | 'rateLimited'
    | 'payloadTooLarge'
    | 'transient'
    | 'permanent'
    | 'repositoryFailure'
    | null;
  readonly attempts: number;
  readonly sentAt?: Date | string | null;
  readonly deliveredAt?: Date | string | null;
  readonly createdAt: Date | string;
}

/** Normalized push payload delivered across all providers. */
export interface PushMessage {
  readonly title: string;
  readonly body?: string;
  readonly data?: Record<string, unknown>;
  readonly icon?: string;
  readonly badge?: string;
  readonly url?: string;
  readonly silent?: boolean;
  readonly platformOverrides?: Partial<Record<PushPlatform, Record<string, unknown>>>;
}

/** Default values applied by the notifications delivery adapter. */
export interface NotificationDefaults {
  readonly icon?: string;
  readonly badge?: string;
  readonly defaultUrl?: string;
}

/** Normalized provider send result consumed by `createPushRouter()`. */
export interface PushSendResult {
  readonly ok: boolean;
  readonly providerMessageId?: string;
  readonly reason?: 'invalidToken' | 'rateLimited' | 'payloadTooLarge' | 'transient' | 'permanent';
  readonly error?: string;
  readonly retryAfterMs?: number;
  /** Deterministic key the provider was tagged with for de-duping retried sends. */
  readonly providerIdempotencyKey?: string;
}

/** Per-call provider context (e.g. retry idempotency key). */
export interface PushProviderSendContext {
  /** Stable token derived from `(deliveryId, attempt)` to de-duplicate retries. */
  readonly idempotencyKey?: string;
  /**
   * Optional abort signal set by the router when a provider timeout fires.
   * Providers should pass this to their underlying HTTP client so in-flight
   * requests are cancelled rather than leaked when the caller times out.
   */
  readonly signal?: AbortSignal;
}
