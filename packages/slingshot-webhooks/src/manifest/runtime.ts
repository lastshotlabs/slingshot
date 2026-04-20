import { HTTPException } from 'hono/http-exception';
import type { PaginatedResult } from '@lastshotlabs/slingshot-core';
import type {
  EntityManifestRuntime,
  EntityPluginAfterAdaptersContext,
} from '@lastshotlabs/slingshot-entity';
import {
  createEntityAdapterTransformRegistry,
  createEntityHandlerRegistry,
  createEntityPluginHookRegistry,
} from '@lastshotlabs/slingshot-entity';
import type { BareEntityAdapter } from '@lastshotlabs/slingshot-entity';
import { matchGlob } from '../lib/globMatch';
import type { WebhookAttempt, WebhookDelivery, WebhookEndpoint } from '../types/models';

type EndpointRecord = {
  id: string;
  tenantId?: string | null;
  url: string;
  secret: string;
  events: string[];
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
};

type DeliveryTransitionStatus = WebhookDelivery['status'];

type DeliveryRecord = {
  id: string;
  tenantId?: string | null;
  endpointId: string;
  event: string;
  payload: unknown;
  status: DeliveryTransitionStatus;
  attempts: number;
  nextRetryAt?: string | null;
  lastAttempt?: WebhookAttempt;
  createdAt: string;
  updatedAt: string;
};

type EndpointRuntimeAdapter = BareEntityAdapter & {
  reveal(id: string): Promise<EndpointRecord | null>;
  findForEvent(input: { event: string }): Promise<EndpointRecord[]>;
  listRaw(opts?: {
    filter?: unknown;
    limit?: number;
    cursor?: string;
  }): Promise<PaginatedResult<EndpointRecord>>;
};

type DeliveryRuntimeAdapter = BareEntityAdapter & {
  transition(input: {
    id: string;
    status: DeliveryTransitionStatus;
    attempts?: number;
    nextRetryAt?: string | null;
    lastAttempt?: WebhookAttempt;
  }): Promise<DeliveryRecord>;
  applyTransition(input: {
    id: string;
    status: DeliveryTransitionStatus;
    attempts?: number;
    nextRetryAt?: string | null;
    lastAttempt?: WebhookAttempt;
  }): Promise<DeliveryRecord>;
};

export type WebhookRuntimeAdapter = {
  getEndpoint(id: string): Promise<WebhookEndpoint | null>;
  findEndpointsForEvent(event: string): Promise<WebhookEndpoint[]>;
  createDelivery(input: {
    endpointId: string;
    event: string;
    payload: string;
    maxAttempts: number;
  }): Promise<WebhookDelivery>;
  updateDelivery(
    id: string,
    input: {
      status?: WebhookDelivery['status'];
      attempts?: number;
      nextRetryAt?: string | null;
      lastAttempt?: WebhookAttempt;
    },
  ): Promise<WebhookDelivery>;
  getDelivery(id: string): Promise<WebhookDelivery | null>;
  listDeliveries(input?: {
    endpointId?: string;
    status?: WebhookDelivery['status'] | WebhookDelivery['status'][];
    limit?: number;
    cursor?: string;
  }): Promise<PaginatedResult<WebhookDelivery>>;
};

function hasMethod(value: BareEntityAdapter, method: string): boolean {
  return typeof value[method] === 'function';
}

function hasMethods(value: unknown, methods: readonly string[]): value is BareEntityAdapter {
  if (typeof value !== 'object' || value === null) return false;
  const adapter = value as BareEntityAdapter;
  return methods.every(method => hasMethod(adapter, method));
}

function maskSecret(secret: string): string {
  return secret.length > 4 ? secret.slice(-4) : '****';
}

function sanitizeEndpoint(record: EndpointRecord): WebhookEndpoint {
  return {
    ...record,
    secret: maskSecret(record.secret),
  };
}

function sanitizeDelivery(record: DeliveryRecord): WebhookDelivery {
  return {
    ...record,
    nextRetryAt: record.nextRetryAt ?? null,
  };
}

function parsePayload(payload: string): unknown {
  try {
    return JSON.parse(payload) as unknown;
  } catch {
    return payload;
  }
}

function isHttpWebhookUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

function assertValidEndpointInput(input: Record<string, unknown>, partial: boolean): void {
  const url = input.url;
  if (!partial || url !== undefined) {
    if (typeof url !== 'string' || !isHttpWebhookUrl(url)) {
      throw new HTTPException(400, {
        message: 'Webhook target URL must use http or https',
      });
    }
  }

  const secret = input.secret;
  if (!partial || secret !== undefined) {
    if (typeof secret !== 'string' || secret.length === 0) {
      throw new HTTPException(400, { message: 'secret is required' });
    }
  }

  const events = input.events;
  if (!partial || events !== undefined) {
    if (
      !Array.isArray(events) ||
      events.length === 0 ||
      events.some(value => typeof value !== 'string')
    ) {
      throw new HTTPException(400, { message: 'events must not be empty' });
    }
  }
}

function normalizeLastAttempt(value: WebhookAttempt | undefined): WebhookAttempt | undefined {
  if (!value) return undefined;
  return {
    attemptedAt: value.attemptedAt,
    statusCode: value.statusCode,
    durationMs: value.durationMs,
    error: value.error,
  };
}

function isEndpointRuntimeAdapter(value: unknown): value is EndpointRuntimeAdapter {
  return hasMethods(value, ['reveal', 'listRaw', 'findForEvent']);
}

function requireEndpointRuntimeAdapter(value: BareEntityAdapter): EndpointRuntimeAdapter {
  if (!isEndpointRuntimeAdapter(value)) {
    throw new Error('[slingshot-webhooks] endpoint adapter runtime hooks are missing');
  }
  return value;
}

function isDeliveryRuntimeAdapter(value: unknown): value is DeliveryRuntimeAdapter {
  return hasMethods(value, ['applyTransition', 'transition', 'create', 'getById', 'list', 'update']);
}

function normalizeStatuses(
  value: WebhookDelivery['status'] | WebhookDelivery['status'][] | undefined,
): DeliveryTransitionStatus[] | null {
  if (!value) return null;
  return Array.isArray(value) ? [...value] : [value];
}

function requireNextCursor(scope: string, nextCursor: string | undefined, seen: Set<string>): string {
  if (!nextCursor) {
    throw new Error(`[slingshot-webhooks] ${scope} returned hasMore without nextCursor`);
  }
  if (seen.has(nextCursor)) {
    throw new Error(`[slingshot-webhooks] ${scope} returned a repeated nextCursor`);
  }
  seen.add(nextCursor);
  return nextCursor;
}

function requireDeliveryRuntimeAdapter(value: BareEntityAdapter): DeliveryRuntimeAdapter {
  if (!isDeliveryRuntimeAdapter(value)) {
    throw new Error('[slingshot-webhooks] delivery adapter runtime hooks are missing');
  }
  return value;
}

function validateTransition(
  current: DeliveryTransitionStatus,
  next: DeliveryTransitionStatus,
): void {
  const allowed: Readonly<Record<DeliveryTransitionStatus, readonly DeliveryTransitionStatus[]>> = {
    pending: ['delivered', 'failed', 'dead'],
    failed: ['pending', 'delivered', 'dead'],
    delivered: [],
    dead: [],
  };
  if (!allowed[current].includes(next)) {
    throw new HTTPException(409, {
      message: `Invalid webhook delivery transition from '${current}' to '${next}'`,
    });
  }
}

