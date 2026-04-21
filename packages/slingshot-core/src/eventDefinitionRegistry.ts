import type { EventDefinition, EventKey } from './eventDefinition';
import { defineEvent } from './eventDefinition';
import type { EventSchemaRegistry } from './eventSchemaRegistry';

export interface EventDefinitionRegistry {
  register<K extends EventKey>(definition: EventDefinition<K>): void;
  get<K extends EventKey>(key: K): EventDefinition<K> | undefined;
  has(key: EventKey): boolean;
  list(): readonly EventDefinition[];
  freeze(): void;
  readonly frozen: boolean;
}

export interface EventDefinitionRegistryOptions {
  schemaRegistry?: EventSchemaRegistry;
}

export function createEventDefinitionRegistry(
  options: EventDefinitionRegistryOptions = {},
): EventDefinitionRegistry {
  const definitions = new Map<EventKey, EventDefinition>();
  let frozen = false;
  let frozenSnapshot: readonly EventDefinition[] | null = null;

  return {
    register<K extends EventKey>(definition: EventDefinition<K>): void {
      if (frozen) {
        throw new Error(
          `[EventDefinitionRegistry] Cannot register "${definition.key}" after the registry is frozen.`,
        );
      }

      if (definitions.has(definition.key)) {
        throw new Error(
          `[EventDefinitionRegistry] Event "${definition.key}" is already registered.`,
        );
      }

      const frozenDefinition = defineEvent(definition.key, {
        ownerPlugin: definition.ownerPlugin,
        exposure: definition.exposure,
        schema: definition.schema,
        resolveScope: definition.resolveScope,
        authorizeSubscriber: definition.authorizeSubscriber,
        projectPayload: definition.projectPayload,
      });

      if (frozenDefinition.schema) {
        options.schemaRegistry?.register(frozenDefinition.key, frozenDefinition.schema);
      }

      definitions.set(frozenDefinition.key, frozenDefinition as EventDefinition);
    },

    get<K extends EventKey>(key: K): EventDefinition<K> | undefined {
      return definitions.get(key) as EventDefinition<K> | undefined;
    },

    has(key: EventKey): boolean {
      return definitions.has(key);
    },

    list(): readonly EventDefinition[] {
      if (frozen && frozenSnapshot) {
        return frozenSnapshot;
      }

      const snapshot = Object.freeze([...definitions.values()]);
      if (frozen) {
        frozenSnapshot = snapshot;
      }
      return snapshot;
    },

    freeze(): void {
      if (frozen) {
        return;
      }
      frozen = true;
      frozenSnapshot = Object.freeze([...definitions.values()]);
    },

    get frozen(): boolean {
      return frozen;
    },
  };
}
