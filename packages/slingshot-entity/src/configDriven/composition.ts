/**
 * Multi-entity composition — combine multiple entity adapters into a
 * single plugin adapter, optionally with operations.
 *
 * Plugins typically persist several related entities together (e.g. rooms + messages).
 * Rather than returning multiple separate factory objects, `createCompositeFactories()`
 * merges them behind a single `RepoFactories<CompositeAdapter>` object. The composite
 * adapter exposes each entity's adapter under its own key, plus a `clear()` method
 * that resets all entities simultaneously (useful in tests).
 *
 * @example
 * ```ts
 * const factories = createCompositeFactories({
 *   rooms:    { config: Room },
 *   messages: { config: Message, operations: MessageOps.operations },
 * });
 *
 * // Resolved by the framework at startup:
 * const adapter = resolveRepo(factories, storeType, infra);
 * adapter.rooms.create({ name: 'General' });
 * adapter.messages.markDelivered({ id: '...' });
 * await adapter.clear(); // clears both rooms and messages
 * ```
 */
import type {
  EntityAdapter,
  InferCreateInput,
  InferEntity,
  InferOperationMethods,
  InferUpdateInput,
  OperationConfig,
  PipeOpConfig,
  RepoFactories,
  ResolvedEntityConfig,
  StoreInfra,
  TransactionOpConfig,
} from '@lastshotlabs/slingshot-core';
import type { StoreType } from '@lastshotlabs/slingshot-core';
import { createEntityFactories } from './createEntityFactories';
import type { SqliteDb } from './operationExecutors/dbInterfaces';
import { pipeExecutor } from './operationExecutors/pipe';
import type { AdapterMap } from './operationExecutors/transaction';
import { transactionExecutor } from './operationExecutors/transaction';
import { createPostgresEntityAdapter } from './postgresAdapter';

// ---------------------------------------------------------------------------
// Input types
// ---------------------------------------------------------------------------

/**
 * A single entry in the composite entity map.
 * Provides the resolved entity config and an optional set of operation configs.
 */
interface EntityEntry {
  /** The resolved entity config produced by `defineEntity(...).config`. */
  config: ResolvedEntityConfig;
  /**
   * Optional operation configs for this entity (from `defineOperations().operations`).
   * When omitted, the adapter exposes only the standard CRUD + list methods.
   */
  operations?: Record<string, OperationConfig>;
}

type AdapterForEntry<E extends EntityEntry> = EntityAdapter<
  InferEntity<E['config']['fields']>,
  InferCreateInput<E['config']['fields']>,
  InferUpdateInput<E['config']['fields']>
> &
  (E['operations'] extends Record<string, OperationConfig>
    ? InferOperationMethods<E['operations'], InferEntity<E['config']['fields']>>
    : Record<string, never>);

type CompositeFactoryMap<M extends Record<string, EntityEntry>> = {
  [K in keyof M]: RepoFactories<AdapterForEntry<M[K]>>;
};

// ---------------------------------------------------------------------------
// Composite-level operation types
// ---------------------------------------------------------------------------

/**
 * Operation kinds that operate across multiple entities and must be wired at the
 * composite level — they require the full adapters map, not a single entity adapter.
 */
type CompositeOpConfig = TransactionOpConfig | PipeOpConfig;

interface PostgresTxClient {
  query(
    sql: string,
    params?: unknown[],
  ): Promise<{ rows: Record<string, unknown>[]; rowCount: number | null }>;
  release(): void;
}

interface PostgresTxPool {
  connect(): Promise<PostgresTxClient>;
}

// ---------------------------------------------------------------------------
// Type-level inference
// ---------------------------------------------------------------------------

type InferCompositeAdapter<
  M extends Record<string, EntityEntry>,
  COps extends Record<string, CompositeOpConfig> = Record<never, never>,
> = {
  [K in keyof M]: AdapterForEntry<M[K]>;
} & InferOperationMethods<COps, Record<string, unknown>> & {
    clear(): Promise<void>;
  };

// ---------------------------------------------------------------------------
// createCompositeFactories()
// ---------------------------------------------------------------------------

