import { randomUUID } from 'node:crypto';
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

const DEFAULT_MONGO_URL = 'mongodb://localhost:27018/slingshot_test';

type CompositeEntry = {
  readonly config: EntityConformanceDefinition['config'];
  readonly operations?: Record<string, OperationConfig>;
};

interface MongoResources {
  readonly conn: import('mongoose').Connection;
  readonly composite: Readonly<Record<string, unknown>>;
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

async function createResources(
  definitions: readonly EntityConformanceDefinition[],
  profile: EntityBackendProfile,
  connectionString: string,
): Promise<MongoResources> {
  const mg = await import('mongoose');
  const database = `slingshot_conformance_${randomUUID().replaceAll('-', '_')}`;
  const conn = await mg.createConnection(connectionString, { dbName: database }).asPromise();

  try {
    const infra: StoreInfra = {
      appName: 'entity-conformance',
      getRedis() {
        throw new Error('[entity-conformance] Redis is unavailable in the MongoDB driver');
      },
      getMongo() {
        return { conn, mg };
      },
      getSqliteDb() {
        throw new Error('[entity-conformance] SQLite is unavailable in the MongoDB driver');
      },
      getPostgres() {
        throw new Error('[entity-conformance] PostgreSQL is unavailable in the MongoDB driver');
      },
    };

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
    return {
      conn,
      composite: createCompositeFactories(entries, operations).mongo(infra),
    };
  } catch (error) {
    try {
      await conn.dropDatabase();
    } finally {
      await conn.close();
    }
    throw error;
  }
}

async function destroyResources(resources: MongoResources | undefined): Promise<void> {
  if (!resources) return;
  try {
    await resources.conn.dropDatabase();
  } finally {
    await resources.conn.close();
  }
}

/**
 * Create a live MongoDB conformance driver.
 *
 * Each harness/reset uses a unique database and drops only that database on
 * cleanup. The connection defaults to `TEST_MONGO_URL` and then the repository
 * Docker MongoDB URL.
 */
export function createMongoEntityConformanceDriver(
  connectionString = process.env['TEST_MONGO_URL'] ?? DEFAULT_MONGO_URL,
): EntityConformanceDriver {
  const profile = ENTITY_BACKEND_PROFILES.mongo;
  return {
    name: 'mongo',
    profile,
    async createHarness(
      definitions: readonly EntityConformanceDefinition[],
    ): Promise<EntityConformanceHarness> {
      let resources = await createResources(definitions, profile, connectionString);
      let destroyed = false;

      return {
        adapter<Entity, CreateInput, UpdateInput>(
          key: string,
        ): EntityAdapter<Entity, CreateInput, UpdateInput> {
          const value = resources.composite[key];
          if (typeof value !== 'object' || value === null) {
            throw new Error(`[entity-conformance] Unknown adapter '${key}'`);
          }
          return value as EntityAdapter<Entity, CreateInput, UpdateInput>;
        },
        composite(name: string): Readonly<Record<string, unknown>> {
          if (name !== CONFORMANCE_COMPOSITE_KEY) {
            throw new Error(`[entity-conformance] Unknown composite '${name}'`);
          }
          return resources.composite;
        },
        async reset(): Promise<void> {
          if (destroyed) {
            throw new Error('[entity-conformance] Cannot reset a destroyed MongoDB harness');
          }
          const previous = resources;
          resources = await createResources(definitions, profile, connectionString);
          await destroyResources(previous);
        },
        async destroy(): Promise<void> {
          if (destroyed) return;
          destroyed = true;
          await destroyResources(resources);
        },
      };
    },
  };
}
