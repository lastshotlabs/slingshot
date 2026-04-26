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

export interface SlingshotEvents {
  readonly definitions: EventDefinitionRegistry;
  register<K extends EventKey>(definition: EventDefinition<K>): void;
  get<K extends EventKey>(key: K): EventDefinition<K> | undefined;
  list(): readonly EventDefinition[];
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

export function authorizeEventSubscriber<K extends EventKey>(
  definition: EventDefinition<K>,
  principal: EventSubscriptionPrincipal,
  envelope: EventEnvelope<K>,
): boolean {
  const authorizer =
    definition.authorizeSubscriber ?? createDefaultSubscriberAuthorizer(definition);
  return authorizer?.(principal, envelope) ?? false;
}
