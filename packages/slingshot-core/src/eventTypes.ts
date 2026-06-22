import type { z } from 'zod';
import type { SlingshotEventMap } from './eventMap';

/** Union of all registered event names — the string keys of the {@link SlingshotEventMap}. */
export type EventKey = Extract<keyof SlingshotEventMap, string>;

/** Declares the delivery surfaces an event is allowed to reach, from `internal`-only to client and webhook exposure. */
export type EventExposure =
  | 'internal'
  | 'client-safe'
  | 'tenant-webhook'
  | 'user-webhook'
  | 'app-webhook'
  | 'connector';

/** Ownership and resource context resolved from an event payload, used to authorize external subscribers. */
export interface EventScope {
  tenantId?: string | null;
  userId?: string | null;
  appId?: string | null;
  actorId?: string | null;
  resourceType?: string;
  resourceId?: string;
}

/** Request- or job-scoped context passed at publish time so a definition can resolve scope and stamp envelope metadata. */
export interface EventPublishContext {
  /**
   * Request-scoped tenant ID captured by tenant-resolution middleware
   * (pre-auth). REQUIRED on every publish; set explicitly to `null` for
   * system-source/background emissions that have no originating HTTP request.
   */
  requestTenantId: string | null;
  userId?: string | null;
  appId?: string | null;
  actorId?: string | null;
  requestId?: string;
  correlationId?: string;
  source?: 'http' | 'system' | 'job' | 'connector';
}

/** Identifies the consumer an event would be delivered to when checking subscriber authorization. */
export interface EventSubscriptionPrincipal {
  kind: 'system' | 'tenant' | 'user' | 'app' | 'connector';
  ownerId: string;
  tenantId?: string | null;
}

/** Delivery metadata stamped onto every published event envelope (identity, timing, owner, exposure, scope, and request correlation). */
export interface EventEnvelopeMeta {
  eventId: string;
  occurredAt: string;
  ownerPlugin: string;
  exposure: readonly EventExposure[];
  scope: EventScope | null;
  requestId?: string;
  correlationId?: string;
  source?: EventPublishContext['source'];
  /**
   * Request-scoped tenant ID captured by tenant-resolution middleware (pre-auth).
   * REQUIRED on every envelope; `null` for system/background emissions.
   */
  requestTenantId: string | null;
}

/** A published event: its key, typed payload, and {@link EventEnvelopeMeta} delivery metadata. */
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
  requestTenantId: string | null;
}

/** Declares a publishable event: its owner, exposure surfaces, payload schema, and scope/authorization/projection logic. */
export interface EventDefinition<K extends EventKey = EventKey> {
  key: K;
  ownerPlugin: string;
  exposure: readonly EventExposure[];
  schema?: z.ZodType<SlingshotEventMap[K]>;
  resolveScope(payload: SlingshotEventMap[K], ctx: EventPublishContext): EventScope | null;
  authorizeSubscriber?(principal: EventSubscriptionPrincipal, envelope: EventEnvelope<K>): boolean;
  projectPayload?(
    payload: SlingshotEventMap[K],
    principal: EventSubscriptionPrincipal,
    envelope: EventEnvelope<K>,
  ): unknown;
}

/**
 * Controls how adapters handle schema validation failures.
 */
export type ValidationMode = 'strict' | 'warn' | 'off';
