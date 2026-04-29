import type { EventKey, EventScope, PaginatedResult } from '@lastshotlabs/slingshot-core';
import type { DeliveryStatus, WebhookAttempt, WebhookDelivery, WebhookEndpoint } from './models';
import type { WebhookSubscriber } from './models';

/**
 * Runtime persistence contract used by webhook orchestration.
 */
export interface WebhookAdapter {
  getEndpoint(id: string): Promise<WebhookEndpoint | null>;
  listEnabledEndpoints(): Promise<WebhookEndpoint[]>;
  createDelivery(input: {
    endpointId: string;
    event: EventKey;
    eventId: string;
    occurredAt: string;
    subscriber: WebhookSubscriber;
    sourceScope: EventScope | null;
    payload: string;
    maxAttempts: number;
  }): Promise<WebhookDelivery>;
  /**
   * Update a delivery with optimistic concurrency control.
   *
   * When `expectedVersion` is supplied, the adapter compares-and-swaps on
   * the row's current `version`. A mismatch must throw
   * `WebhookDeliveryVersionConflict` so the caller can refetch and retry.
   * When `expectedVersion` is omitted, the update is unconditional —
   * preserved for adapters that do not yet support CAS.
   */
  updateDelivery(
    id: string,
    input: {
      status?: DeliveryStatus;
      attempts?: number;
      nextRetryAt?: string | null;
      lastAttempt?: WebhookAttempt;
      expectedVersion?: number;
    },
  ): Promise<WebhookDelivery>;
  getDelivery(id: string): Promise<WebhookDelivery | null>;
  listDeliveries(opts?: {
    endpointId?: string;
    status?: DeliveryStatus | DeliveryStatus[];
    limit?: number;
    cursor?: string;
  }): Promise<PaginatedResult<WebhookDelivery>>;
}