function buildRuntimeAdapter(
  endpoints: EndpointRuntimeAdapter,
  deliveries: DeliveryRuntimeAdapter,
): WebhookRuntimeAdapter {
  return {
    async getEndpoint(id) {
      const record = await endpoints.reveal(id);
      return record;
    },
    async findEndpointsForEvent(event) {
      const matches = await endpoints.findForEvent({ event });
      return matches;
    },
    async createDelivery(input) {
      const endpoint = await endpoints.reveal(input.endpointId);
      const created = (await deliveries.create({
        endpointId: input.endpointId,
        tenantId: endpoint?.tenantId ?? null,
        event: input.event,
        payload: parsePayload(input.payload),
      })) as DeliveryRecord;
      return sanitizeDelivery(created);
    },
    async updateDelivery(id, input) {
      if (input.status) {
        const transitioned = await deliveries.transition({
          id,
          status: input.status,
          attempts: input.attempts,
          nextRetryAt: input.nextRetryAt ?? null,
          lastAttempt: normalizeLastAttempt(input.lastAttempt),
        });
        return sanitizeDelivery(transitioned);
      }
      const updated = (await deliveries.update(id, {
        attempts: input.attempts,
        nextRetryAt: input.nextRetryAt ?? null,
        lastAttempt: normalizeLastAttempt(input.lastAttempt),
      })) as DeliveryRecord | null;
      if (!updated) {
        throw new HTTPException(404, { message: 'Delivery not found' });
      }
      return sanitizeDelivery(updated);
    },
    async getDelivery(id) {
      const record = (await deliveries.getById(id)) as DeliveryRecord | null;
      return record ? sanitizeDelivery(record) : null;
    },
    async listDeliveries(input = {}) {
      const filter = {
        ...(input.endpointId ? { endpointId: input.endpointId } : {}),
      };
      const statuses = normalizeStatuses(input.status);
      if (!statuses) {
        const page = await deliveries.list({
          filter,
          limit: input.limit,
          cursor: input.cursor,
        });
        return {
          items: (page.items as DeliveryRecord[]).map(sanitizeDelivery),
          nextCursor: page.nextCursor,
          hasMore: page.hasMore ?? false,
        };
      }

      const items: WebhookDelivery[] = [];
      const seenCursors = new Set<string>();
      let cursor = input.cursor;
      const targetCount = input.limit ?? Number.POSITIVE_INFINITY;

      while (items.length < targetCount) {
        const page = await deliveries.list({
          filter,
          // When filtering client-side against an opaque cursor, fetch at most the
          // remaining requested items so the returned nextCursor never skips unseen rows.
          limit: Number.isFinite(targetCount) ? Math.max(1, targetCount - items.length) : 100,
          cursor,
        });
        items.push(
          ...(page.items as DeliveryRecord[])
            .filter(item => statuses.includes(item.status))
            .map(sanitizeDelivery),
        );

        const hasMore = page.hasMore ?? false;
        if (!hasMore) {
          return {
            items,
            nextCursor: page.nextCursor,
            hasMore: false,
          };
        }

        const nextCursor = requireNextCursor(
          'filtered webhook delivery pagination',
          page.nextCursor,
          seenCursors,
        );
        if (items.length >= targetCount) {
          return {
            items,
            nextCursor,
            hasMore: true,
          };
        }
        cursor = nextCursor;
      }

      return {
        items,
        nextCursor: undefined,
        hasMore: false,
      };
    },
  };
}

/**
 * Build the manifest runtime for webhook entities.
 *
 * Captures transformed adapters for imperative delivery orchestration while
 * letting the entity framework own CRUD and persistence.
 */
