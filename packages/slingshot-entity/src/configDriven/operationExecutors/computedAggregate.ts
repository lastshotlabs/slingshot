/**
 * Runtime executor: `op.computedAggregate` — aggregate source records and
 * materialize the result into a field on a target record.
 *
 * **How it works:**
 * 1. Filter all records in the entity's store using `op.sourceFilter` + runtime `params`.
 * 2. Compute each field in `op.compute` over the filtered set (currently: `'count'` and
 *    conditional `{ count: true, where: {...} }`).
 * 3. Find the target record using `op.targetMatch` (field equality conditions, optionally
 *    resolved from `param:*` references).
 * 4. Write the computed object to `op.materializeTo` on the target record.
 *
 * **Atomicity per backend:**
 * - Memory: synchronous scan + write — atomic by virtue of Node/Bun's single-threaded event loop.
 * - SQLite: synchronous scan + `UPDATE` — same single-thread guarantee.
 * - Postgres: two separate queries (SELECT + UPDATE). When `op.atomic` is true and
 *   the backend can check out a client, the executor wraps them in a real transaction;
 *   otherwise the flow remains non-transactional.
 * - Mongo: aggregation pipeline + `updateOne` — two separate operations.
 * - Redis: SCAN + JS compute + `storeRecord` — three separate operations.
 *
 * **Adding a new compute spec:**
 * Extend `computeResult()` with additional cases matching your `ComputeSpec` shape.
 */
import type { ComputedAggregateOpConfig, ResolvedEntityConfig } from '@lastshotlabs/slingshot-core';
import { fromMongoDoc, fromPgRow, fromSqliteRow, toSnakeCase } from '../fieldUtils';
import { evaluateFilter } from '../filterEvaluator';
import type {
  MemoryEntry,
  MongoModel,
  PgPool,
  PgQueryable,
  RedisClient,
  SqliteDb,
} from './dbInterfaces';
import { withOptionalPostgresTransaction } from './postgresTransaction';

/**
 * Evaluate each compute spec against a pre-filtered set of source records.
 *
 * Supported compute specs:
 * - `'count'` — count of all records in the filtered set.
 * - `{ count: true }` — same as `'count'`.
 * - `{ count: true, where: { field: value, ... } }` — count of records matching the `where` conditions.
 *
 * Unknown or unrecognized specs produce `0` as a safe default.
 *
 * @param records - Pre-filtered source records to aggregate over.
 * @param compute - Map of output field name → compute spec (from `op.computedAggregate`).
 * @returns A plain object mapping each output field name to its computed value.
 */
function computeResult(
  records: Array<Record<string, unknown>>,
  compute: Record<string, unknown>,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [name, spec] of Object.entries(compute)) {
    if (spec === 'count') {
      result[name] = records.length;
      continue;
    }
    if (typeof spec === 'object' && spec !== null) {
      const s = spec as {
        count?: boolean;
        countBy?: string;
        sum?: string;
        where?: Record<string, unknown>;
      };
      const where = s.where;
      const sum = s.sum;
      const filtered = where
        ? records.filter(r => Object.entries(where).every(([f, v]) => r[f] === v))
        : records;
      if (s.count) {
        result[name] = filtered.length;
        continue;
      }
      if (s.countBy) {
        const counts: Record<string, number> = {};
        for (const record of filtered) {
          const key = String(record[s.countBy]);
          counts[key] = (counts[key] || 0) + 1;
        }
        result[name] = counts;
        continue;
      }
      if (sum) {
        result[name] = filtered.reduce((acc, record) => acc + (Number(record[sum]) || 0), 0);
        continue;
      }
    }
    result[name] = 0;
  }
  return result;
}

// ---------------------------------------------------------------------------
// Memory
// ---------------------------------------------------------------------------

