import type { EventKey, EventScope } from '@lastshotlabs/slingshot-core';

/**
 * Lifecycle status of a webhook delivery.
 */
export type DeliveryStatus = 'pending' | 'delivered' | 'failed' | 'dead';

/** Discriminator indicating who owns a webhook endpoint or subscription. */
export type WebhookOwnerType = 'tenant' | 'user' | 'app' | 'system';

/** Visibility scope that determines which callers may manage a subscription. */
export type WebhookSubscriptionExposure = 'tenant-webhook' | 'user-webhook' | 'app-webhook';

/** A single event subscription attached to a webhook endpoint. */
export interface WebhookEndpointSubscription {
  event: EventKey;
  exposure: WebhookSubscriptionExposure;
  sourcePattern?: string;
}

/** Input union for subscribing an endpoint to a specific event key or a glob pattern. */
export type WebhookEndpointSubscriptionInput = { event: EventKey } | { pattern: string };

/** Identity of the entity that owns or receives a webhook delivery. */
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
 *
 * The `version` field carries the optimistic concurrency token used by the
 * dispatcher to coordinate concurrent updates against the same delivery row
 * (P-WEBHOOKS-6). Adapters bump it on every successful update; callers pass
 * the value they read alongside their write so a stale write becomes a
 * conflict instead of clobbering newer state.
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
  /** Monotonically increasing optimistic-concurrency token. Starts at 1. */
  version: number;
  createdAt: string;
  updatedAt: string;
}

/**
 * Thrown by `WebhookAdapter.updateDelivery` when the caller-supplied
 * `expectedVersion` does not match the current row version. The caller is
 * expected to refetch and reapply the update.
 */
export class WebhookDeliveryVersionConflict extends Error {
  constructor(
    public readonly id: string,
    public readonly expectedVersion: number,
    public readonly actualVersion: number,
  ) {
    super(
      `Webhook delivery '${id}' version conflict: expected=${expectedVersion} actual=${actualVersion}`,
    );
    this.name = 'WebhookDeliveryVersionConflict';
  }
}
