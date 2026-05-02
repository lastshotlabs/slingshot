import type { SlingshotEventBus, SlingshotEventMap } from './eventBus';
import type {
  EventDefinition,
  EventKey,
  EventPublishContext,
  EventSubscriptionPrincipal,
} from './eventDefinition';
import { createDefaultSubscriberAuthorizer, eventHasExternalExposure } from './eventDefinition';
import type { EventDefinitionRegistry } from './eventDefinitionRegistry';
import { type EventEnvelope, createEventEnvelope } from './eventEnvelope';

/**
 * High-level event API exposed on the Slingshot context.
 *
 * Wraps an {@link EventDefinitionRegistry} and a {@link SlingshotEventBus} to
 * provide validated, envelope-wrapped event publishing with scope projection.
 */
export interface SlingshotEvents {
  /** The underlying definition registry shared across all plugins. */
  readonly definitions: EventDefinitionRegistry;
  /** Register a new event definition (typically called during plugin setup). */
  register<K extends EventKey>(definition: EventDefinition<K>): void;
  /** Retrieve a registered definition by key, or `undefined` if not registered. */
  get<K extends EventKey>(key: K): EventDefinition<K> | undefined;
  /** Return all registered event definitions. */
  list(): readonly EventDefinition[];
  /**
   * Validate, envelope-wrap, and emit an event through the bus.
   *
   * @throws If the event key is not registered or the payload fails schema validation.
   * @throws If the definition exposes external delivery but `resolveScope` returns `null`.
   */
  publish<K extends EventKey>(
    key: K,
    payload: SlingshotEventMap[K],
    ctx: EventPublishContext,
  ): EventEnvelope<K>;
}

export interface CreateEventPublisherOptions {
  definitions: EventDefinitionRegistry;
  bus: SlingshotEventBus;
}

function validateProjectedScope<K extends EventKey>(
  definition: EventDefinition<K>,
  scope: ReturnType<EventDefinition<K>['resolveScope']>,
): void {
  if (scope !== null) {
    return;
  }

  if (eventHasExternalExposure(definition)) {
    throw new Error(
      `[EventPublisher] Event "${definition.key}" exposes external delivery but resolved a null scope.`,
    );
  }
}

function validatePayload<K extends EventKey>(
  definition: EventDefinition<K>,
  payload: SlingshotEventMap[K],
): SlingshotEventMap[K] {
  if (!definition.schema) {
    return payload;
  }

  const result = definition.schema.safeParse(payload);
  if (!result.success) {
    throw new Error(
      `[EventPublisher] Event "${definition.key}" failed schema validation: ${result.error.message}`,
      { cause: result.error },
    );
  }

  return result.data;
}

/**
 * Create a {@link SlingshotEvents} instance backed by a definition registry and event bus.
 *
 * The returned publisher validates payloads against the definition's Zod schema,
 * resolves event scope via the definition's `resolveScope`, wraps the result in a
 * deep-frozen {@link EventEnvelope}, and emits it through the provided bus.
 *
 * @param options - Registry and bus to wire together.
 * @returns A fully wired event publisher ready for plugin use.
 */
export function createEventPublisher(options: CreateEventPublisherOptions): SlingshotEvents {
  return {
    definitions: options.definitions,

    register<K extends EventKey>(definition: EventDefinition<K>): void {
      options.definitions.register(definition);
    },

    get<K extends EventKey>(key: K): EventDefinition<K> | undefined {
      return options.definitions.get(key);
    },

    list(): readonly EventDefinition[] {
      return options.definitions.list();
    },

    publish<K extends EventKey>(
      key: K,
      payload: SlingshotEventMap[K],
      ctx: EventPublishContext,
    ): EventEnvelope<K> {
      const definition = options.definitions.get(key);
      if (!definition) {
        throw new Error(
          `[EventPublisher] Event "${key}" is not registered. Register a definition before publishing.`,
        );
      }

      const validatedPayload = validatePayload(definition, payload);
      const scope = definition.resolveScope(validatedPayload, ctx);
      validateProjectedScope(definition, scope);

      const envelope = createEventEnvelope({
        key,
        payload: validatedPayload,
        ownerPlugin: definition.ownerPlugin,
        exposure: definition.exposure,
        scope,
        requestId: ctx.requestId,
        correlationId: ctx.correlationId,
        source: ctx.source,
        requestTenantId: ctx.requestTenantId,
      });

      const busWithEnvelopeEmit = options.bus as SlingshotEventBus & {
        emit<K2 extends EventKey>(
          key: K2,
          payload: SlingshotEventMap[K2] | EventEnvelope<K2>,
        ): void;
      };
      busWithEnvelopeEmit.emit(key, envelope);
      return envelope;
    },
  };
}

/**
 * Check whether a subscription principal is authorized to receive a given event envelope.
 *
 * Uses the definition's custom `authorizeSubscriber` when provided, otherwise falls back
 * to the default scope-matching authorizer from {@link createDefaultSubscriberAuthorizer}.
 *
 * @param definition - The event definition containing authorization rules.
 * @param principal - The subscriber identity to authorize (user, tenant, or system).
 * @param envelope - The event envelope carrying scope metadata for the check.
 * @returns `true` if the principal is allowed to receive this event.
 */
export function authorizeEventSubscriber<K extends EventKey>(
  definition: EventDefinition<K>,
  principal: EventSubscriptionPrincipal,
  envelope: EventEnvelope<K>,
): boolean {
  const authorizer =
    definition.authorizeSubscriber ?? createDefaultSubscriberAuthorizer(definition);
  return authorizer(principal, envelope);
}
