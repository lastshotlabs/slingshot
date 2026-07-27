import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Database } from 'bun:sqlite';
import type {
  EntityAdapter,
  EntityBackendProfile,
  OperationConfig,
  RuntimeSqliteDatabase,
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

interface SqliteResources {
  readonly db: Database;
  readonly directory: string;
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
): Promise<SqliteResources> {
  const { Database: SqliteDatabase } = await import('bun:sqlite');
  const directory = await mkdtemp(join(tmpdir(), 'slingshot-entity-conformance-'));
  const db = new SqliteDatabase(join(directory, 'conformance.sqlite'));
  db.run('PRAGMA journal_mode = WAL');
  db.run('PRAGMA busy_timeout = 5000');

  const infra: StoreInfra = {
    appName: 'entity-conformance',
    getRedis() {
      throw new Error('[entity-conformance] Redis is unavailable in the SQLite driver');
    },
    getMongo() {
      throw new Error('[entity-conformance] MongoDB is unavailable in the SQLite driver');
    },
    getSqliteDb() {
      return db as RuntimeSqliteDatabase;
    },
    getPostgres() {
      throw new Error('[entity-conformance] PostgreSQL is unavailable in the SQLite driver');
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
  const composite = createCompositeFactories(entries, operations).sqlite(infra);
  return { db, directory, composite };
}

async function destroyResources(resources: SqliteResources | undefined): Promise<void> {
  if (!resources) return;
  resources.db.close();
  await rm(resources.directory, { recursive: true, force: true });
}

/** Create a file-backed, temporary driver for the standard SQLite entity adapter. */
export function createSqliteEntityConformanceDriver(): EntityConformanceDriver {
  const profile = ENTITY_BACKEND_PROFILES.sqlite;
  return {
    name: 'sqlite',
    profile,
    async createHarness(
      definitions: readonly EntityConformanceDefinition[],
    ): Promise<EntityConformanceHarness> {
      let resources = await createResources(definitions, profile);
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
            throw new Error('[entity-conformance] Cannot reset a destroyed SQLite harness');
          }
          const previous = resources;
          resources = await createResources(definitions, profile);
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
