import type {
  EntityAdapter,
  EntityBackendProfile,
  OperationConfig,
  StoreInfra,
} from '@lastshotlabs/slingshot-core';
import { createCompositeFactories, resolveEntityBackendRequirements } from '../../configDriven';
import { ENTITY_BACKEND_PROFILES } from '../../configDriven/backendProfiles';
import type {
  EntityConformanceDefinition,
  EntityConformanceDriver,
  EntityConformanceHarness,
} from '../conformance';
import { CONFORMANCE_COMPOSITE_KEY, CONFORMANCE_COMPOSITE_OPERATIONS } from '../fixtures';

type CompositeEntry = {
  readonly config: EntityConformanceDefinition['config'];
  readonly operations?: Record<string, OperationConfig>;
};

function createInfra(): StoreInfra {
  const unavailable = (store: string): never => {
    throw new Error(`[entity-conformance] ${store} is unavailable in the memory driver`);
  };
  return {
    appName: 'entity-conformance',
    getRedis: () => unavailable('Redis'),
    getMongo: () => unavailable('MongoDB'),
    getSqliteDb: () => unavailable('SQLite'),
    getPostgres: () => unavailable('PostgreSQL'),
  };
}

function supportedOperations(
  profile: EntityBackendProfile,
  definition: EntityConformanceDefinition,
): Record<string, OperationConfig> | undefined {
  if (!definition.operations) return undefined;
  const selected: Record<string, OperationConfig> = {};
  for (const [name, operation] of Object.entries(definition.operations)) {
    const requirements = resolveEntityBackendRequirements(definition.config, { [name]: operation });
    if (
      requirements.every(
        requirement => profile.capabilities[requirement.capability].status === 'supported',
      )
    ) {
      selected[name] = operation;
    }
  }
  return Object.keys(selected).length > 0 ? selected : undefined;
}

function buildComposite(
  definitions: readonly EntityConformanceDefinition[],
  profile: EntityBackendProfile,
): Readonly<Record<string, unknown>> {
  const entries: Record<string, CompositeEntry> = {};
  for (const definition of definitions) {
    const operations = supportedOperations(profile, definition);
    entries[definition.key] = {
      config: definition.config,
      ...(operations ? { operations } : {}),
    };
  }
  const operations = Object.fromEntries(
    Object.entries(CONFORMANCE_COMPOSITE_OPERATIONS).filter(([, operation]) => {
      const capabilities =
        operation.kind === 'transaction'
          ? (['operation.transaction', 'transaction.rollback'] as const)
          : (['operation.pipe'] as const);
      return capabilities.every(
        capability => profile.capabilities[capability].status === 'supported',
      );
    }),
  );
  return createCompositeFactories(entries, operations).memory(createInfra());
}

/** Create a fresh in-process driver for the standard memory entity adapter. */
export function createMemoryEntityConformanceDriver(): EntityConformanceDriver {
  const profile = ENTITY_BACKEND_PROFILES.memory;
  return {
    name: 'memory',
    profile,
    async createHarness(
      definitions: readonly EntityConformanceDefinition[],
    ): Promise<EntityConformanceHarness> {
      let composite = buildComposite(definitions, profile);
      let destroyed = false;

      return {
        adapter<Entity, CreateInput, UpdateInput>(
          key: string,
        ): EntityAdapter<Entity, CreateInput, UpdateInput> {
          const value = composite[key];
          if (typeof value !== 'object' || value === null) {
            throw new Error(`[entity-conformance] Unknown adapter '${key}'`);
          }
          return value as EntityAdapter<Entity, CreateInput, UpdateInput>;
        },
        composite(name: string): Readonly<Record<string, unknown>> {
          if (name !== CONFORMANCE_COMPOSITE_KEY) {
            throw new Error(`[entity-conformance] Unknown composite '${name}'`);
          }
          return composite;
        },
        async reset(): Promise<void> {
          if (destroyed) {
            throw new Error('[entity-conformance] Cannot reset a destroyed memory harness');
          }
          composite = buildComposite(definitions, profile);
        },
        async destroy(): Promise<void> {
          if (destroyed) return;
          destroyed = true;
          const clear = composite['clear'];
          if (typeof clear === 'function') {
            await (clear as () => Promise<void>)();
          }
        },
      };
    },
  };
}
