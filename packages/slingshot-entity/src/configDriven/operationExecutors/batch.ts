/**
 * Runtime executor: `op.batch` — multi-record update or delete by filter.
 *
 * Each exported function is a per-backend factory. It takes the operation config and
 * backend-specific handles, and returns an async function that accepts runtime `params`
 * and returns the count of affected records.
 *
 * **Semantics:**
 * - `op.action === 'delete'`: deletes all records matching `op.filter`.
 * - `op.action === 'update'` (default): applies `op.set` field values to all
 *   matching records. Field values support `param:` references and the `'now'`
 *   sentinel (resolved to the current `Date`).
 *
 * **Atomicity:**
 * - Memory: sequential in-place mutation — single-threaded, effectively atomic.
 * - SQLite: single `DELETE`/`UPDATE ... WHERE` statement — atomic within the
 *   SQLite WAL transaction model.
 * - Postgres: single `DELETE`/`UPDATE ... WHERE` statement — atomic within
 *   Postgres MVCC.
 * - Mongo: `deleteMany` / `updateMany` — atomic per document, not across documents.
 * - Redis: iterative key-by-key — not atomic; partial updates are possible on error.
 *
 * **Return value:** The number of records affected (deleted or updated).
 */
import type { BatchOpConfig, ResolvedEntityConfig } from '@lastshotlabs/slingshot-core';
import { toSnakeCase } from '../fieldUtils';
import { evaluateFilter } from '../filterEvaluator';
import type { MemoryEntry, MongoModel, PgPool, RedisClient, SqliteDb } from './dbInterfaces';

function resolveSetValue(v: string | number | boolean, params: Record<string, unknown>): unknown {
  if (v === 'now') return new Date();
  if (typeof v === 'string' && v.startsWith('param:')) return params[v.slice(6)];
  return v;
}

// ---------------------------------------------------------------------------
// Memory
// ---------------------------------------------------------------------------

/**
 * Create a batch executor for the in-memory store.
 *
 * Iterates the store, applies TTL and visibility checks, then either deletes
 * matching entries from the map or mutates their `record` fields in-place.
 *
 * @param op - Batch operation config with `action`, `filter`, and optional `set`.
 * @param store - The entity's in-memory store map.
 * @param isAlive - Returns `true` when an entry has not yet expired.
 * @param isVisible - Returns `true` when a record is accessible to the current tenant.
 * @returns An async function `(params) => Promise<number>` returning the affected count.
 */
export function batchMemory(
  op: BatchOpConfig,
  store: Map<string | number, MemoryEntry>,
  isAlive: (entry: MemoryEntry) => boolean,
  isVisible: (record: Record<string, unknown>) => boolean,
): (params: Record<string, unknown>) => Promise<number> {
  return params => {
    let count = 0;
    if (op.action === 'delete') {
      for (const [pk, entry] of store) {
        if (!isAlive(entry) || !isVisible(entry.record)) continue;
        if (evaluateFilter(entry.record, op.filter, params)) {
          store.delete(pk);
          count++;
        }
      }
    } else {
      for (const entry of store.values()) {
        if (!isAlive(entry) || !isVisible(entry.record)) continue;
        if (!evaluateFilter(entry.record, op.filter, params)) continue;
        if (op.set) {
          for (const [f, v] of Object.entries(op.set)) {
            entry.record[f] = resolveSetValue(v, params);
          }
        }
        count++;
      }
    }
    return Promise.resolve(count);
  };
}

// ---------------------------------------------------------------------------
// SQLite
// ---------------------------------------------------------------------------

/**
 * Create a batch executor for the SQLite store.
 *
 * Emits a single `DELETE FROM ... WHERE` or `UPDATE ... SET ... WHERE` statement.
 * Filter conditions are bound as `?` positional parameters; `set` values are
 * prepended to the bind list before filter values. Returns `db.run().changes`.
 *
 * @param op - Batch operation config.
 * @param config - Resolved entity config (unused directly; reserved for future use).
 * @param db - Bun SQLite database handle.
 * @param table - SQL table name for this entity.
 * @param ensureTable - Idempotent table-creation function called before each statement.
 * @returns An async function `(params) => Promise<number>` returning the affected row count.
 */
export function batchSqlite(
  op: BatchOpConfig,
  config: ResolvedEntityConfig,
  db: SqliteDb,
  table: string,
  ensureTable: () => void,
): (params: Record<string, unknown>) => Promise<number> {
  return params => {
    ensureTable();
    const conditions: string[] = [];
    const bindValues: unknown[] = [];
    for (const [key, value] of Object.entries(op.filter)) {
      if (key === '$and' || key === '$or') continue;
      const col = toSnakeCase(key);
      if (typeof value === 'string' && value.startsWith('param:')) {
        conditions.push(`${col} = ?`);
        bindValues.push(params[value.slice(6)]);
      } else if (typeof value === 'object' && value !== null && '$ne' in value) {
        conditions.push(`${col} != ?`);
        bindValues.push((value as { $ne: unknown }).$ne);
      } else {
        conditions.push(`${col} = ?`);
        bindValues.push(value);
      }
    }
    const where = conditions.length > 0 ? conditions.join(' AND ') : '1=1';

    if (op.action === 'delete') {
      return Promise.resolve(db.run(`DELETE FROM ${table} WHERE ${where}`, bindValues).changes);
    }

    const setClauses: string[] = [];
    const setValues: unknown[] = [];
    if (op.set) {
      for (const [f, v] of Object.entries(op.set)) {
        setClauses.push(`${toSnakeCase(f)} = ?`);
        setValues.push(resolveSetValue(v, params));
      }
    }
    return Promise.resolve(
      db.run(`UPDATE ${table} SET ${setClauses.join(', ')} WHERE ${where}`, [
        ...setValues,
        ...bindValues,
      ]).changes,
    );
  };
}