/**
 * Create a `RepoFactories` object that produces a composite adapter covering
 * all the supplied entities, plus any cross-entity `transaction` or `pipe` operations.
 *
 * Each entry in `entities` maps a key name to an `{ config, operations? }` pair.
 * The returned factories object has a factory for every `StoreType` (`memory`, `redis`,
 * `sqlite`, `mongo`, `postgres`). When a factory is called by `resolveRepo()`, it
 * instantiates an individual adapter for each entity, wires any composite operations
 * against the full adapters map, and combines everything into a single composite object
 * that also exposes a `clear()` method.
 *
 * TypeScript infers the full shape of the composite adapter from both the entity map and
 * the composite operations map, including all operation method signatures.
 *
 * **Why composite operations?**
 * `op.transaction` and `op.pipe` need access to multiple entity adapters simultaneously —
 * they cannot be wired inside a single entity's adapter factory. Declare them here so they
 * receive the full adapters map at wiring time.
 *
 * **Atomicity:**
 * - `memory` — steps run sequentially in a single JS thread; already atomic.
 * - `sqlite` — steps are wrapped in an explicit `BEGIN` / `COMMIT` / `ROLLBACK` block.
 * - `postgres` — transaction ops run on a single `pg` client inside `BEGIN` / `COMMIT` /
 *   `ROLLBACK`, so all steps share one real database transaction.
 * - `mongo`, `redis` — no transaction wrapper is applied yet. These backends require
 *   backend-specific session or multi-command transaction support and are left for future work.
 *
 * @param entities   - Map of key → `{ config, operations? }` describing each entity.
 * @param operations - Optional map of cross-entity operation name → `TransactionOpConfig` or
 *   `PipeOpConfig`. `transaction` steps reference entities by the keys used in `entities`.
 * @returns A `RepoFactories<CompositeAdapter>` compatible with `resolveRepo()`.
 *
 * @example
 * ```ts
 * export const docFactories = createCompositeFactories(
 *   {
 *     documents: { config: Document, operations: DocumentOps.operations },
 *     snapshots: { config: Snapshot, operations: SnapshotOps.operations },
 *   },
 *   {
 *     revert: op.transaction({
 *       steps: [
 *         { op: 'lookup',      entity: 'snapshots', match: { id: 'param:versionId' } },
 *         { op: 'fieldUpdate', entity: 'documents', match: { id: 'param:id' },
 *           set: { title: 'result:0.title', body: 'result:0.body' } },
 *         { op: 'create',      entity: 'snapshots',
 *           input: { documentId: 'param:id', title: 'result:0.title', body: 'result:0.body' } },
 *       ],
 *     }),
 *   },
 * );
 * // docFactories.memory(infra) → { documents, snapshots, revert(params), clear() }
 * ```
 */
export function createCompositeFactories<
  M extends Record<string, EntityEntry>,
  COps extends Record<string, CompositeOpConfig> = Record<never, never>,
