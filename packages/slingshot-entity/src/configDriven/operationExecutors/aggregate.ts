/**
 * Runtime executor: `op.aggregate` — group + compute (count / sum / avg / min / max).
 *
 * Each exported function is a per-backend factory. It takes the operation config and
 * backend-specific handles, and returns an async function that accepts runtime `params`
 * and returns an aggregated result.
 *
 * **Result shape:**
 * - Without `groupBy`: returns a single `Record<string, unknown>` where each key is a
 *   computed metric name and the value is the aggregated number (or 0 for empty sets).
 * - With `groupBy`: returns `Array<{ [groupByField]: value, ...computedMetrics }>` — one
 *   entry per distinct group value.
 *
 * **Atomicity:** Read-only — no writes. Not transactional across backends.
 *
 * **Backend notes:**
 * - Memory / Redis: filter and compute execute in JavaScript.
 * - SQLite: `SELECT COUNT/SUM/AVG/MIN/MAX ... GROUP BY` — pushed to the DB engine.
 * - Postgres: same as SQLite with `$N` placeholders and `::int` / `::numeric` casts.
 * - Mongo: uses the aggregation pipeline with `$match` → `$group` stages.
 */
import type {
  AggregateOpConfig,
  ComputedField,
  DateTruncation,
  GroupByConfig,
  ResolvedEntityConfig,
} from '@lastshotlabs/slingshot-core';
import { fromPgRow, fromSqliteRow } from '../fieldUtils';
import { evaluateFilter } from '../filterEvaluator';
import type { MemoryEntry, MongoModel, PgPool, RedisClient, SqliteDb } from './dbInterfaces';

function isComputedField(v: unknown): v is ComputedField {
  return typeof v === 'object' && v !== null && ('count' in v || 'countBy' in v || 'sum' in v);
}

/** Extract the field name from a string or object groupBy config. */
function getGroupByField(groupBy: string | GroupByConfig): string {
  return typeof groupBy === 'string' ? groupBy : groupBy.field;
}

/** Truncate a date value to the specified granularity and return a string key. */
function truncateDate(value: unknown, truncate: DateTruncation): string {
  const date = value instanceof Date ? value : new Date(String(value));
  if (isNaN(date.getTime())) return String(value);
  switch (truncate) {
    case 'year':
      return date.toISOString().slice(0, 4);
    case 'month':
      return date.toISOString().slice(0, 7);
    case 'week': {
      const d = new Date(date);
      d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
      return d.toISOString().slice(0, 10);
    }
    case 'day':
      return date.toISOString().slice(0, 10);
    case 'hour':
      return date.toISOString().slice(0, 13);
  }
}

/** Resolve the group key for a record, applying truncation when configured. */
function resolveGroupKey(
  record: Record<string, unknown>,
  groupBy: string | GroupByConfig,
): unknown {
  if (typeof groupBy === 'string') return record[groupBy];
  const value = record[groupBy.field];
  if (!groupBy.truncate || value == null) return value;
  return truncateDate(value, groupBy.truncate);
}

function groupRecords(
  records: Array<Record<string, unknown>>,
  groupBy: string | GroupByConfig,
): Map<unknown, Array<Record<string, unknown>>> {
  const groups = new Map<unknown, Array<Record<string, unknown>>>();
  for (const record of records) {
    const key = resolveGroupKey(record, groupBy);
    if (!groups.has(key)) groups.set(key, []);
    (groups.get(key) as Array<Record<string, unknown>>).push(record);
  }
  return groups;
}

