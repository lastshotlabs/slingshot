import { HTTPException } from 'hono/http-exception';
import type {
  EventDefinition,
  EventDefinitionRegistry,
  EventEnvelope,
  EventKey,
  EventScope,
  EventSubscriptionPrincipal,
  PaginatedResult,
} from '@lastshotlabs/slingshot-core';
import { authorizeEventSubscriber } from '@lastshotlabs/slingshot-core';
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
import type { SecretEncryptor } from '../lib/secretCipher';
import { createSecretCipher, wrapSecretEncryptor } from '../lib/secretCipher';
import { validateWebhookUrl } from '../lib/validateWebhookUrl';
import type { WebhookAdapter } from '../types/adapter';
import type {
  WebhookAttempt,
  WebhookDelivery,
  WebhookEndpoint,
  WebhookEndpointSubscription,
  WebhookEndpointSubscriptionInput,
  WebhookOwnerType,
  WebhookSubscriber,
  WebhookSubscriptionExposure,
} from '../types/models';
import type { WebhookJob } from '../types/queue';
import { WebhookSecretDecryptError } from '../types/queue';

type EndpointRecord = {
  id: string;
  ownerType?: WebhookOwnerType;
  ownerId?: string;
  tenantId?: string | null;
  url: string;
  secret: string;
  subscriptions?: WebhookEndpointSubscription[];
  events?: string[];
  enabled: boolean;
  deliveryTimeoutMs?: number | null;
  createdAt: string;
  updatedAt: string;
};

/**
 * Upper bound (in ms) on the per-endpoint HTTP delivery timeout. Mirrored in
 * `webhookPluginConfigSchema.deliveryTimeoutMs` so the global default and the
 * per-endpoint override share the same ceiling. Two minutes is comfortably
 * above the slowest reasonable third-party API while keeping a single stuck
 * delivery from monopolising a queue worker.
 */
const MAX_DELIVERY_TIMEOUT_MS = 120_000;

type DeliveryTransitionStatus = WebhookDelivery['status'];

type DeliveryRecord = {
  id: string;
  tenantId?: string | null;
  endpointId: string;
  event: EventKey;
  eventId: string;
  occurredAt: string;
  subscriber: WebhookSubscriber;
  sourceScope?: EventScope | null;
  projectedPayload: string;
  status: DeliveryTransitionStatus;
  attempts: number;
  nextRetryAt?: string | null;
  lastAttempt?: WebhookAttempt;
  createdAt: string;
  updatedAt: string;
};

/**
 * Minimal logger surface used by the manifest runtime. Apps can inject a
 * structured logger; otherwise the runtime falls back to `console`.
 */
