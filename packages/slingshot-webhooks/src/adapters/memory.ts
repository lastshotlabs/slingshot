import type { PaginatedResult } from '@lastshotlabs/slingshot-core';
import type { WebhookAdapter } from '../types/adapter';
import type { DeliveryStatus, WebhookDelivery, WebhookEndpoint } from '../types/models';
import { WebhookDeliveryVersionConflict } from '../types/models';

const VALID_TRANSITIONS: Readonly<Record<DeliveryStatus, readonly DeliveryStatus[]>> = {
  pending: ['delivered', 'failed', 'dead'],
  failed: ['pending', 'delivered', 'dead'],
  delivered: [],
  dead: [],
};

/** In-memory {@link WebhookAdapter} with synchronous endpoint management helpers for testing. */
export interface MemoryWebhookAdapter extends WebhookAdapter {
  addEndpoint(endpoint: Omit<WebhookEndpoint, 'createdAt' | 'updatedAt'>): WebhookEndpoint;
  removeEndpoint(id: string): boolean;
  listEndpoints(): WebhookEndpoint[];
}

/** Creates an ephemeral in-memory webhook adapter suitable for tests and local development. */
export function createMemoryWebhookAdapter(): MemoryWebhookAdapter {
  const endpoints = new Map<string, WebhookEndpoint>();
  const deliveries = new Map<string, WebhookDelivery>();

  return {
    addEndpoint(input) {
      const now = new Date().toISOString();
      const endpoint: WebhookEndpoint = { ...input, createdAt: now, updatedAt: now };
      endpoints.set(endpoint.id, endpoint);
      return endpoint;
    },

    removeEndpoint(id) {
      return endpoints.delete(id);
    },

    listEndpoints() {
      return [...endpoints.values()];
    },

    async getEndpoint(id) {
      return endpoints.get(id) ?? null;
    },

    async listEnabledEndpoints() {
      return [...endpoints.values()].filter(ep => ep.enabled);
    },

    async createDelivery(input) {
      const id = crypto.randomUUID();
      const now = new Date().toISOString();
      const delivery: WebhookDelivery = {
        id,
        endpointId: input.endpointId,
        event: input.event,
        eventId: input.eventId,
        occurredAt: input.occurredAt,
        subscriber: {
          ownerType: input.subscriber.ownerType,
          ownerId: input.subscriber.ownerId,
          tenantId: input.subscriber.tenantId ?? null,
        },
        sourceScope: input.sourceScope ?? null,
        projectedPayload: input.payload,
        status: 'pending',
        attempts: 0,
        nextRetryAt: null,
        version: 1,
        createdAt: now,
        updatedAt: now,
      };
      deliveries.set(id, delivery);
      return delivery;
    },

    async updateDelivery(id, input) {
      const existing = deliveries.get(id);
      if (!existing) {
        throw new Error(`Delivery ${id} not found`);
      }
      // P-WEBHOOKS-6: optimistic concurrency control. When the caller
      // supplied an `expectedVersion`, refuse the update on mismatch so a
      // stale write becomes a refetch-and-retry instead of clobbering.
      if (input.expectedVersion !== undefined && input.expectedVersion !== existing.version) {
        throw new WebhookDeliveryVersionConflict(id, input.expectedVersion, existing.version);
      }
      if (input.status && input.status !== existing.status) {
        if (!VALID_TRANSITIONS[existing.status].includes(input.status)) {
          throw new Error(
            `Invalid delivery transition from '${existing.status}' to '${input.status}'`,
          );
        }
      }
      const updated: WebhookDelivery = {
        ...existing,
        ...(input.status !== undefined ? { status: input.status } : {}),
        ...(input.attempts !== undefined ? { attempts: input.attempts } : {}),
        ...(input.nextRetryAt !== undefined ? { nextRetryAt: input.nextRetryAt } : {}),
        ...(input.lastAttempt !== undefined ? { lastAttempt: input.lastAttempt } : {}),
        version: existing.version + 1,
        updatedAt: new Date().toISOString(),
      };
      deliveries.set(id, updated);
      return updated;
    },

    async getDelivery(id) {
      return deliveries.get(id) ?? null;
    },

    async listDeliveries(opts = {}) {
      let items = [...deliveries.values()];
      if (opts.endpointId) {
        items = items.filter(d => d.endpointId === opts.endpointId);
      }
      if (opts.status) {
        const statuses = Array.isArray(opts.status) ? opts.status : [opts.status];
        items = items.filter(d => statuses.includes(d.status));
      }
      const limit = opts.limit ?? 50;
      let startIndex = 0;
      if (opts.cursor) {
        startIndex = parseInt(opts.cursor, 10);
        if (isNaN(startIndex)) startIndex = 0;
      }
      const slice = items.slice(startIndex, startIndex + limit);
      const hasMore = startIndex + limit < items.length;
      return {
        items: slice,
        nextCursor: hasMore ? String(startIndex + limit) : undefined,
        hasMore,
      } satisfies PaginatedResult<WebhookDelivery>;
    },
  };
}