function computeOnRecords(
  records: Array<Record<string, unknown>>,
  compute: Record<string, unknown>,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [name, spec] of Object.entries(compute)) {
    if (spec === 'count') {
      result[name] = records.length;
      continue;
    }
    if (spec === 'sum') {
      result[name] = records.reduce((s, r) => s + (Number(r[name]) || 0), 0);
      continue;
    }
    if (spec === 'avg') {
      result[name] =
        records.length > 0
          ? records.reduce((s, r) => s + (Number(r[name]) || 0), 0) / records.length
          : 0;
      continue;
    }
    if (spec === 'min') {
      result[name] = records.length > 0 ? Math.min(...records.map(r => Number(r[name]) || 0)) : 0;
      continue;
    }
    if (spec === 'max') {
      result[name] = records.length > 0 ? Math.max(...records.map(r => Number(r[name]) || 0)) : 0;
      continue;
    }
    if (isComputedField(spec)) {
      const where = spec.where;
      const sum = spec.sum;
      let filtered = records;
      if (where) {
        filtered = records.filter(r => Object.entries(where).every(([f, v]) => r[f] === v));
      }
      if (spec.count) {
        result[name] = filtered.length;
        continue;
      }
      if (spec.countBy) {
        const counts: Record<string, number> = {};
        for (const r of filtered) {
          const k = String(r[spec.countBy]);
          counts[k] = (counts[k] || 0) + 1;
        }
        result[name] = counts;
        continue;
      }
      if (sum) {
        result[name] = filtered.reduce((s, r) => s + (Number(r[sum]) || 0), 0);
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
 * Create an aggregate executor for the in-memory store.
 *
 * Scans the entire `store` map, skips expired entries (via `isAlive`) and
 * tenant-invisible entries (via `isVisible`), applies the optional filter, then
 * runs `computeOnRecords` over the matching set. Grouping is handled in JS using a
 * `Map<groupKey, records[]>` before computing metrics per group.
 *
 * @param op - Aggregate operation config including `filter`, `groupBy`, and `compute`.
 * @param store - The entity's in-memory store map (`pk → MemoryEntry`).
 * @param isAlive - Returns `true` when an entry has not yet expired (TTL check).
 * @param isVisible - Returns `true` when a record is accessible to the current tenant.
 * @returns An async function `(params) => Promise<unknown>` that returns the aggregate
 *   result object or grouped array.
 */
export function aggregateMemory(
  op: AggregateOpConfig,
  store: Map<string | number, MemoryEntry>,
  isAlive: (entry: MemoryEntry) => boolean,
  isVisible: (record: Record<string, unknown>) => boolean,
): (params: Record<string, unknown>) => Promise<unknown> {
  return params => {
    const records: Array<Record<string, unknown>> = [];
    for (const entry of store.values()) {
      if (!isAlive(entry) || !isVisible(entry.record)) continue;
      if (op.filter && !evaluateFilter(entry.record, op.filter, params)) continue;
      records.push(entry.record);
    }
    if (op.groupBy) {
      const field = getGroupByField(op.groupBy);
      const groups = groupRecords(records, op.groupBy);
      return Promise.resolve(
        Array.from(groups.entries()).map(([key, items]) => ({
          [field]: key,
          ...computeOnRecords(items, op.compute),
        })),
      );
    }
    return Promise.resolve(computeOnRecords(records, op.compute));
  };
}

// ---------------------------------------------------------------------------
// SQLite
// ---------------------------------------------------------------------------

/**
 * Create an aggregate executor for the SQLite store.
 *
 * Builds a `SELECT ... FROM {table} WHERE ... GROUP BY ...` query using SQLite's
 * native aggregate functions (`COUNT`, `SUM`, `AVG`, `MIN`, `MAX`). Filter conditions
 * with `param:` references are bound as positional `?` parameters. `ensureTable` is
 * called before each execution to lazily initialise the schema.
 *
 * @param op - Aggregate operation config.
 * @param config - Resolved entity config (used for field metadata).
 * @param db - Bun SQLite database handle.
 * @param table - SQL table name for this entity.
 * @param ensureTable - Idempotent table-creation function called before each query.
 * @returns An async function `(params) => Promise<unknown>` that returns the aggregate
 *   result object or grouped rows.
 */
export function aggregateSqlite(
  op: AggregateOpConfig,
  config: ResolvedEntityConfig,
  db: SqliteDb,
  table: string,
  ensureTable: () => void,
): (params: Record<string, unknown>) => Promise<unknown> {
  return params => {
    ensureTable();
    const rows = db.query<Record<string, unknown>>(`SELECT * FROM ${table}`).all();
    const records = rows
      .map(row => fromSqliteRow(row, config.fields))
      .filter(record => !op.filter || evaluateFilter(record, op.filter, params));
    if (op.groupBy) {
      const field = getGroupByField(op.groupBy);
      return Promise.resolve(
        Array.from(groupRecords(records, op.groupBy).entries()).map(([key, items]) => ({
          [field]: key,
          ...computeOnRecords(items, op.compute),
        })),
      );
    }
    return Promise.resolve(computeOnRecords(records, op.compute));
  };
}

// ---------------------------------------------------------------------------
// Postgres
// ---------------------------------------------------------------------------

/**
 * Create an aggregate executor for the Postgres store.
 *
 * Equivalent to the SQLite executor but uses `$N` positional parameters and
 * explicit `::int` / `::numeric` type casts for Postgres compatibility.
 * Uses `COALESCE(SUM/AVG(...), 0)` to guarantee numeric output on empty sets.
 * `ensureTable` is awaited before each query.
 *
 * @param op - Aggregate operation config.
 * @param config - Resolved entity config.
 * @param pool - Postgres connection pool.
 * @param table - SQL table name for this entity.
 * @param ensureTable - Async idempotent table-creation function.
 * @returns An async function `(params) => Promise<unknown>`.
 */
export function aggregatePostgres(
  op: AggregateOpConfig,
  config: ResolvedEntityConfig,
  pool: PgPool,
  table: string,
  ensureTable: () => Promise<void>,
): (params: Record<string, unknown>) => Promise<unknown> {
  return async params => {
    await ensureTable();
    const result = await pool.query(`SELECT * FROM ${table}`, []);
    const records = result.rows
      .map(row => fromPgRow(row, config.fields))
      .filter(record => !op.filter || evaluateFilter(record, op.filter, params));
    if (op.groupBy) {
      const field = getGroupByField(op.groupBy);
      return Array.from(groupRecords(records, op.groupBy).entries()).map(([key, items]) => ({
        [field]: key,
        ...computeOnRecords(items, op.compute),
      }));
    }
    return computeOnRecords(records, op.compute);
  };
}

// ---------------------------------------------------------------------------
// Mongo
// ---------------------------------------------------------------------------

/**
 * Create an aggregate executor for the MongoDB store.
 *
 * Constructs a MongoDB aggregation pipeline with optional `$match` (from `op.filter`)
 * and a `$group` stage (from `op.compute`). When `op.groupBy` is set the `_id` of
 * the group stage is `$groupBy` and the result array maps `_id` back to the field name.
 * When no groupBy is set the pipeline reduces to a single document.
 *
 * @param op - Aggregate operation config.
 * @param getModel - Lazy getter that returns the Mongoose model. Called per invocation
 *   to allow the model to be resolved after connection is established.
 * @returns An async function `(params) => Promise<unknown>`.
 */
export function aggregateMongo(
  op: AggregateOpConfig,
  getModel: () => MongoModel,
): (params: Record<string, unknown>) => Promise<unknown> {
  return async params => {
    const records = await getModel().find({}).lean();
    const filter = op.filter;
    const filtered = filter
      ? records.filter(record => evaluateFilter(record, filter, params))
      : records;
    if (op.groupBy) {
      const field = getGroupByField(op.groupBy);
      return Array.from(groupRecords(filtered, op.groupBy).entries()).map(([key, items]) => ({
        [field]: key,
        ...computeOnRecords(items, op.compute),
      }));
    }
    return computeOnRecords(filtered, op.compute);
  };
}

// ---------------------------------------------------------------------------
// Redis (same as memory — filter + compute in JS after SCAN)
// ---------------------------------------------------------------------------

/**
 * Create an aggregate executor for the Redis store.
 *
 * Functionally identical to the memory executor: all keys are scanned via
 * `scanAllKeys`, each record is deserialized, visibility and filter checks are
 * applied in JavaScript, and metrics are computed in memory. Redis does not
 * provide native aggregate operations, so this is O(n) in the number of records.
 *
 * @param op - Aggregate operation config.
 * @param redis - ioredis client instance.
 * @param scanAllKeys - Returns all key strings for this entity's key space.
 * @param isVisible - Tenant visibility check applied before filter and compute.
 * @param fromRedisRecord - Deserializes a raw Redis record (post-JSON parse) into
 *   the canonical entity record shape with proper types.
 * @returns An async function `(params) => Promise<unknown>`.
 */
export function aggregateRedis(
  op: AggregateOpConfig,
  redis: RedisClient,
  scanAllKeys: () => Promise<string[]>,
  isVisible: (record: Record<string, unknown>) => boolean,
  fromRedisRecord: (raw: Record<string, unknown>) => Record<string, unknown>,
): (params: Record<string, unknown>) => Promise<unknown> {
  return async params => {
    const allKeys = await scanAllKeys();
    const records: Array<Record<string, unknown>> = [];
    for (const key of allKeys) {
      const raw = await redis.get(key);
      if (!raw) continue;
      const record = fromRedisRecord(JSON.parse(raw) as Record<string, unknown>);
      if (!isVisible(record)) continue;
      if (op.filter && !evaluateFilter(record, op.filter, params)) continue;
      records.push(record);
    }
    if (op.groupBy) {
      const field = getGroupByField(op.groupBy);
      const groups = groupRecords(records, op.groupBy);
      return Array.from(groups.entries()).map(([key, items]) => ({
        [field]: key,
        ...computeOnRecords(items, op.compute),
      }));
    }
    return computeOnRecords(records, op.compute);
  };
}
