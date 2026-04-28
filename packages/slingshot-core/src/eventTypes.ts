import type { z } from 'zod';
import type { SlingshotEventMap } from './eventMap';

export type EventKey = Extract<keyof SlingshotEventMap, string>;

export type EventExposure =
  | 'internal'
  | 'client-safe'
  | 'tenant-webhook'
  | 'user-webhook'
  | 'app-webhook'
  | 'connector';

export interface EventScope {
  tenantId?: string | null;
  userId?: string | null;
  appId?: string | null;
  actorId?: string | null;
  resourceType?: string;
  resourceId?: string;
}

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

export interface EventSubscriptionPrincipal {
  kind: 'system' | 'tenant' | 'user' | 'app' | 'connector';
  ownerId: string;
  tenantId?: string | null;
}

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