>(entities: M, operations?: COps): RepoFactories<InferCompositeAdapter<M, COps>> {
  const individualFactories = {} as unknown as CompositeFactoryMap<M>;
  const keys = Object.keys(entities) as Array<keyof M>;

  for (const key of keys) {
    const entry = entities[key];
    individualFactories[key] = createCompositeEntryFactories(entry);
  }

  function buildComposite(storeType: StoreType, infra: StoreInfra): InferCompositeAdapter<M, COps> {
    const adapters = {} as unknown as { [K in keyof M]: AdapterForEntry<M[K]> };

    for (const key of keys) {
      adapters[key] = individualFactories[key][storeType](infra);
    }

    // Determine a transaction wrapper for backends that support it.
    let wrapInTransaction: ((fn: () => Promise<void>) => Promise<void>) | undefined;
    if (storeType === 'memory') {
      // Single-threaded; steps are already sequentially atomic. No wrapper needed
      // but we still assign a pass-through so the option path is exercised uniformly.
      wrapInTransaction = fn => fn();
    } else if (storeType === 'sqlite') {
      const db = infra.getSqliteDb() as unknown as SqliteDb;
      wrapInTransaction = async fn => {
        db.run('BEGIN');
        try {
          await fn();
          db.run('COMMIT');
        } catch (e) {
          db.run('ROLLBACK');
          throw e;
        }
      };
    }
    // Postgres transaction ops are handled separately below so they can execute on a
    // single checked-out client. Mongo and Redis remain unwrapped for now.

    // Wire composite operations against the full adapters map.
    const compositeOpMethods: Record<string, unknown> = {};
    if (operations) {
      const adapterMap = adapters as unknown as AdapterMap;
      for (const [opName, op] of Object.entries(operations)) {
        if (op.kind === 'transaction') {
          compositeOpMethods[opName] =
            storeType === 'postgres'
              ? createPostgresTransactionMethod(op, entities, keys, infra)
              : transactionExecutor(op, adapterMap, { wrapInTransaction });
        } else {
          // pipe takes a single adapter — use the first entity's adapter as the target.
          // For cross-entity pipe, use a transaction instead.
          const adapterValues = Object.values(adapters) as AdapterForEntry<M[keyof M]>[];
          if (adapterValues.length > 0) {
            compositeOpMethods[opName] = pipeExecutor(
              op,
              adapterValues[0] as unknown as Parameters<typeof pipeExecutor>[1],
            );
          }
        }
      }
    }

    const composite: InferCompositeAdapter<M, COps> = {
      ...adapters,
      ...compositeOpMethods,
      async clear(): Promise<void> {
        await Promise.all(
          Object.values(adapters)
            .filter(
              (a): a is EntityAdapter<unknown, unknown, unknown> =>
                typeof a === 'object' && a !== null && 'clear' in a,
            )
            .map(a => a.clear()),
        );
      },
    } as unknown as InferCompositeAdapter<M, COps>;

    return composite;
  }

  return {
    memory: infra => buildComposite('memory', infra),
    redis: infra => buildComposite('redis', infra),
    sqlite: infra => buildComposite('sqlite', infra),
    mongo: infra => buildComposite('mongo', infra),
    postgres: infra => buildComposite('postgres', infra),
  };
}

function createPostgresTransactionMethod<M extends Record<string, EntityEntry>>(
  op: TransactionOpConfig,
  entities: M,
  keys: Array<keyof M>,
  infra: StoreInfra,
): (params: Record<string, unknown>) => Promise<Array<Record<string, unknown>>> {
  const pool = infra.getPostgres().pool as unknown as PostgresTxPool;

  return async (params: Record<string, unknown>) => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const transactionalAdapters = {} as unknown as { [K in keyof M]: AdapterForEntry<M[K]> };
      for (const key of keys) {
        const entry = entities[key];
        transactionalAdapters[key] = createPostgresEntityAdapter(
          client,
          entry.config,
          entry.operations,
        ) as AdapterForEntry<M[typeof key]>;
      }

      const executor = transactionExecutor(op, transactionalAdapters as unknown as AdapterMap);
      const results = await executor(params);

      await client.query('COMMIT');
      return results;
    } catch (error) {
      try {
        await client.query('ROLLBACK');
      } catch {
        // Preserve the original transaction failure.
      }
      throw error;
    } finally {
      client.release();
    }
  };
}

/**
 * Create per-backend factories for a single entity entry.
 *
 * Delegates to `createEntityFactories()`, passing `entry.operations` when present.
 * The `as RepoFactories<AdapterForEntry<E>>` cast is the sole opaque boundary here —
 * `createEntityFactories()` returns `RepoFactories<EntityAdapter & Record<string,unknown>>`
 * and the type parameter inference cannot flow through without the cast.
 *
 * @param entry - A single entity entry with config and optional operations.
 * @returns `RepoFactories` for the entity's adapter type.
 */
function createCompositeEntryFactories<E extends EntityEntry>(
  entry: E,
): RepoFactories<AdapterForEntry<E>> {
  return (
    entry.operations
      ? createEntityFactories(entry.config, entry.operations)
      : createEntityFactories(entry.config)
  ) as RepoFactories<AdapterForEntry<E>>;
}
