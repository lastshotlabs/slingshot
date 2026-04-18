/**
 * Lifecycle status of a webhook delivery.
 */
export type DeliveryStatus = 'pending' | 'delivered' | 'failed' | 'dead';

/**
 * Persisted outbound webhook endpoint.
 */
export interface WebhookEndpoint {
  id: string;
  tenantId?: string | null;
  url: string;
  /** Masked in HTTP responses; the runtime adapter reveals the full value internally. */
  secret: string;
  events: string[];
  enabled: boolean;
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
  tenantId?: string | null;
  endpointId: string;
  event: string;
  payload: unknown;
  status: DeliveryStatus;
  attempts: number;
  nextRetryAt?: string | null;
  lastAttempt?: WebhookAttempt;
  createdAt: string;
  updatedAt: string;
}