/**
 * In-memory `computedAggregate` executor.
 *
 * Scans the entire in-memory store synchronously, evaluates `op.sourceFilter`,
 * computes the aggregate via `computeResult`, resolves `op.targetMatch` against
 * runtime `params`, finds the target entry, and writes the result to `op.materializeTo`.
 *
 * Atomic by virtue of the single-threaded JavaScript event loop — no entry can be
 * modified between the scan and the write within the same synchronous execution frame.
 *
 * @param op       - The `computedAggregate` operation config.
 * @param store    - The shared in-memory entity store.
 * @param isAlive  - Predicate: `true` when the entry has not expired.
 * @param isVisible - Predicate: `true` when the record is not soft-deleted.
 * @returns An async function `(params) => Promise<void>`.
 */
export function computedAggregateMemory(
  op: ComputedAggregateOpConfig,
  store: Map<string | number, MemoryEntry>,
  isAlive: (entry: MemoryEntry) => boolean,
  isVisible: (record: Record<string, unknown>) => boolean,
): (params: Record<string, unknown>) => Promise<void> {
  return params => {
    const sourceRecords: Array<Record<string, unknown>> = [];
    for (const entry of store.values()) {
      if (!isAlive(entry) || !isVisible(entry.record)) continue;
      if (evaluateFilter(entry.record, op.sourceFilter, params)) {
        sourceRecords.push(entry.record);
      }
    }
    const computed = computeResult(sourceRecords, op.compute);
    const targetResolved: Record<string, unknown> = {};
    for (const [field, value] of Object.entries(op.targetMatch)) {
      targetResolved[field] =
        typeof value === 'string' && value.startsWith('param:') ? params[value.slice(6)] : value;
    }
    for (const entry of store.values()) {
      if (!isAlive(entry) || !isVisible(entry.record)) continue;
      let matches = true;
      for (const [field, target] of Object.entries(targetResolved)) {
        if (entry.record[field] !== target) {
          matches = false;
          break;
        }
      }
      if (matches) {
        entry.record[op.materializeTo] = computed;
        break;
      }
    }
    return Promise.resolve();
  };
}

// ---------------------------------------------------------------------------
// SQLite
// ---------------------------------------------------------------------------

/**
 * SQLite `computedAggregate` executor.
 *
 * Reads all rows from the table, filters in JavaScript using `evaluateFilter`,
 * computes the aggregate via `computeResult`, then writes the result as a JSON
 * string into the `op.materializeTo` column of the matched target row.
 *
 * Note: The full-table scan is intentional — using SQL aggregate functions would
 * require knowing the source table at query-build time, which is not available when
 * source and target share the same table. For large tables, consider a custom `op`.
 *
 * @param op          - The `computedAggregate` operation config.
 * @param config      - Resolved entity config (currently unused but retained for consistency).
 * @param db          - The `SqliteDb` handle.
 * @param table       - The SQL table name.
 * @param ensureTable - Lazy table-creation callback.
 * @returns An async function `(params) => Promise<void>`.
 */
export function computedAggregateSqlite(
  op: ComputedAggregateOpConfig,
  config: ResolvedEntityConfig,
  db: SqliteDb,
  table: string,
  ensureTable: () => void,
): (params: Record<string, unknown>) => Promise<void> {
  return params => {
    ensureTable();
    // Read all matching source records and compute in JS
    // (SQL aggregate would be more efficient but requires knowing the source table)
    const rows = db.query<Record<string, unknown>>(`SELECT * FROM ${table}`).all();
    const sourceRecords = rows
      .map(row => fromSqliteRow(row, config.fields))
      .filter(r => evaluateFilter(r, op.sourceFilter, params));
    const computed = computeResult(sourceRecords, op.compute);

    // Resolve target match
    const conditions: string[] = [];
    const values: unknown[] = [JSON.stringify(computed)];
    for (const [field, value] of Object.entries(op.targetMatch)) {
      conditions.push(`${toSnakeCase(field)} = ?`);
      values.push(
        typeof value === 'string' && value.startsWith('param:') ? params[value.slice(6)] : value,
      );
    }

    db.run(
      `UPDATE ${table} SET ${toSnakeCase(op.materializeTo)} = ? WHERE ${conditions.join(' AND ')}`,
      values,
    );
    return Promise.resolve();
  };
}

