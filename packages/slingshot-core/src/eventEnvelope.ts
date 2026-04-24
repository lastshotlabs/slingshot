import { deepFreeze } from './deepFreeze';
import type { SlingshotEventMap } from './eventBus';
import type { EventExposure, EventKey, EventPublishContext, EventScope } from './eventDefinition';

export interface EventEnvelopeMeta {
  eventId: string;
  occurredAt: string;
  ownerPlugin: string;
  exposure: readonly EventExposure[];
  scope: EventScope | null;
  requestId?: string;
  correlationId?: string;
  source?: EventPublishContext['source'];
  /** Request-scoped tenant ID from tenant-resolution middleware. */
  requestTenantId?: string | null;
}

export interface EventEnvelope<K extends EventKey = EventKey> {
  key: K;
  payload: SlingshotEventMap[K];
  meta: EventEnvelopeMeta;
}

export interface CreateEventEnvelopeParams<K extends EventKey> {
  key: K;
  payload: SlingshotEventMap[K];
  ownerPlugin: string;
  exposure: readonly EventExposure[];
  scope: EventScope | null;
  requestId?: string;
  correlationId?: string;
  source?: EventPublishContext['source'];
  requestTenantId?: string | null;
}

export function createEventEnvelope<K extends EventKey>(
  params: CreateEventEnvelopeParams<K>,
): EventEnvelope<K> {
  return deepFreeze({
    key: params.key,
    payload: params.payload,
    meta: {
      eventId: crypto.randomUUID(),
      occurredAt: new Date().toISOString(),
      ownerPlugin: params.ownerPlugin,
      exposure: Object.freeze([...params.exposure]),
      scope: params.scope ? { ...params.scope } : null,
      requestId: params.requestId,
      correlationId: params.correlationId,
      source: params.source,
      requestTenantId: params.requestTenantId,
    },
  });
}

export function createRawEventEnvelope<K extends EventKey>(
  key: K,
  payload: SlingshotEventMap[K],
): EventEnvelope<K> {
  return createEventEnvelope({
    key,
    payload,
    ownerPlugin: 'slingshot-raw-bus',
    exposure: ['internal'],
    scope: null,
    source: 'system',
  });
}

export function isEventEnvelope<K extends EventKey = EventKey>(
  value: unknown,
  key?: K,
): value is EventEnvelope<K> {
  if (typeof value !== 'object' || value === null) {
    return false;
  }

  const candidate = value as {
    key?: unknown;
    payload?: unknown;
    meta?: {
      eventId?: unknown;
      occurredAt?: unknown;
      ownerPlugin?: unknown;
      exposure?: unknown;
      scope?: unknown;
    };
  };

  if (typeof candidate.key !== 'string' || (key !== undefined && candidate.key !== key)) {
    return false;
  }

  if (typeof candidate.meta !== 'object' || candidate.meta === null) {
    return false;
  }

  return (
    typeof candidate.meta.eventId === 'string' &&
    typeof candidate.meta.occurredAt === 'string' &&
    typeof candidate.meta.ownerPlugin === 'string' &&
    Array.isArray(candidate.meta.exposure)
  );
}
