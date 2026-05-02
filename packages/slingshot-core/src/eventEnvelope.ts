import { deepFreeze } from './deepFreeze';
import type { SlingshotEventMap } from './eventMap';
import type { CreateEventEnvelopeParams, EventEnvelope, EventKey } from './eventTypes';

export type { CreateEventEnvelopeParams, EventEnvelope, EventEnvelopeMeta } from './eventTypes';

/**
 * Create a deep-frozen {@link EventEnvelope} from the given parameters.
 *
 * Generates a unique `eventId` (UUID v4) and an ISO-8601 `occurredAt` timestamp.
 * The returned envelope and all nested objects are recursively frozen to prevent
 * downstream mutation.
 *
 * @param params - Event key, payload, ownership, exposure, scope, and optional tracing fields.
 * @returns A fully immutable event envelope ready for bus emission.
 */
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

/**
 * Create an envelope for system-internal emissions with no originating request context.
 *
 * Used by the raw bus `emit()` path when events are fired outside a request lifecycle.
 * The envelope has `'internal'` exposure, null scope, `'system'` source, and no
 * `requestId` or `correlationId` (both will be `undefined`).
 *
 * @param key - The event key.
 * @param payload - The typed event payload.
 * @returns A frozen envelope suitable for in-process delivery only.
 */
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
    // Raw bus emit — no originating request context available.
    requestTenantId: null,
  });
}

/**
 * Type guard that checks whether a value is a well-formed {@link EventEnvelope}.
 *
 * Validates the structural shape: string `key`, object `meta` with string `eventId`,
 * `occurredAt`, `ownerPlugin`, and an array `exposure`. When `key` is provided, also
 * asserts that the envelope's key matches.
 *
 * @param value - The value to check.
 * @param key - Optional event key to match against the envelope's `key` field.
 * @returns `true` if `value` is a structurally valid event envelope.
 */
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