// ---------------------------------------------------------------------------
// Postgres
// ---------------------------------------------------------------------------

/**
 * Postgres `computedAggregate` executor.
 *
 * Fetches all rows with `SELECT *`, filters in JavaScript using `evaluateFilter`,
 * computes the aggregate via `computeResult`, then writes the result as a JSON
 * string to the `op.materializeTo` column of the matched target row.
 *
 * The SELECT and UPDATE are issued as two separate queries. When `op.atomic` is
 * true and the backend can check out a dedicated client, the executor wraps the
 * flow in `BEGIN` / `COMMIT` / `ROLLBACK`; otherwise it executes directly against
 * the pool without an explicit transaction.
 *
 * @param op          - The `computedAggregate` operation config.
 * @param config      - Resolved entity config (currently unused but retained for consistency).
 * @param pool        - The `PgPool` connection pool.
 * @param table       - The Postgres table name (snake_case).
 * @param ensureTable - Async lazy table-creation callback.
 * @returns An async function `(params) => Promise<void>`.
 */
export function computedAggregatePostgres(
  op: ComputedAggregateOpConfig,
  config: ResolvedEntityConfig,
  pool: PgPool,
  table: string,
  ensureTable: () => Promise<void>,
): (params: Record<string, unknown>) => Promise<void> {
  return async params => {
    await ensureTable();
    const run = async (queryable: PgQueryable): Promise<void> => {
      const result = await queryable.query(`SELECT * FROM ${table}`, []);
      const sourceRecords = result.rows
        .map(row => fromPgRow(row, config.fields))
        .filter(r => evaluateFilter(r, op.sourceFilter, params));
      const computed = computeResult(sourceRecords, op.compute);

      const conditions: string[] = [];
      const values: unknown[] = [JSON.stringify(computed)];
      let pIdx = 1;
      for (const [field, value] of Object.entries(op.targetMatch)) {
        conditions.push(`${toSnakeCase(field)} = $${++pIdx}`);
        values.push(
          typeof value === 'string' && value.startsWith('param:') ? params[value.slice(6)] : value,
        );
      }

      await queryable.query(
        `UPDATE ${table} SET ${toSnakeCase(op.materializeTo)} = $1 WHERE ${conditions.join(' AND ')}`,
        values,
      );
    };

    if (op.atomic) {
      await withOptionalPostgresTransaction(pool, run);
      return;
    }

    await run(pool);
  };
}

// ---------------------------------------------------------------------------
// Mongo
// ---------------------------------------------------------------------------

/**
 * MongoDB `computedAggregate` executor.
 *
 * Builds a MongoDB aggregation pipeline from `op.sourceFilter` and `op.compute`,
 * runs it via `Model.aggregate()`, then writes the computed document to the
 * `op.materializeTo` field of the target record via `Model.updateOne()`.
 *
 * Compute specs are translated to `$sum` pipeline expressions:
 * - `'count'` → `{ $sum: 1 }`
 * - `{ count: true }` → `{ $sum: 1 }`
 * - Unknown → `{ $sum: 0 }`
 *
 * The aggregation pipeline and the updateOne are two separate operations — not
 * wrapped in a MongoDB session or transaction. For strict atomicity, use a
 * MongoDB multi-document transaction at the application level.
 *
 * @param op       - The `computedAggregate` operation config.
 * @param config   - Resolved entity config; used to detect primary-key fields in `targetMatch`.
 * @param getModel - Lazy factory returning the Mongoose model after schema registration.
 * @returns An async function `(params) => Promise<void>`.
 */