// ---------------------------------------------------------------------------
// Postgres
// ---------------------------------------------------------------------------

/**
 * Create a batch executor for the Postgres store.
 *
 * Equivalent to the SQLite executor but uses `$N` positional parameters.
 * Returns `result.rowCount ?? 0`.
 *
 * @param op - Batch operation config.
 * @param config - Resolved entity config (reserved for future use).
 * @param pool - Postgres connection pool.
 * @param table - SQL table name.
 * @param ensureTable - Async idempotent table-creation function.
 * @returns An async function `(params) => Promise<number>` returning the affected row count.
 */
export function batchPostgres(
  op: BatchOpConfig,
  config: ResolvedEntityConfig,
  pool: PgPool,
  table: string,
  ensureTable: () => Promise<void>,
): (params: Record<string, unknown>) => Promise<number> {
  return async params => {
    await ensureTable();
    const conditions: string[] = [];
    const bindValues: unknown[] = [];
    let pIdx = 0;
    for (const [key, value] of Object.entries(op.filter)) {
      if (key === '$and' || key === '$or') continue;
      const col = toSnakeCase(key);
      if (typeof value === 'string' && value.startsWith('param:')) {
        conditions.push(`${col} = $${++pIdx}`);
        bindValues.push(params[value.slice(6)]);
      } else if (typeof value === 'object' && value !== null && '$ne' in value) {
        conditions.push(`${col} != $${++pIdx}`);
        bindValues.push((value as { $ne: unknown }).$ne);
      } else {
        conditions.push(`${col} = $${++pIdx}`);
        bindValues.push(value);
      }
    }
    const where = conditions.length > 0 ? conditions.join(' AND ') : 'TRUE';

    if (op.action === 'delete') {
      const result = await pool.query(`DELETE FROM ${table} WHERE ${where}`, bindValues);
      return result.rowCount ?? 0;
    }

    if (op.set) {
      for (const [f, v] of Object.entries(op.set)) {
        conditions.push(`${toSnakeCase(f)} = $${++pIdx}`);
        bindValues.push(resolveSetValue(v, params));
      }
    }
    const result = await pool.query(
      `UPDATE ${table} SET ${conditions.slice(-Object.keys(op.set ?? {}).length).join(', ')} WHERE ${where}`,
      bindValues,
    );
    return result.rowCount ?? 0;
  };
}

// ---------------------------------------------------------------------------
// Mongo
// ---------------------------------------------------------------------------

/**
 * Create a batch executor for the MongoDB store.
 *
 * Calls `Model.deleteMany(query)` or `Model.updateMany(query, { $set })`.
 * Returns `deletedCount` or `modifiedCount` from the Mongoose result.
 *
 * @param op - Batch operation config.
 * @param getModel - Lazy getter returning the Mongoose model.
 * @returns An async function `(params) => Promise<number>` returning the affected document count.
 */
export function batchMongo(
  op: BatchOpConfig,
  getModel: () => MongoModel,
): (params: Record<string, unknown>) => Promise<number> {
  return async params => {
    const query: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(op.filter)) {
      if (key === '$and' || key === '$or') continue;
      if (typeof value === 'string' && value.startsWith('param:'))
        query[key] = params[value.slice(6)];
      else if (typeof value === 'object' && value !== null && '$ne' in value)
        query[key] = { $ne: (value as { $ne: unknown }).$ne };
      else query[key] = value;
    }
    const Model = getModel();
    if (op.action === 'delete') {
      return (await Model.deleteMany(query)).deletedCount;
    }
    const $set: Record<string, unknown> = {};
    if (op.set) {
      for (const [f, v] of Object.entries(op.set)) $set[f] = resolveSetValue(v, params);
    }
    return (await Model.updateMany(query, { $set })).modifiedCount;
  };
}

// ---------------------------------------------------------------------------
// Redis
// ---------------------------------------------------------------------------

/**
 * Create a batch executor for the Redis store.
 *
 * Scans all keys, deserializes each record, applies visibility and filter checks,
 * then either calls `redis.del(key)` or mutates and re-serializes the record via
 * `storeRecord`. Iterative — not atomic across keys.
 *
 * @param op - Batch operation config.
 * @param redis - ioredis client instance.
 * @param scanAllKeys - Returns all key strings for this entity's key space.
 * @param isVisible - Tenant visibility check.
 * @param fromRedisRecord - Deserializes a raw Redis record into the canonical shape.
 * @param storeRecord - Serializes and writes an updated record back to Redis.
 * @returns An async function `(params) => Promise<number>` returning the affected count.
 */
export function batchRedis(
  op: BatchOpConfig,
  redis: RedisClient,
  scanAllKeys: () => Promise<string[]>,
  isVisible: (record: Record<string, unknown>) => boolean,
  fromRedisRecord: (raw: Record<string, unknown>) => Record<string, unknown>,
  storeRecord: (record: Record<string, unknown>) => Promise<void>,
): (params: Record<string, unknown>) => Promise<number> {
  return async params => {
    const allKeys = await scanAllKeys();
    let count = 0;
    for (const key of allKeys) {
      const raw = await redis.get(key);
      if (!raw) continue;
      const record = fromRedisRecord(JSON.parse(raw) as Record<string, unknown>);
      if (!isVisible(record)) continue;
      if (!evaluateFilter(record, op.filter, params)) continue;
      if (op.action === 'delete') {
        await redis.del(key);
      } else if (op.set) {
        for (const [f, v] of Object.entries(op.set)) record[f] = resolveSetValue(v, params);
        await storeRecord(record);
      }
      count++;
    }
    return count;
  };
}
