/**
 * Postgres backend operation wiring.
 *
 * Iterates over a `Record<string, OperationConfig>` and dispatches each entry to
 * the corresponding Postgres executor function, returning a flat map of
 * `operationName → bound function` that is spread onto the adapter object.
 *
 * Executors receive a `PgPool` handle, the table name, an async `ensureTable()`
 * initializer, and field-mapping helpers (`fromRow` / `toRow`) by closure.
 * `fromRow` converts snake_case Postgres columns back to camelCase domain fields.
 * `toRow` converts domain records to their Postgres snake_case representation.
 *
 * **Special cases:**
 * - `collection` expands into up to five sub-methods: `{opName}List`, `{opName}Add`,
 *   `{opName}Remove`, `{opName}Update`, `{opName}Set`.
 * - `transaction` and `pipe` are skipped — wired at the composite-adapter level.
 * - `custom` invokes `op.postgres(pool)` if provided; throws otherwise.
 *
 * **Adding a new operation kind:**
 * 1. Add a `case 'myKind':` block here calling the corresponding `myKindPostgres()` executor.
 * 2. Add the same case to `memoryOperationWiring.ts`, `sqliteOperationWiring.ts`,
 *    `mongoOperationWiring.ts`, and `redisOperationWiring.ts`.
 * 3. Implement `myKindPostgres()` in `operationExecutors/myKind.ts`.
 */
import type { OperationConfig, ResolvedEntityConfig } from '@lastshotlabs/slingshot-core';
import { fromPgRow, toPgRow } from './fieldUtils';
import { aggregatePostgres } from './operationExecutors/aggregate';
import { arrayPullPostgres } from './operationExecutors/arrayPull';
import { arrayPushPostgres } from './operationExecutors/arrayPush';
import { arraySetPostgres } from './operationExecutors/arraySet';
import { batchPostgres } from './operationExecutors/batch';
import { collectionPostgres } from './operationExecutors/collection';
import { computedAggregatePostgres } from './operationExecutors/computedAggregate';
import { consumePostgres } from './operationExecutors/consume';
import type { PgPool } from './operationExecutors/dbInterfaces';
import { derivePostgres } from './operationExecutors/derive';
import { existsPostgres } from './operationExecutors/exists';
import { fieldUpdatePostgres } from './operationExecutors/fieldUpdate';
import { incrementPostgres } from './operationExecutors/increment';
import { lookupPostgres } from './operationExecutors/lookup';
import { searchPostgres } from './operationExecutors/search';
import { transitionPostgres } from './operationExecutors/transition';
import { upsertPostgres } from './operationExecutors/upsert';

/**
 * Build the complete set of named operation functions for the Postgres backend.
 *
 * Iterates over `operations` and dispatches each entry to the matching executor.
 * The returned map is spread onto the adapter object so callers access operations
 * as `adapter.myOp(params)`.
 *
 * **Supported operation kinds:**
 * `lookup`, `exists`, `transition`, `fieldUpdate`, `arrayPush`, `arrayPull`, `arraySet`,
 * `increment`, `batch`, `upsert`, `consume`, `aggregate`, `search`, `collection`,
 * `computedAggregate`, `derive`, `custom`.
 *
 * Transaction behavior is decided per executor, not per entity. Single-statement
 * operations stay single-statement; multi-step operations own their own explicit
 * transaction wrapping when correctness requires it.
 *
 * **Deferred (not wired here):**
 * `transaction`, `pipe` — handled at the composite-adapter level.
 *
 * @param operations   - Map of operation name → `OperationConfig` (from `defineOperations()`).
 * @param config       - Resolved entity config for field metadata and soft-delete settings.
 * @param pool         - The `PgPool` connection pool.
 * @param table        - The Postgres table name for this entity (snake_case).
 * @param ensureTable  - Async lazy table-creation callback; each executor awaits this before its first query.
 * @returns A flat `Record<string, unknown>` mapping operation names to bound async functions.
 * @throws {Error} When a `custom` operation has no `postgres` handler defined.
 */
export function buildPostgresOperations(
  operations: Record<string, OperationConfig>,
  config: ResolvedEntityConfig,
  pool: PgPool,
  table: string,
  ensureTable: () => Promise<void>,
): Record<string, unknown> {
  const methods: Record<string, unknown> = {};
  const fromRow = (row: Record<string, unknown>) => fromPgRow(row, config.fields);
  const toRow = (record: Record<string, unknown>) => toPgRow(record, config.fields);

  for (const [opName, op] of Object.entries(operations)) {
    switch (op.kind) {
      case 'lookup':
        methods[opName] = lookupPostgres(op, config, pool, table, ensureTable, fromRow);
        break;
      case 'exists':
        methods[opName] = existsPostgres(op, pool, table, ensureTable);
        break;
      case 'transition':
        methods[opName] = transitionPostgres(op, pool, table, ensureTable, fromRow);
        break;
      case 'fieldUpdate':
        methods[opName] = fieldUpdatePostgres(op, config, pool, table, ensureTable, fromRow);
        break;
      case 'arrayPush':
        methods[opName] = arrayPushPostgres(op, config, pool, table, ensureTable, fromRow);
        break;
      case 'arrayPull':
        methods[opName] = arrayPullPostgres(op, config, pool, table, ensureTable, fromRow);
        break;
      case 'arraySet':
        methods[opName] = arraySetPostgres(op, config, pool, table, ensureTable, fromRow);
        break;
      case 'increment':
        methods[opName] = incrementPostgres(op, config, pool, table, ensureTable, fromRow);
        break;
      case 'batch':
        methods[opName] = batchPostgres(op, config, pool, table, ensureTable);
        break;
      case 'upsert':
        methods[opName] = upsertPostgres(op, config, pool, table, ensureTable, toRow, fromRow);
        break;
      case 'consume':
        methods[opName] = consumePostgres(op, config, pool, table, ensureTable, fromRow);
        break;
      case 'aggregate':
        methods[opName] = aggregatePostgres(op, config, pool, table, ensureTable);
        break;
      case 'search':
        methods[opName] = searchPostgres(op, pool, table, ensureTable, fromRow);
        break;
      case 'collection': {
        const coll = collectionPostgres(opName, op, config, pool, table, ensureTable);
        if (coll.list) methods[`${opName}List`] = coll.list;
        if (coll.add) methods[`${opName}Add`] = coll.add;
        if (coll.remove) methods[`${opName}Remove`] = coll.remove;
        if (coll.update) methods[`${opName}Update`] = coll.update;
        if (coll.set) methods[`${opName}Set`] = coll.set;
        break;
      }
      case 'computedAggregate':
        methods[opName] = computedAggregatePostgres(op, config, pool, table, ensureTable);
        break;
      case 'derive':
        methods[opName] = derivePostgres(op, config, pool, table, ensureTable, fromRow);
        break;
      case 'transaction':
      case 'pipe':
        break;
      case 'custom':
        if (op.postgres) {
          methods[opName] = op.postgres(pool);
        }
        // No factory → method expected to be mixed onto the adapter externally (e.g. from a composite).
        break;
    }
  }

  return methods;
}