export function computedAggregateMongo(
  op: ComputedAggregateOpConfig,
  config: ResolvedEntityConfig,
  getModel: () => MongoModel,
): (params: Record<string, unknown>) => Promise<void> {
  return async params => {
    const Model = getModel();
    const sourceRecords = (await Model.find({}).lean()).map(doc => fromMongoDoc(doc, config));
    const filtered = sourceRecords.filter(record =>
      evaluateFilter(record, op.sourceFilter, params),
    );
    const computed = computeResult(filtered, op.compute);

    // Write to target
    const targetQuery: Record<string, unknown> = {};
    for (const [field, value] of Object.entries(op.targetMatch)) {
      targetQuery[config.fields[field].primary ? config._storageFields.mongoPkField : field] =
        typeof value === 'string' && value.startsWith('param:') ? params[value.slice(6)] : value;
    }
    await Model.updateOne(targetQuery, { $set: { [op.materializeTo]: computed } });
  };
}

// ---------------------------------------------------------------------------
// Redis
// ---------------------------------------------------------------------------

/**
 * Redis `computedAggregate` executor.
 *
 * Scans all entity keys via `scanAllKeys()`, fetches each with `GET`, deserializes
 * the JSON value, applies `op.sourceFilter` in JavaScript, and computes the aggregate
 * via `computeResult`. Then scans the keys again to find the target record matching
 * `op.targetMatch`, writes the computed object to `op.materializeTo` on the record,
 * and persists it back via `storeRecord`.
 *
 * **Performance note:** Two full key scans per invocation. This is acceptable for
 * small entity sets stored in Redis. For large sets, prefer a SQL or Mongo backend
 * for `computedAggregate` operations.
 *
 * The two scan + write operations are not atomic. If Redis is used in a multi-instance
 * deployment, a concurrent write between the read and the write is possible.
 *
 * @param op             - The `computedAggregate` operation config.
 * @param config         - Resolved entity config (currently unused, retained for consistency).
 * @param redis          - The `RedisClient` handle.
 * @param scanAllKeys    - Async helper that returns all entity keys via SCAN.
 * @param isVisible      - Predicate: `true` when the record is not soft-deleted.
 * @param fromRedisRecord - Deserialize a raw Redis hash into a domain-typed record.
 * @param storeRecord    - Async helper that serializes and writes a record back to Redis.
 * @returns An async function `(params) => Promise<void>`.
 */
export function computedAggregateRedis(
  op: ComputedAggregateOpConfig,
  config: ResolvedEntityConfig,
  redis: RedisClient,
  scanAllKeys: () => Promise<string[]>,
  isVisible: (record: Record<string, unknown>) => boolean,
  fromRedisRecord: (raw: Record<string, unknown>) => Record<string, unknown>,
  storeRecord: (record: Record<string, unknown>) => Promise<void>,
): (params: Record<string, unknown>) => Promise<void> {
  return async params => {
    const allKeys = await scanAllKeys();
    const sourceRecords: Array<Record<string, unknown>> = [];
    for (const key of allKeys) {
      const raw = await redis.get(key);
      if (!raw) continue;
      const record = fromRedisRecord(JSON.parse(raw) as Record<string, unknown>);
      if (!isVisible(record)) continue;
      if (evaluateFilter(record, op.sourceFilter, params)) sourceRecords.push(record);
    }
    const computed = computeResult(sourceRecords, op.compute);

    // Find and update target
    const targetResolved: Record<string, unknown> = {};
    for (const [field, value] of Object.entries(op.targetMatch)) {
      targetResolved[field] =
        typeof value === 'string' && value.startsWith('param:') ? params[value.slice(6)] : value;
    }
    for (const key of allKeys) {
      const raw = await redis.get(key);
      if (!raw) continue;
      const record = fromRedisRecord(JSON.parse(raw) as Record<string, unknown>);
      if (!isVisible(record)) continue;
      let matches = true;
      for (const [f, t] of Object.entries(targetResolved)) {
        if (record[f] !== t) {
          matches = false;
          break;
        }
      }
      if (matches) {
        record[op.materializeTo] = computed;
        await storeRecord(record);
        break;
      }
    }
  };
}
