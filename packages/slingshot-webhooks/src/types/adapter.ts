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
  updateDelivery(
    id: string,
    input: {
      status?: DeliveryStatus;
      attempts?: number;
      nextRetryAt?: string | null;
      lastAttempt?: WebhookAttempt;
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