export function createWebhooksManifestRuntime(
  onAdaptersReady: (adapter: WebhookRuntimeAdapter) => void,
): EntityManifestRuntime {
  const adapterTransforms = createEntityAdapterTransformRegistry();
  const customHandlers = createEntityHandlerRegistry();
  const hooks = createEntityPluginHookRegistry();
  let endpointAdapterRef: EndpointRuntimeAdapter | undefined;
  let deliveryAdapterRef: DeliveryRuntimeAdapter | undefined;

  adapterTransforms.register('webhooks.endpoint.runtime', adapter => {
    const base = adapter;
    return {
      ...adapter,
      create: async (input: unknown) => {
        assertValidEndpointInput(input as Record<string, unknown>, false);
        const created = (await base.create(input)) as EndpointRecord;
        return sanitizeEndpoint(created);
      },
      getById: async (id: string, filter?: Record<string, unknown>) => {
        const record = (await base.getById(id, filter)) as EndpointRecord | null;
        return record ? sanitizeEndpoint(record) : null;
      },
      list: async (opts?: { filter?: unknown; limit?: number; cursor?: string }) => {
        const page = await base.list(opts ?? {});
        return {
          ...page,
          items: (page.items as EndpointRecord[]).map(sanitizeEndpoint),
        };
      },
      update: async (id: string, input: unknown, filter?: Record<string, unknown>) => {
        assertValidEndpointInput(input as Record<string, unknown>, true);
        const updated = (await base.update(id, input, filter)) as EndpointRecord | null;
        return updated ? sanitizeEndpoint(updated) : null;
      },
      reveal: async (id: string) => {
        return (await base.getById(id)) as EndpointRecord | null;
      },
      listRaw: async (opts?: { filter?: unknown; limit?: number; cursor?: string }) => {
        return (await base.list(opts ?? {})) as PaginatedResult<EndpointRecord>;
      },
    };
  });

  adapterTransforms.register('webhooks.delivery.runtime', adapter => {
    const base = adapter;
    return {
      ...adapter,
      applyTransition: async (input: {
        id: string;
        status: DeliveryTransitionStatus;
        attempts?: number;
        nextRetryAt?: string | null;
        lastAttempt?: WebhookAttempt;
      }) => {
        const current = (await base.getById(input.id)) as DeliveryRecord | null;
        if (!current) {
          throw new HTTPException(404, { message: 'Delivery not found' });
        }
        validateTransition(current.status, input.status);
        return (await base.update(input.id, {
          status: input.status,
          attempts: input.attempts,
          nextRetryAt: input.nextRetryAt ?? null,
          lastAttempt: normalizeLastAttempt(input.lastAttempt),
        })) as DeliveryRecord;
      },
    };
  });

  customHandlers.register('webhooks.endpoint.findForEvent', () => () => async (input: unknown) => {
    const params = (input ?? {}) as Record<string, unknown>;
    const event = typeof params.event === 'string' ? params.event : '';
    if (!event) {
      throw new HTTPException(400, { message: 'event is required' });
    }
    const endpoints = endpointAdapterRef;
    if (!endpoints) {
      throw new Error('[slingshot-webhooks] endpoint adapter not ready');
    }
    const matches: EndpointRecord[] = [];
    const seenCursors = new Set<string>();
    let cursor: string | undefined;

    while (true) {
      const page = await endpoints.listRaw({ filter: { enabled: true }, limit: 500, cursor });
      matches.push(
        ...page.items.filter(
          endpoint => endpoint.enabled && endpoint.events.some(pattern => matchGlob(pattern, event)),
        ),
      );

      if (!(page.hasMore ?? false)) {
        return matches;
      }

      cursor = requireNextCursor('webhook endpoint discovery pagination', page.nextCursor, seenCursors);
    }
  });

  customHandlers.register('webhooks.delivery.transition', () => () => async (input: unknown) => {
    const params = (input ?? {}) as Record<string, unknown>;
    const deliveryAdapter = deliveryAdapterRef;
    if (!deliveryAdapter) {
      throw new Error('[slingshot-webhooks] delivery adapter not ready');
    }
    const id = typeof params.id === 'string' ? params.id : '';
    const status = params.status;
    if (!id || typeof status !== 'string') {
      throw new HTTPException(400, { message: 'id and status are required' });
    }
    return deliveryAdapter.applyTransition({
      id,
      status: status as DeliveryTransitionStatus,
      attempts: typeof params.attempts === 'number' ? params.attempts : undefined,
      nextRetryAt:
        typeof params.nextRetryAt === 'string' || params.nextRetryAt === null
          ? params.nextRetryAt
          : undefined,
      lastAttempt:
        typeof params.lastAttempt === 'object' && params.lastAttempt !== null
          ? (params.lastAttempt as WebhookAttempt)
          : undefined,
    });
  });

  hooks.register('webhooks.captureAdapters', (ctx: EntityPluginAfterAdaptersContext) => {
    endpointAdapterRef = requireEndpointRuntimeAdapter(ctx.adapters.WebhookEndpoint);
    deliveryAdapterRef = requireDeliveryRuntimeAdapter(ctx.adapters.WebhookDelivery);
    onAdaptersReady(buildRuntimeAdapter(endpointAdapterRef, deliveryAdapterRef));
  });

  return {
    adapterTransforms,
    customHandlers,
    hooks,
  };
}