export interface RuntimeLogger {
  error(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
}

const consoleRuntimeLogger: RuntimeLogger = {
  error(message, fields) {
    if (fields) {
      console.error(`[slingshot-webhooks] ${message}`, fields);
    } else {
      console.error(`[slingshot-webhooks] ${message}`);
    }
  },
  warn(message, fields) {
    if (fields) {
      console.warn(`[slingshot-webhooks] ${message}`, fields);
    } else {
      console.warn(`[slingshot-webhooks] ${message}`);
    }
  },
};

type EndpointRuntimeAdapter = BareEntityAdapter & {
  reveal(id: string): Promise<EndpointRecord | null>;
  applyRawUpdate(id: string, input: Record<string, unknown>): Promise<EndpointRecord | null>;
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

export interface GovernedWebhookRuntime {
  initializeGovernance(definitions: EventDefinitionRegistry): Promise<void>;
  listSubscribableDefinitions(subscriber: WebhookSubscriber): readonly EventDefinition[];
}

export type WebhookRuntimeAdapter = WebhookAdapter & GovernedWebhookRuntime;

export interface ResolvedWebhookDelivery {
  endpoint: WebhookEndpoint;
  delivery: WebhookDelivery;
  job: Omit<WebhookJob, 'id' | 'createdAt'>;
}

const WEBHOOK_EXPOSURE_PRIORITY: readonly WebhookSubscriptionExposure[] = [
  'tenant-webhook',
  'user-webhook',
  'app-webhook',
] as const;

function hasMethod(value: BareEntityAdapter, method: string): boolean {
  return typeof value[method] === 'function';
}

function hasMethods(value: unknown, methods: readonly string[]): value is BareEntityAdapter {
  if (typeof value !== 'object' || value === null) return false;
  const adapter = value as BareEntityAdapter;
  return methods.every(method => hasMethod(adapter, method));
}

function maskSecret(secret: string): string {
  void secret;
  return '****';
}

function sanitizeEndpoint(record: EndpointRecord): WebhookEndpoint {
  return {
    id: record.id,
    ownerType: record.ownerType ?? 'tenant',
    ownerId: record.ownerId ?? record.tenantId ?? '',
    tenantId: record.tenantId ?? null,
    url: record.url,
    secret: maskSecret(record.secret),
    subscriptions: normalizeStoredSubscriptions(record.subscriptions),
    enabled: record.enabled,
    deliveryTimeoutMs: record.deliveryTimeoutMs ?? null,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

function sanitizeDelivery(record: DeliveryRecord): WebhookDelivery {
  return {
    id: record.id,
    endpointId: record.endpointId,
    event: record.event,
    eventId: record.eventId,
    occurredAt: record.occurredAt,
    subscriber: {
      ownerType: record.subscriber.ownerType,
      ownerId: record.subscriber.ownerId,
      tenantId: record.subscriber.tenantId ?? null,
    },
    sourceScope: record.sourceScope ?? null,
    projectedPayload: record.projectedPayload,
    status: record.status,
    attempts: record.attempts,
    nextRetryAt: record.nextRetryAt ?? null,
    lastAttempt: record.lastAttempt,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

function isHttpWebhookUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
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
  return hasMethods(value, ['reveal', 'listRaw']);
}

function requireEndpointRuntimeAdapter(value: BareEntityAdapter): EndpointRuntimeAdapter {
  if (!isEndpointRuntimeAdapter(value)) {
    throw new Error('[slingshot-webhooks] endpoint adapter runtime hooks are missing');
  }
  return value;
}

function isDeliveryRuntimeAdapter(value: unknown): value is DeliveryRuntimeAdapter {
  return hasMethods(value, [
    'applyTransition',
    'transition',
    'create',
    'getById',
    'list',
    'update',
  ]);
}

function normalizeStatuses(
  value: WebhookDelivery['status'] | WebhookDelivery['status'][] | undefined,
): DeliveryTransitionStatus[] | null {
  if (!value) return null;
  return Array.isArray(value) ? [...value] : [value];
}

function requireNextCursor(
  scope: string,
  nextCursor: string | undefined,
  seen: Set<string>,
): string {
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

function normalizeStoredSubscriptions(
  value: WebhookEndpointSubscription[] | undefined,
): WebhookEndpointSubscription[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return [...value]
    .filter(
      (item): item is WebhookEndpointSubscription =>
        typeof item?.event === 'string' &&
        typeof item?.exposure === 'string' &&
        WEBHOOK_EXPOSURE_PRIORITY.includes(item.exposure as WebhookSubscriptionExposure),
    )
    .sort((left, right) => left.event.localeCompare(right.event));
}

function assertValidEnabled(value: unknown): void {
  if (value !== undefined && typeof value !== 'boolean') {
    throw new HTTPException(400, { message: 'enabled must be a boolean' });
  }
}

/**
 * Validate a per-endpoint `deliveryTimeoutMs`. Allowed values: positive integer
 * <= {@link MAX_DELIVERY_TIMEOUT_MS}. Explicit null clears the override (so the
 * plugin-wide default applies again). Undefined is a no-op.
 */
function assertValidDeliveryTimeoutMs(value: unknown): void {
  if (value === undefined || value === null) {
    return;
  }
  if (
    typeof value !== 'number' ||
    !Number.isInteger(value) ||
    value <= 0 ||
    value > MAX_DELIVERY_TIMEOUT_MS
  ) {
    throw new HTTPException(400, {
      message: `deliveryTimeoutMs must be a positive integer no greater than ${MAX_DELIVERY_TIMEOUT_MS}`,
    });
  }
}

function assertEndpointUrl(input: Record<string, unknown>, partial: boolean): void {
  const url = input.url;
  if (!partial || url !== undefined) {
    if (typeof url !== 'string' || !isHttpWebhookUrl(url)) {
      throw new HTTPException(400, {
        message: 'Webhook target URL must use http or https',
      });
    }
    try {
      validateWebhookUrl(url);
    } catch (err) {
      throw new HTTPException(400, {
        message: err instanceof Error ? err.message : 'Invalid webhook URL',
      });
    }
  }
}

function assertEndpointSecret(input: Record<string, unknown>, partial: boolean): void {
  const secret = input.secret;
  if (!partial || secret !== undefined) {
    if (typeof secret !== 'string' || secret.length === 0) {
      throw new HTTPException(400, { message: 'secret is required' });
    }
  }
}

function selectExposureForOwner(
  definition: Pick<EventDefinition, 'exposure'>,
  ownerType: WebhookOwnerType,
): WebhookSubscriptionExposure | null {
  switch (ownerType) {
    case 'tenant':
      return definition.exposure.includes('tenant-webhook') ? 'tenant-webhook' : null;
    case 'user':
      return definition.exposure.includes('user-webhook') ? 'user-webhook' : null;
    case 'app':
      return definition.exposure.includes('app-webhook') ? 'app-webhook' : null;
    case 'system':
      return (
        WEBHOOK_EXPOSURE_PRIORITY.find(exposure => definition.exposure.includes(exposure)) ?? null
      );
    default:
      return null;
  }
}

function listDefinitionsForOwner(
  definitions: EventDefinitionRegistry,
  ownerType: WebhookOwnerType,
): readonly EventDefinition[] {
  return definitions
    .list()
    .filter(definition => selectExposureForOwner(definition, ownerType) !== null);
}

function parseSubscriptionInput(value: unknown): WebhookEndpointSubscriptionInput {
  if (typeof value !== 'object' || value === null) {
    throw new HTTPException(400, { message: 'subscriptions entries must be objects' });
  }

  const candidate = value as Record<string, unknown>;
  const event = candidate.event;
  const pattern = candidate.pattern;
  if (typeof event === 'string' && pattern === undefined) {
    return { event: event as EventKey };
  }
  if (typeof pattern === 'string' && event === undefined) {
    return { pattern };
  }
  throw new HTTPException(400, {
    message: 'subscriptions entries must provide exactly one of "event" or "pattern"',
  });
}

function normalizeSubscriptionRequests(
  value: unknown,
  partial: boolean,
): WebhookEndpointSubscriptionInput[] | undefined {
  if (value === undefined && partial) {
    return undefined;
  }
  if (!Array.isArray(value) || value.length === 0) {
    throw new HTTPException(400, { message: 'subscriptions must not be empty' });
  }
  return value.map(parseSubscriptionInput);
}

function dedupeAndSortSubscriptions(
  subscriptions: Iterable<WebhookEndpointSubscription>,
): WebhookEndpointSubscription[] {
  const deduped = new Map<EventKey, WebhookEndpointSubscription>();
  for (const subscription of subscriptions) {
    const existing = deduped.get(subscription.event);
    if (!existing) {
      deduped.set(subscription.event, subscription);
      continue;
    }
    if (!existing.sourcePattern && subscription.sourcePattern) {
      deduped.set(subscription.event, subscription);
    }
  }
  return [...deduped.values()].sort((left, right) => left.event.localeCompare(right.event));
}

export function normalizeWebhookSubscriptions(
  definitions: EventDefinitionRegistry,
  ownerType: WebhookOwnerType,
  requested: readonly WebhookEndpointSubscriptionInput[],
): WebhookEndpointSubscription[] {
  const visibleDefinitions = listDefinitionsForOwner(definitions, ownerType);
  const visibleByKey = new Map(visibleDefinitions.map(definition => [definition.key, definition]));
  const normalized: WebhookEndpointSubscription[] = [];

  for (const request of requested) {
    if ('event' in request) {
      const definition = visibleByKey.get(request.event);
      const exposure =
        definition === undefined ? null : selectExposureForOwner(definition, ownerType);
      if (!definition || !exposure) {
        throw new HTTPException(400, {
          message: `subscription event "${request.event}" is not approved for this webhook owner`,
        });
      }
      normalized.push({ event: definition.key, exposure });
      continue;
    }

    const matches = visibleDefinitions.filter(definition =>
      matchGlob(request.pattern, definition.key),
    );
    if (matches.length === 0) {
      throw new HTTPException(400, {
        message: `subscription pattern "${request.pattern}" did not match any approved events`,
      });
    }
    for (const definition of matches) {
      const exposure = selectExposureForOwner(definition, ownerType);
      if (!exposure) continue;
      normalized.push({
        event: definition.key,
        exposure,
        sourcePattern: request.pattern,
      });
    }
  }

  const deduped = dedupeAndSortSubscriptions(normalized);
  if (deduped.length === 0) {
    throw new HTTPException(400, {
      message: 'subscriptions did not resolve to any approved event keys',
    });
  }
  return deduped;
}

function inferCreateOwner(input: Record<string, unknown>): WebhookSubscriber {
  const ownerType = input.ownerType;
  const ownerId = input.ownerId;
  const tenantId =
    input.tenantId === undefined || input.tenantId === null ? null : String(input.tenantId);

  const resolvedOwnerType = ownerType === undefined ? (tenantId ? 'tenant' : undefined) : ownerType;
  if (
    resolvedOwnerType !== 'tenant' &&
    resolvedOwnerType !== 'user' &&
    resolvedOwnerType !== 'app'
  ) {
    throw new HTTPException(400, {
      message: 'ownerType must be one of tenant, user, or app for management writes',
    });
  }

  const resolvedOwnerId =
    typeof ownerId === 'string' && ownerId.length > 0
      ? ownerId
      : resolvedOwnerType === 'tenant'
        ? tenantId
        : undefined;
  if (!resolvedOwnerId) {
    throw new HTTPException(400, {
      message: 'ownerId is required unless a tenant-owned endpoint can infer it from tenantId',
    });
  }

  return {
    ownerType: resolvedOwnerType,
    ownerId: resolvedOwnerId,
    tenantId,
  };
}

function assertNoOwnershipUpdate(input: Record<string, unknown>): void {
  for (const field of ['ownerType', 'ownerId', 'tenantId']) {
    if (Object.prototype.hasOwnProperty.call(input, field)) {
      throw new HTTPException(400, {
        message: `Webhook endpoint ownership is immutable; remove "${field}" from the update body`,
      });
    }
  }
}

function normalizeEndpointCreateInput(
  input: Record<string, unknown>,
  definitions: EventDefinitionRegistry,
): Record<string, unknown> {
  if (Object.prototype.hasOwnProperty.call(input, 'events')) {
    throw new HTTPException(400, {
      message: 'legacy "events" input is no longer supported; use "subscriptions"',
    });
  }

  assertEndpointUrl(input, false);
  assertEndpointSecret(input, false);
  assertValidEnabled(input.enabled);
  assertValidDeliveryTimeoutMs(input.deliveryTimeoutMs);
  const owner = inferCreateOwner(input);
  const requestedSubscriptions = normalizeSubscriptionRequests(input.subscriptions, false);
  if (!requestedSubscriptions) {
    throw new HTTPException(400, { message: 'subscriptions must not be empty' });
  }
  const subscriptions = normalizeWebhookSubscriptions(
    definitions,
    owner.ownerType,
    requestedSubscriptions,
  );

  const normalized: Record<string, unknown> = {
    url: input.url,
    secret: input.secret,
    enabled: input.enabled ?? true,
    ownerType: owner.ownerType,
    ownerId: owner.ownerId,
    tenantId: owner.tenantId,
    subscriptions,
    events: [],
  };
  if (input.deliveryTimeoutMs !== undefined) {
    normalized.deliveryTimeoutMs = input.deliveryTimeoutMs;
  }
  return normalized;
}

function normalizeEndpointUpdateInput(
  existing: EndpointRecord,
  input: Record<string, unknown>,
  definitions: EventDefinitionRegistry,
): Record<string, unknown> {
  if (Object.prototype.hasOwnProperty.call(input, 'events')) {
    throw new HTTPException(400, {
      message: 'legacy "events" input is no longer supported; use "subscriptions"',
    });
  }

  assertNoOwnershipUpdate(input);
  assertEndpointUrl(input, true);
  if (Object.prototype.hasOwnProperty.call(input, 'secret')) {
    assertEndpointSecret(input, true);
  }
  assertValidEnabled(input.enabled);
  if (Object.prototype.hasOwnProperty.call(input, 'deliveryTimeoutMs')) {
    assertValidDeliveryTimeoutMs(input.deliveryTimeoutMs);
  }

  const normalized: Record<string, unknown> = {
    events: [],
  };
  if (input.url !== undefined) normalized.url = input.url;
  if (input.secret !== undefined) normalized.secret = input.secret;
  if (input.enabled !== undefined) normalized.enabled = input.enabled;
  if (Object.prototype.hasOwnProperty.call(input, 'deliveryTimeoutMs')) {
    normalized.deliveryTimeoutMs = input.deliveryTimeoutMs ?? null;
  }
  const ownerType = existing.ownerType ?? (existing.tenantId ? 'tenant' : undefined);
  if (!ownerType) {
    throw new HTTPException(400, {
      message: 'Cannot update webhook endpoint with unresolved owner identity',
    });
  }
  const subscriptions = normalizeSubscriptionRequests(input.subscriptions, true);
  if (subscriptions) {
    normalized.subscriptions = normalizeWebhookSubscriptions(definitions, ownerType, subscriptions);
  }
  return normalized;
}

function endpointToSubscriber(
  endpoint: Pick<WebhookEndpoint, 'ownerType' | 'ownerId' | 'tenantId'>,
): WebhookSubscriber {
  return {
    ownerType: endpoint.ownerType,
    ownerId: endpoint.ownerId,
    tenantId: endpoint.tenantId ?? null,
  };
}

function toPrincipal(subscriber: WebhookSubscriber): EventSubscriptionPrincipal {
  return {
    kind:
      subscriber.ownerType === 'tenant'
        ? 'tenant'
        : subscriber.ownerType === 'user'
          ? 'user'
          : subscriber.ownerType === 'app'
            ? 'app'
            : 'system',
    ownerId: subscriber.ownerId,
    tenantId: subscriber.tenantId ?? null,
  };
}

/**
 * Webhook subscriber tenant gate.
 *
 * Subscribers scoped to a tenant only receive deliveries whose event scope
 * matches that tenant. This compares against `EventScope.tenantId` — the
 * delivery/projection scope produced by the event's `resolveScope`, which is
 * intentionally distinct from `EventEnvelopeMeta.requestTenantId` (the
 * request-tenant captured at publish time). Subscriber filtering is an
 * authorization concern (which tenants may receive this event), not a
 * provenance concern (which tenant the originating request belonged to).
 */
function tenantCompatible(subscriber: WebhookSubscriber, scope: EventScope | null): boolean {
  if (subscriber.tenantId === undefined || subscriber.tenantId === null) {
    return true;
  }
  return scope?.tenantId === subscriber.tenantId;
}

function serializeProjectedPayload(payload: unknown): string {
  return JSON.stringify(payload === undefined ? null : payload);
}

function supportsWebhookDelivery(definition: EventDefinition): boolean {
  return WEBHOOK_EXPOSURE_PRIORITY.some(exposure => definition.exposure.includes(exposure));
}

function normalizeLegacySubscriptionInput(
  record: EndpointRecord,
): WebhookEndpointSubscriptionInput[] {
  const subscriptions = normalizeStoredSubscriptions(record.subscriptions);
  if (subscriptions.length > 0) {
    return subscriptions.map(subscription => ({ event: subscription.event }));
  }

  return (record.events ?? []).map(value =>
    value.includes('*') ? { pattern: value } : { event: value as EventKey },
  );
}

async function migrateLegacyEndpointRows(
  endpoints: EndpointRuntimeAdapter,
  definitions: EventDefinitionRegistry,
  logger: RuntimeLogger,
): Promise<void> {
  const seenCursors = new Set<string>();
  let cursor: string | undefined;

  while (true) {
    const page = await endpoints.listRaw({ limit: 500, cursor });
    for (const record of page.items) {
      const patch: Record<string, unknown> = {};
      const ownerType = record.ownerType ?? (record.tenantId ? 'tenant' : undefined);
      const ownerId =
        record.ownerId ?? (ownerType === 'tenant' ? (record.tenantId ?? undefined) : undefined);

      if (!ownerType || !ownerId) {
        await endpoints.applyRawUpdate(record.id, {
          enabled: false,
          subscriptions: [],
          events: [],
        });
        logger.error(
          'disabled webhook endpoint during startup migration because ownership could not be resolved',
          { endpointId: record.id, tenantId: record.tenantId ?? null },
        );
        continue;
      }

      patch.ownerType = ownerType;
      patch.ownerId = ownerId;
      patch.tenantId = record.tenantId ?? null;

      try {
        const normalized = normalizeWebhookSubscriptions(
          definitions,
          ownerType,
          normalizeLegacySubscriptionInput(record),
        );
        patch.subscriptions = normalized;
        patch.events = [];
      } catch (error) {
        patch.enabled = false;
        patch.subscriptions = [];
        patch.events = [];
        logger.error(
          'disabled webhook endpoint during startup migration because subscriptions could not be normalized',
          {
            endpointId: record.id,
            tenantId: record.tenantId ?? null,
            ownerType,
            ownerId,
            err: error instanceof Error ? error.message : String(error),
          },
        );
      }

      await endpoints.applyRawUpdate(record.id, patch);
    }

    if (!(page.hasMore ?? false)) {
      return;
    }

    cursor = requireNextCursor(
      'webhook endpoint migration pagination',
      page.nextCursor,
      seenCursors,
    );
  }
}

type AsyncCipher = {
  encrypt(plaintext: string): Promise<string>;
  decrypt(stored: string): Promise<string>;
};

function buildRuntimeAdapter(
  endpoints: EndpointRuntimeAdapter,
  deliveries: DeliveryRuntimeAdapter,
  cipher: AsyncCipher,
  logger: RuntimeLogger,
): WebhookRuntimeAdapter {
  let definitionsRef: EventDefinitionRegistry | undefined;

  /**
   * Decrypt a stored webhook endpoint secret. Fails closed: if the cipher
   * cannot recover the plaintext we throw {@link WebhookSecretDecryptError}
   * rather than silently returning the ciphertext (which would either sign
   * deliveries with garbage or leak the encrypted blob to receivers).
   *
   * The error message intentionally never contains the cipher value. The error
   * is logged with structured fields (endpoint id + a short error class name)
   * so operators can identify the broken row without learning anything about
   * the secret material.
   */
  async function decryptSecret(stored: string, endpointId: string): Promise<string> {
    try {
      return await cipher.decrypt(stored);
    } catch (err) {
      logger.error('failed to decrypt webhook secret; skipping endpoint', {
        endpointId,
        // Avoid err.message — cipher implementations sometimes embed the
        // ciphertext into their error messages and we do not want to leak it.
        errName: err instanceof Error ? err.name : 'unknown',
      });
      throw new WebhookSecretDecryptError(endpointId, err);
    }
  }

  return {
    async initializeGovernance(definitions) {
      definitionsRef = definitions;
      await migrateLegacyEndpointRows(endpoints, definitions, logger);
    },

    listSubscribableDefinitions(subscriber) {
      if (!definitionsRef) {
        return Object.freeze([]) as readonly EventDefinition[];
      }
      return listDefinitionsForOwner(definitionsRef, subscriber.ownerType);
    },

    async getEndpoint(id) {
      const record = await endpoints.reveal(id);
      if (!record) return null;
      return {
        id: record.id,
        ownerType: record.ownerType ?? 'tenant',
        ownerId: record.ownerId ?? record.tenantId ?? '',
        tenantId: record.tenantId ?? null,
        url: record.url,
        secret: await decryptSecret(record.secret, record.id),
        subscriptions: normalizeStoredSubscriptions(record.subscriptions),
        enabled: record.enabled,
        deliveryTimeoutMs: record.deliveryTimeoutMs ?? null,
        createdAt: record.createdAt,
        updatedAt: record.updatedAt,
      };
    },

    async listEnabledEndpoints() {
      const items: WebhookEndpoint[] = [];
      const seenCursors = new Set<string>();
      let cursor: string | undefined;

      while (true) {
        const page = await endpoints.listRaw({ filter: { enabled: true }, limit: 500, cursor });
        // Decrypt per-record rather than via Promise.all so a single broken
        // row does not abort the entire batch. Endpoints whose secret cannot
        // be decrypted are skipped and the failure is already logged inside
        // decryptSecret(); the dispatcher can still deliver to the rest.
        const settled = await Promise.allSettled(
          page.items
            .filter(record => record.enabled)
            .map(async record => ({
              id: record.id,
              ownerType: record.ownerType ?? 'tenant',
              ownerId: record.ownerId ?? record.tenantId ?? '',
              tenantId: record.tenantId ?? null,
              url: record.url,
              secret: await decryptSecret(record.secret, record.id),
              subscriptions: normalizeStoredSubscriptions(record.subscriptions),
              enabled: record.enabled,
              deliveryTimeoutMs: record.deliveryTimeoutMs ?? null,
              createdAt: record.createdAt,
              updatedAt: record.updatedAt,
            })),
        );
        for (const result of settled) {
          if (result.status === 'fulfilled') {
            items.push(result.value);
            continue;
          }
          if (result.reason instanceof WebhookSecretDecryptError) {
            // Already logged in decryptSecret; skip this endpoint.
            continue;
          }
          throw result.reason;
        }

        if (!(page.hasMore ?? false)) {
          return items;
        }

        cursor = requireNextCursor(
          'webhook endpoint discovery pagination',
          page.nextCursor,
          seenCursors,
        );
      }
    },

    async createDelivery(input) {
      const created = (await deliveries.create({
        endpointId: input.endpointId,
        tenantId: input.subscriber.tenantId ?? null,
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

export async function resolveWebhookDeliveries(
  adapter: WebhookAdapter,
  definitions: EventDefinitionRegistry,
  envelope: EventEnvelope,
  maxAttempts: number,
  logger: RuntimeLogger = consoleRuntimeLogger,
): Promise<ResolvedWebhookDelivery[]> {
  const definition = definitions.get(envelope.key);
  if (!definition) {
    logger.error('skipping event because no event definition is registered', {
      event: String(envelope.key),
      eventId: envelope.meta.eventId,
    });
    return [];
  }

  if (!supportsWebhookDelivery(definition)) {
    return [];
  }

  if (envelope.meta.scope === null) {
    logger.error('skipping event because webhook delivery requires a resolved scope', {
      event: String(envelope.key),
      eventId: envelope.meta.eventId,
    });
    return [];
  }

  const endpoints = await adapter.listEnabledEndpoints();
  const results: ResolvedWebhookDelivery[] = [];

  for (const endpoint of endpoints) {
    const subscription = endpoint.subscriptions.find(item => item.event === envelope.key);
    if (!subscription) {
      continue;
    }
    if (!definition.exposure.includes(subscription.exposure)) {
      continue;
    }

    const subscriber = endpointToSubscriber(endpoint);
    if (!tenantCompatible(subscriber, envelope.meta.scope)) {
      continue;
    }
    if (
      subscriber.ownerType !== 'system' &&
      !authorizeEventSubscriber(definition, toPrincipal(subscriber), envelope)
    ) {
      continue;
    }

    let payload: string;
    try {
      const projected =
        definition.projectPayload?.(envelope.payload, toPrincipal(subscriber), envelope) ??
        envelope.payload;
      payload = serializeProjectedPayload(projected);
    } catch (error) {
      logger.error('skipping event for endpoint because payload projection failed', {
        event: String(envelope.key),
        eventId: envelope.meta.eventId,
        endpointId: endpoint.id,
        err: error instanceof Error ? error.message : String(error),
      });
      continue;
    }

    const delivery = await adapter.createDelivery({
      endpointId: endpoint.id,
      event: envelope.key,
      eventId: envelope.meta.eventId,
      occurredAt: envelope.meta.occurredAt,
      subscriber,
      sourceScope: envelope.meta.scope,
      payload,
      maxAttempts,
    });

    results.push({
      endpoint,
      delivery,
      job: {
        deliveryId: delivery.id,
        endpointId: endpoint.id,
        url: endpoint.url,
        secret: endpoint.secret,
        event: envelope.key,
        eventId: envelope.meta.eventId,
        occurredAt: envelope.meta.occurredAt,
        subscriber,
        payload,
        attempts: 0,
        deliveryTimeoutMs: endpoint.deliveryTimeoutMs ?? null,
      },
    });
  }

  return results;
}

/**
 * Options for {@link createWebhooksManifestRuntime}.
 */
export interface CreateWebhooksManifestRuntimeOptions {
  /** Base64 32-byte key for AES-256-GCM secret encryption. Omit for plaintext. */
  secretEncryptionKey?: string | null;
  /**
   * Custom secret encryptor for envelope encryption against KMS, Vault, etc.
   * Takes precedence over {@link secretEncryptionKey} when provided.
   */
  encryptor?: SecretEncryptor | null;
  /** Logger for runtime warnings/errors. Defaults to a `console`-backed logger. */
  logger?: RuntimeLogger;
}

/**
 * Build the manifest runtime for webhook entities.
 *
 * Captures transformed adapters for imperative delivery orchestration while
 * letting the entity framework own CRUD and persistence.
 *
 * @param onAdaptersReady - Callback invoked once endpoint and delivery adapters are bound.
 * @param options - Optional secret-encryption configuration.
 */
export function createWebhooksManifestRuntime(
  onAdaptersReady: (adapter: WebhookRuntimeAdapter) => void,
  options: CreateWebhooksManifestRuntimeOptions = {},
): EntityManifestRuntime {
  const adapterTransforms = createEntityAdapterTransformRegistry();
  const customHandlers = createEntityHandlerRegistry();
  const hooks = createEntityPluginHookRegistry();
  const logger = options.logger ?? consoleRuntimeLogger;
  const cipher: AsyncCipher = options.encryptor
    ? wrapSecretEncryptor(options.encryptor)
    : wrapSecretEncryptor(createSecretCipher(options.secretEncryptionKey ?? null));
  let endpointAdapterRef: EndpointRuntimeAdapter | undefined;
  let deliveryAdapterRef: DeliveryRuntimeAdapter | undefined;
  let definitionsRef: EventDefinitionRegistry | undefined;

  async function encryptSecretField<T extends Record<string, unknown>>(input: T): Promise<T> {
    if (typeof input.secret === 'string' && input.secret.length > 0) {
      return { ...input, secret: await cipher.encrypt(input.secret) };
    }
    return input;
  }

  adapterTransforms.register('webhooks.endpoint.runtime', adapter => {
    const base = adapter;
    return {
      ...adapter,
      create: async (input: unknown) => {
        if (!definitionsRef) {
          throw new Error(
            '[slingshot-webhooks] event definitions are not ready for endpoint writes',
          );
        }
        const normalized = normalizeEndpointCreateInput(
          input as Record<string, unknown>,
          definitionsRef,
        );
        const created = (await base.create(await encryptSecretField(normalized))) as EndpointRecord;
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
        if (!definitionsRef) {
          throw new Error(
            '[slingshot-webhooks] event definitions are not ready for endpoint writes',
          );
        }
        const existing = (await base.getById(id)) as EndpointRecord | null;
        if (!existing) {
          return null;
        }
        const normalizedUpdate = normalizeEndpointUpdateInput(
          existing,
          input as Record<string, unknown>,
          definitionsRef,
        );
        const updated = (await base.update(
          id,
          await encryptSecretField(normalizedUpdate),
          filter,
        )) as EndpointRecord | null;
        return updated ? sanitizeEndpoint(updated) : null;
      },
      reveal: async (id: string) => {
        return (await base.getById(id)) as EndpointRecord | null;
      },
      applyRawUpdate: async (id: string, input: Record<string, unknown>) => {
        // Migration writes go through here. Encrypt secret if present so
        // legacy plaintext rows get rewrapped on first migration touch.
        return (await base.update(id, await encryptSecretField(input))) as EndpointRecord | null;
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
    const runtime = buildRuntimeAdapter(endpointAdapterRef, deliveryAdapterRef, cipher, logger);
    const runtimeWithDefinitions: WebhookRuntimeAdapter = {
      ...runtime,
      async initializeGovernance(definitions) {
        definitionsRef = definitions;
        await runtime.initializeGovernance(definitions);
      },
    };
    onAdaptersReady(runtimeWithDefinitions);
  });

  return {
    adapterTransforms,
    customHandlers,
    hooks,
  };
}
