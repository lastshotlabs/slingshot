import type { EventKey, EventScope } from '@lastshotlabs/slingshot-core';

/**
 * Lifecycle status of a webhook delivery.
 */
export type DeliveryStatus = 'pending' | 'delivered' | 'failed' | 'dead';

export type WebhookOwnerType = 'tenant' | 'user' | 'app' | 'system';

export type WebhookSubscriptionExposure = 'tenant-webhook' | 'user-webhook' | 'app-webhook';

export interface WebhookEndpointSubscription {
  event: EventKey;
  exposure: WebhookSubscriptionExposure;
  sourcePattern?: string;
}

export type WebhookEndpointSubscriptionInput = { event: EventKey } | { pattern: string };

export interface WebhookSubscriber {
  ownerType: WebhookOwnerType;
  ownerId: string;
  tenantId?: string | null;
}

/**
 * Persisted outbound webhook endpoint.
 */
export interface WebhookEndpoint {
  id: string;
  ownerType: WebhookOwnerType;
  ownerId: string;
  tenantId?: string | null;
  url: string;
  /** Fully redacted in HTTP responses; the runtime adapter reveals the full value internally. */
  secret: string;
  subscriptions: WebhookEndpointSubscription[];
  enabled: boolean;
  /**
   * Optional per-endpoint HTTP delivery timeout in milliseconds. When unset,
   * the plugin-wide `deliveryTimeoutMs` (or its 30s default) applies. The
   * manifest runtime enforces a positive integer with a 120_000 ms ceiling.
   */
  deliveryTimeoutMs?: number | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * Metadata for a single delivery attempt.
 */
export interface WebhookAttempt {
  attemptedAt: string;
  statusCode?: number;
  durationMs?: number;
  error?: string;
}

/**
 * Persisted outbound delivery record.
 */
export interface WebhookDelivery {
  id: string;
  endpointId: string;
  event: EventKey;
  eventId: string;
  occurredAt: string;
  subscriber: WebhookSubscriber;
  sourceScope: EventScope | null;
  projectedPayload: string;
  status: DeliveryStatus;
  attempts: number;
  nextRetryAt?: string | null;
  lastAttempt?: WebhookAttempt;
  createdAt: string;
  updatedAt: string;
}
