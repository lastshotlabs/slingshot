import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import type {
  EntityAdapter,
  EntityBackendProfile,
  OperationConfig,
  PostgresBundle,
  StoreInfra,
  StoreType,
  TransactionManager,
  TransactionScope,
  TransactionStore,
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
  readonly infra: StoreInfra;
  readonly composite: Readonly<Record<string, unknown>>;
  readonly buildComposite: (infra: StoreInfra) => Readonly<Record<string, unknown>>;
}

const RESOLVE_TRANSACTION_SCOPE_INFRA = Symbol.for('slingshot.resolveTransactionScopeInfra');
const SCOPED_POSTGRES_QUERYABLE = Symbol.for('slingshot.scopedPostgresQueryable');

interface ConformanceTransactionState {
  readonly scope: TransactionScope;
  readonly infra: StoreInfra;
}

/**
 * The backend driver exercises the same StoreInfra/TransactionManager protocol as
 * an application without importing the root framework package into slingshot-entity.
 * The production provider itself is covered by root unit and Docker integration tests.
 */
function createConformanceStoreInfra(pool: import('pg').Pool): StoreInfra {
  const active = new AsyncLocalStorage<ConformanceTransactionState>();
  const manager: TransactionManager = {
    supports(store: StoreType): store is TransactionStore {
      return store === 'postgres';
    },
    async run<T>(
      store: TransactionStore,
      callback: (scope: TransactionScope) => T | Promise<T>,
    ): Promise<T> {
      const current = active.getStore();
      if (current) {
        if (store !== current.scope.store) {
          throw new Error(
            `Transaction scope for '${current.scope.store}' cannot be used with '${store}'.`,
          );
        }
        return callback(current.scope);
      }
      if (store !== 'postgres') {
        throw new Error(`Store '${store}' is unavailable in the PostgreSQL conformance driver.`);
      }

      const client = await pool.connect();
      const scope = Object.freeze({
        store: 'postgres',
        id: randomUUID(),
      }) as unknown as TransactionScope;
      let rollbackOnly = false;
      let rollbackOnlyError: unknown;
      const queryable = Object.freeze({
        [SCOPED_POSTGRES_QUERYABLE]: true,
        async query(sql: string, params?: unknown[]) {
          try {
            return await client.query(sql, params);
          } catch (error) {
            rollbackOnly = true;
            rollbackOnlyError ??= error;
            throw error;
          }
        },
      });
      const scopedInfra = Object.create(infra) as StoreInfra;
      Object.defineProperty(scopedInfra, 'getPostgres', {
        configurable: false,
        enumerable: true,
        writable: false,
        value: () => ({ pool: queryable, db: {} }) as unknown as PostgresBundle,
      });
      const state: ConformanceTransactionState = { scope, infra: scopedInfra };

      try {
        await client.query('BEGIN');
        const result = await active.run(state, () => callback(scope));
        if (rollbackOnly) throw rollbackOnlyError;
        await client.query('COMMIT');
        return result;
      } catch (error) {
        try {
          await client.query('ROLLBACK');
        } catch {
          // Preserve the callback/query error.
        }
        throw error;
      } finally {
        client.release();
      }
    },
  };

  const infra: StoreInfra = {
    appName: 'entity-conformance',
    getTransactions: () => manager,
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
  Object.defineProperty(infra, RESOLVE_TRANSACTION_SCOPE_INFRA, {
    configurable: false,
    enumerable: false,
    writable: false,
    value: (scope: TransactionScope): StoreInfra => {
      const current = active.getStore();
      if (!current || current.scope !== scope) {
        throw new Error('[entity-conformance] Invalid PostgreSQL transaction scope.');
      }
      return current.infra;
    },
  });
  return infra;
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

function compositeOperationAvailable(
  operation: (typeof CONFORMANCE_COMPOSITE_OPERATIONS)[keyof typeof CONFORMANCE_COMPOSITE_OPERATIONS],
  entries: Readonly<Record<string, CompositeEntry>>,
): boolean {
  return (
    operation.kind !== 'transaction' ||
    operation.steps.every(step => {
      if (!('operation' in step)) return true;
      const namedOperation = step.operation;
      return (
        typeof namedOperation === 'string' &&
        entries[step.entity]?.operations?.[namedOperation] !== undefined
      );
    })
  );
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

    const infra = createConformanceStoreInfra(pool);

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
        return (
          capabilities.every(
            capability => profile.capabilities[capability].status === 'supported',
          ) && compositeOperationAvailable(operation, entries)
        );
      }),
    );
    const factories = createCompositeFactories(entries, operations);
    const buildComposite = (targetInfra: StoreInfra) => factories.postgres(targetInfra);
    const composite = buildComposite(infra);
    return { pool, schema, infra, composite, buildComposite };
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
        get transactions() {
          return {
            store: 'postgres' as const,
            manager: resources.infra.getTransactions(),
            adapter<Entity, CreateInput, UpdateInput>(
              key: string,
              scope: TransactionScope,
            ): EntityAdapter<Entity, CreateInput, UpdateInput> {
              const resolveInfra = Reflect.get(resources.infra, RESOLVE_TRANSACTION_SCOPE_INFRA);
              if (typeof resolveInfra !== 'function') {
                throw new Error('[entity-conformance] PostgreSQL scope resolver is unavailable');
              }
              const resolveAdapter = (): EntityAdapter<Entity, CreateInput, UpdateInput> => {
                const scoped = resources.buildComposite(resolveInfra(scope) as StoreInfra)[key];
                if (typeof scoped !== 'object' || scoped === null) {
                  throw new Error(`[entity-conformance] Unknown scoped adapter '${key}'`);
                }
                return scoped as EntityAdapter<Entity, CreateInput, UpdateInput>;
              };
              const proxyTarget = resolveAdapter();
              return new Proxy(proxyTarget, {
                get(_target, property) {
                  const value = Reflect.get(resolveAdapter(), property);
                  return typeof value === 'function' ? value.bind(resolveAdapter()) : value;
                },
              });
            },
          };
        },
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
