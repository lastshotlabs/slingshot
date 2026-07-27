import { randomUUID } from 'node:crypto';
import type {
  EntityAdapter,
  EntityBackendProfile,
  OperationConfig,
  StoreInfra,
} from '@lastshotlabs/slingshot-core';
import { createCompositeFactories, resolveEntityBackendRequirements } from '../../configDriven';
import { ENTITY_BACKEND_PROFILES } from '../../configDriven/backendProfiles';
import { quoteSqlIdent } from '../../lib/naming';
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

interface PostgresResources {
  readonly pool: import('pg').Pool;
  readonly schema: string;
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
): Promise<PostgresResources> {
  const { Pool } = await import('pg');
  const schema = `slingshot_conformance_${randomUUID().replaceAll('-', '_')}`;
  const quotedSchema = quoteSqlIdent(schema);
  const pool = new Pool({
    connectionString,
    max: 1,
    idleTimeoutMillis: 0,
    options: `-c search_path=${schema}`,
  });

  try {
    await pool.query(`CREATE SCHEMA ${quotedSchema}`);
    await pool.query(`SET search_path TO ${quotedSchema}`);

    const infra: StoreInfra = {
      appName: 'entity-conformance',
      getRedis() {
        throw new Error('[entity-conformance] Redis is unavailable in the PostgreSQL driver');
      },
      getMongo() {
        throw new Error('[entity-conformance] MongoDB is unavailable in the PostgreSQL driver');
      },
      getSqliteDb() {
        throw new Error('[entity-conformance] SQLite is unavailable in the PostgreSQL driver');
      },
      getPostgres() {
        return { pool, db: {} };
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
    const composite = createCompositeFactories(entries, operations).postgres(infra);
    return { pool, schema, composite };
  } catch (error) {
    try {
      await pool.query(`DROP SCHEMA IF EXISTS ${quotedSchema} CASCADE`);
    } finally {
      await pool.end();
    }
    throw error;
  }
}

async function destroyResources(resources: PostgresResources | undefined): Promise<void> {
  if (!resources) return;
  try {
    await resources.pool.query(`DROP SCHEMA IF EXISTS ${quoteSqlIdent(resources.schema)} CASCADE`);
  } finally {
    await resources.pool.end();
  }
}

/**
 * Create a live PostgreSQL conformance driver.
 *
 * Every harness/reset owns a uniquely named schema on a single-connection pool.
 * Cleanup drops only that quoted schema. The default connection string comes
 * from `TEST_POSTGRES_URL`.
 */
export function createPostgresEntityConformanceDriver(
  connectionString = process.env['TEST_POSTGRES_URL'],
): EntityConformanceDriver {
  const profile = ENTITY_BACKEND_PROFILES.postgres;
  return {
    name: 'postgres',
    profile,
    async createHarness(
      definitions: readonly EntityConformanceDefinition[],
    ): Promise<EntityConformanceHarness> {
      if (!connectionString) {
        throw new Error(
          '[entity-conformance] TEST_POSTGRES_URL is required for the PostgreSQL driver',
        );
      }
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
            throw new Error('[entity-conformance] Cannot reset a destroyed PostgreSQL harness');
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
