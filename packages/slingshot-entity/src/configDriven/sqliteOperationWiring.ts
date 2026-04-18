/**
 * SQLite backend operation wiring.
 *
 * Iterates over a `Record<string, OperationConfig>` and dispatches each entry to
 * the corresponding SQLite executor function, returning a flat map of
 * `operationName → bound function` that is spread onto the adapter object.
 *
 * Executors receive the `SqliteDb` handle, the table name, a lazy `ensureTable()`
 * initializer, and field-mapping helpers (`fromRow` / `toRow`) by closure.
 *
 * **Special cases:**
 * - `collection` expands into up to five sub-methods: `{opName}List`, `{opName}Add`,
 *   `{opName}Remove`, `{opName}Update`, `{opName}Set`.
 * - `transaction` and `pipe` are skipped — wired at the composite-adapter level.
 * - `custom` invokes `op.sqlite(db)` if provided; throws otherwise.
 *
 * **Adding a new operation kind:**
 * 1. Add a `case 'myKind':` block here calling the corresponding `myKindSqlite()` executor.
 * 2. Add the same case to `memoryOperationWiring.ts`, `postgresOperationWiring.ts`,
 *    `mongoOperationWiring.ts`, and `redisOperationWiring.ts`.
 * 3. Implement `myKindSqlite()` in `operationExecutors/myKind.ts`.
 */
import type { OperationConfig, ResolvedEntityConfig } from '@lastshotlabs/slingshot-core';
import { fromSqliteRow, toSqliteRow } from './fieldUtils';
import { aggregateSqlite } from './operationExecutors/aggregate';
import { arrayPullSqlite } from './operationExecutors/arrayPull';
import { arrayPushSqlite } from './operationExecutors/arrayPush';
import { arraySetSqlite } from './operationExecutors/arraySet';
import { batchSqlite } from './operationExecutors/batch';
import { collectionSqlite } from './operationExecutors/collection';
import { computedAggregateSqlite } from './operationExecutors/computedAggregate';
import { consumeSqlite } from './operationExecutors/consume';
import type { SqliteDb } from './operationExecutors/dbInterfaces';
import { deriveSqlite } from './operationExecutors/derive';
import { existsSqlite } from './operationExecutors/exists';
import { fieldUpdateSqlite } from './operationExecutors/fieldUpdate';
import { incrementSqlite } from './operationExecutors/increment';
import { lookupSqlite } from './operationExecutors/lookup';
import { searchSqlite } from './operationExecutors/search';
import { transitionSqlite } from './operationExecutors/transition';
import { upsertSqlite } from './operationExecutors/upsert';

/**
 * Build the complete set of named operation functions for the SQLite backend.
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
 * **Deferred (not wired here):**
 * `transaction`, `pipe` — handled at the composite-adapter level.
 *
 * @param operations   - Map of operation name → `OperationConfig` (from `defineOperations()`).
 * @param config       - Resolved entity config for field metadata and soft-delete settings.
 * @param db           - The `SqliteDb` database handle.
 * @param table        - The SQL table name for this entity.
 * @param ensureTable  - Lazy table-creation callback; each executor calls this before its first query.
 * @returns A flat `Record<string, unknown>` mapping operation names to bound functions.
 * @throws {Error} When a `custom` operation has no `sqlite` handler defined.
 */
export function buildSqliteOperations(
  operations: Record<string, OperationConfig>,
  config: ResolvedEntityConfig,
  db: SqliteDb,
  table: string,
  ensureTable: () => void,
): Record<string, unknown> {
  const methods: Record<string, unknown> = {};
  const fromRow = (row: Record<string, unknown>) => fromSqliteRow(row, config.fields);
  const toRow = (record: Record<string, unknown>) => toSqliteRow(record, config.fields);

  for (const [opName, op] of Object.entries(operations)) {
    switch (op.kind) {
      case 'lookup':
        methods[opName] = lookupSqlite(op, config, db, table, ensureTable, fromRow);
        break;
      case 'exists':
        methods[opName] = existsSqlite(op, db, table, ensureTable);
        break;
      case 'transition':
        methods[opName] = transitionSqlite(op, db, table, ensureTable, fromRow);
        break;
      case 'fieldUpdate':
        methods[opName] = fieldUpdateSqlite(op, config, db, table, ensureTable, fromRow);
        break;
      case 'arrayPush':
        methods[opName] = arrayPushSqlite(op, config, db, table, ensureTable, fromRow);
        break;
      case 'arrayPull':
        methods[opName] = arrayPullSqlite(op, config, db, table, ensureTable, fromRow);
        break;
      case 'arraySet':
        methods[opName] = arraySetSqlite(op, config, db, table, ensureTable, fromRow);
        break;
      case 'increment':
        methods[opName] = incrementSqlite(op, config, db, table, ensureTable, fromRow);
        break;
      case 'batch':
        methods[opName] = batchSqlite(op, config, db, table, ensureTable);
        break;
      case 'upsert':
        methods[opName] = upsertSqlite(op, config, db, table, ensureTable, toRow, fromRow);
        break;
      case 'consume':
        methods[opName] = consumeSqlite(op, config, db, table, ensureTable, fromRow);
        break;
      case 'aggregate':
        methods[opName] = aggregateSqlite(op, config, db, table, ensureTable);
        break;
      case 'search':
        methods[opName] = searchSqlite(op, db, table, ensureTable, fromRow);
        break;
      case 'collection': {
        const coll = collectionSqlite(opName, op, config, db, table, ensureTable);
        if (coll.list) methods[`${opName}List`] = coll.list;
        if (coll.add) methods[`${opName}Add`] = coll.add;
        if (coll.remove) methods[`${opName}Remove`] = coll.remove;
        if (coll.update) methods[`${opName}Update`] = coll.update;
        if (coll.set) methods[`${opName}Set`] = coll.set;
        break;
      }
      case 'computedAggregate':
        methods[opName] = computedAggregateSqlite(op, config, db, table, ensureTable);
        break;
      case 'derive':
        methods[opName] = deriveSqlite(op, config, db, table, ensureTable, fromRow);
        break;
      case 'transaction':
      case 'pipe':
        break;
      case 'custom':
        if (op.sqlite) {
          methods[opName] = op.sqlite(db);
        }
        // No factory → method expected to be mixed onto the adapter externally (e.g. from a composite).
        break;
    }
  }

  return methods;
}
