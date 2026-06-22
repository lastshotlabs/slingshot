import type {
  EventDefinition,
  EventExposure,
  EventKey,
  EventScope,
  EventSubscriptionPrincipal,
} from './eventTypes';

export type {
  EventDefinition,
  EventExposure,
  EventKey,
  EventPublishContext,
  EventScope,
  EventSubscriptionPrincipal,
} from './eventTypes';

const EXTERNAL_EXPOSURES = new Set<EventExposure>([
  'client-safe',
  'tenant-webhook',
  'user-webhook',
  'app-webhook',
  'connector',
]);

type EventSubscriberAuthorizer<K extends EventKey> = NonNullable<
  EventDefinition<K>['authorizeSubscriber']
>;

function hasExternalExposure(exposure: readonly EventExposure[]): boolean {
  return exposure.some(value => EXTERNAL_EXPOSURES.has(value));
}

/**
 * Validate an event definition, throwing if `ownerPlugin` is empty, no exposure
 * is declared, exposures are duplicated, or `internal` is mixed with external exposures.
 */
export function validateEventDefinition<K extends EventKey>(definition: EventDefinition<K>): void {
  if (!definition.ownerPlugin.trim()) {
    throw new Error('[EventDefinitionRegistry] Event definitions require a non-empty ownerPlugin.');
  }

  if (definition.exposure.length === 0) {
    throw new Error(
      `[EventDefinitionRegistry] Event "${definition.key}" must declare at least one exposure.`,
    );
  }

  const seen = new Set<EventExposure>();
  for (const exposure of definition.exposure) {
    if (seen.has(exposure)) {
      throw new Error(
        `[EventDefinitionRegistry] Event "${definition.key}" declares duplicate exposure "${exposure}".`,
      );
    }
    seen.add(exposure);
  }

  if (seen.has('internal') && seen.size > 1) {
    throw new Error(
      `[EventDefinitionRegistry] Event "${definition.key}" cannot mix "internal" with external exposures.`,
    );
  }
}

/**
 * Build a validated, frozen {@link EventDefinition} from a key and its definition body.
 */
export function defineEvent<K extends EventKey>(
  key: K,
  definition: Omit<EventDefinition<K>, 'key'>,
): Readonly<EventDefinition<K>> {
  const normalized: EventDefinition<K> = {
    key,
    ...definition,
    exposure: Object.freeze([...definition.exposure]),
  };
  validateEventDefinition(normalized);
  return Object.freeze(normalized);
}

/**
 * Decide whether a subscription principal is entitled to an event given the
 * envelope's scope and exposures (tenant/user/app webhooks match by owner ID,
 * connectors match by exposure, system principals never match).
 */
export function matchSubscriberToScope(
  principal: EventSubscriptionPrincipal,
  scope: EventScope | null,
  exposure: readonly EventExposure[],
): boolean {
  switch (principal.kind) {
    case 'tenant':
      return (
        exposure.includes('tenant-webhook') &&
        scope !== null &&
        scope.tenantId !== undefined &&
        scope.tenantId !== null &&
        principal.ownerId === scope.tenantId
      );
    case 'user':
      return (
        exposure.includes('user-webhook') &&
        scope !== null &&
        scope.userId !== undefined &&
        scope.userId !== null &&
        principal.ownerId === scope.userId
      );
    case 'app':
      return (
        exposure.includes('app-webhook') &&
        scope !== null &&
        scope.appId !== undefined &&
        scope.appId !== null &&
        principal.ownerId === scope.appId
      );
    case 'connector':
      return exposure.includes('connector');
    case 'system':
      return false;
    default:
      return false;
  }
}

/**
 * Build the default `authorizeSubscriber` predicate for a definition, allowing
 * delivery only when the event has external exposure and the subscriber matches
 * the envelope's scope.
 */
export function createDefaultSubscriberAuthorizer<K extends EventKey>(
  definition: Pick<EventDefinition<K>, 'exposure'>,
): EventSubscriberAuthorizer<K> {
  return (principal, envelope) => {
    if (!hasExternalExposure(definition.exposure)) {
      return false;
    }
    return matchSubscriberToScope(principal, envelope.meta.scope, envelope.meta.exposure);
  };
}

/**
 * Return whether a definition declares any exposure that delivers events outside
 * the framework (client-safe, tenant/user/app webhooks, or connectors).
 */
export function eventHasExternalExposure<K extends EventKey>(
  definition: Pick<EventDefinition<K>, 'exposure'>,
): boolean {
  return hasExternalExposure(definition.exposure);
}
