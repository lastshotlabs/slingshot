/**
 * Runtime executor: `op.exists` — boolean existence / predicate check.
 *
 * Each exported function is a per-backend factory. The returned executor
 * resolves to `true` when at least one record satisfies all of the following:
 * 1. Matches all `op.fields` — field values equal the corresponding `params` values
 *    (`'param:x'` references) or literal config values.
 * 2. Passes `op.check` — additional static field equality assertions that are
 *    constant across all invocations (not param-driven).
 * 3. Passes visibility and TTL checks (memory / Redis only).
 *
 * **Short-circuit behaviour:** All backends stop at the first matching record
 * (`LIMIT 1` in SQL, `findOne` in Mongo, early-return in memory/Redis).
 *
 * **Return value:** `true` if any matching record exists, `false` otherwise.
 */
import type { ExistsOpConfig, ResolvedEntityConfig } from '@lastshotlabs/slingshot-core';
import { toSnakeCase } from '../fieldUtils';
import type { MemoryEntry, MongoModel, PgPool, RedisClient, SqliteDb } from './dbInterfaces';

// ---------------------------------------------------------------------------
// Shared
// ---------------------------------------------------------------------------

function buildMatcher(
  op: ExistsOpConfig,
): (record: Record<string, unknown>, params: Record<string, unknown>) => boolean {
  const fieldEntries = Object.entries(op.fields);
  return (record, params) => {
    for (const [field, value] of fieldEntries) {
      const target = value.startsWith('param:') ? params[value.slice(6)] : value;
      if (record[field] !== target) return false;
    }
    if (op.check) {
      for (const [f, v] of Object.entries(op.check)) {
        if (record[f] !== v) return false;
      }
    }
    return true;
  };
}

// ---------------------------------------------------------------------------
// Memory
// ---------------------------------------------------------------------------

/**
 * Create an exists executor for the in-memory store.
 *
 * Scans the store, applies TTL and visibility checks, and returns `true` on
 * the first record that satisfies all `op.fields` and `op.check` predicates.
 *
 * @param op - Exists operation config with `fields` and optional `check`.
 * @param store - The entity's in-memory store map.
 * @param isAlive - TTL check for each entry.
 * @param isVisible - Tenant visibility check.
 * @returns An async function `(params) => Promise<boolean>`.
 */
export function existsMemory(
  op: ExistsOpConfig,
  store: Map<string | number, MemoryEntry>,
  isAlive: (entry: MemoryEntry) => boolean,
  isVisible: (record: Record<string, unknown>) => boolean,
): (params: Record<string, unknown>) => Promise<boolean> {
  const matches = buildMatcher(op);
  return params => {
    for (const entry of store.values()) {
      if (!isAlive(entry) || !isVisible(entry.record)) continue;
      if (matches(entry.record, params)) return Promise.resolve(true);
    }
    return Promise.resolve(false);
  };
}

// ---------------------------------------------------------------------------
// SQLite
// ---------------------------------------------------------------------------

/**
 * Create an exists executor for the SQLite store.
 *
 * Emits `SELECT 1 FROM {table} WHERE {conditions} LIMIT 1`. Param fields are
 * bound as `?` positional values; `op.check` values are appended as static binds.
 *
 * @param op - Exists operation config.
 * @param db - Bun SQLite database handle.
 * @param table - SQL table name.
 * @param ensureTable - Idempotent table-creation function called before the query.
 * @returns An async function `(params) => Promise<boolean>`.
 */
export function existsSqlite(
  op: ExistsOpConfig,
  db: SqliteDb,
  table: string,
  ensureTable: () => void,
): (params: Record<string, unknown>) => Promise<boolean> {
  const fieldEntries = Object.entries(op.fields);
  const conditions = fieldEntries.map(([field]) => `${toSnakeCase(field)} = ?`);
  if (op.check) {
    for (const [f] of Object.entries(op.check)) {
      conditions.push(`${toSnakeCase(f)} = ?`);
    }
  }
  const where = conditions.join(' AND ');

  return params => {
    ensureTable();
    const bindValues: unknown[] = fieldEntries.map(([, v]) =>
      v.startsWith('param:') ? params[v.slice(6)] : v,
    );
    if (op.check) {
      for (const [, v] of Object.entries(op.check)) bindValues.push(v);
    }
    const row = db.query(`SELECT 1 FROM ${table} WHERE ${where} LIMIT 1`).get(...bindValues);
    return Promise.resolve(row != null);
  };
}

// ---------------------------------------------------------------------------
// Postgres
// ---------------------------------------------------------------------------

/**
 * Create an exists executor for the Postgres store.
 *
 * Emits `SELECT 1 FROM {table} WHERE {conditions} LIMIT 1` with `$N` positional
 * parameters. Returns `true` when `result.rows.length > 0`.
 *
 * @param op - Exists operation config.
 * @param pool - Postgres connection pool.
 * @param table - SQL table name.
 * @param ensureTable - Async idempotent table-creation function.
 * @returns An async function `(params) => Promise<boolean>`.
 */
export function existsPostgres(
  op: ExistsOpConfig,
  pool: PgPool,
  table: string,
  ensureTable: () => Promise<void>,
): (params: Record<string, unknown>) => Promise<boolean> {
  const fieldEntries = Object.entries(op.fields);
  let pIdx = 0;
  const conditions = fieldEntries.map(([field, value]) => {
    if (value.startsWith('param:')) return `${toSnakeCase(field)} = $${++pIdx}`;
    return `${toSnakeCase(field)} = '${value}'`;
  });
  if (op.check) {
    for (const [f] of Object.entries(op.check)) {
      conditions.push(`${toSnakeCase(f)} = $${++pIdx}`);
    }
  }
  const where = conditions.join(' AND ');
  const paramFields = fieldEntries.filter(([, v]) => v.startsWith('param:'));

  return async params => {
    await ensureTable();
    const bindValues: unknown[] = paramFields.map(([, v]) => params[v.slice(6)]);
    if (op.check) {
      for (const [, v] of Object.entries(op.check)) bindValues.push(v);
    }
    const result = await pool.query(`SELECT 1 FROM ${table} WHERE ${where} LIMIT 1`, bindValues);
    return result.rows.length > 0;
  };
}

// ---------------------------------------------------------------------------
// Mongo
// ---------------------------------------------------------------------------

/**
 * Create an exists executor for the MongoDB store.
 *
 * Builds a Mongo query from `op.fields` and `op.check`, mapping primary-key fields
 * to `_id`. Calls `Model.findOne(query).lean()` and returns `doc != null`.
 *
 * @param op - Exists operation config.
 * @param config - Resolved entity config (provides `fields` metadata for PK detection).
 * @param getModel - Lazy getter returning the Mongoose model.
 * @returns An async function `(params) => Promise<boolean>`.
 */
export function existsMongo(
  op: ExistsOpConfig,
  config: ResolvedEntityConfig,
  getModel: () => MongoModel,
): (params: Record<string, unknown>) => Promise<boolean> {
  const fieldEntries = Object.entries(op.fields);
  return async params => {
    const query: Record<string, unknown> = {};
    for (const [field, value] of fieldEntries) {
      const mongoField = config.fields[field].primary ? '_id' : field;
      query[mongoField] = value.startsWith('param:') ? params[value.slice(6)] : value;
    }
    if (op.check) {
      for (const [f, v] of Object.entries(op.check)) query[f] = v;
    }
    const doc = await getModel().findOne(query).lean();
    return doc != null;
  };
}

// ---------------------------------------------------------------------------
// Redis
// ---------------------------------------------------------------------------

/**
 * Create an exists executor for the Redis store.
 *
 * Scans all keys, deserialises each record, applies visibility check, and returns
 * `true` on the first record that passes both `op.fields` and `op.check` predicates.
 * O(n) in the number of keys.
 *
 * @param op - Exists operation config.
 * @param redis - ioredis client instance.
 * @param scanAllKeys - Returns all key strings for this entity's key space.
 * @param isVisible - Tenant visibility check.
 * @param fromRedisRecord - Deserialises a raw Redis record into the canonical shape.
 * @returns An async function `(params) => Promise<boolean>`.
 */
export function existsRedis(
  op: ExistsOpConfig,
  redis: RedisClient,
  scanAllKeys: () => Promise<string[]>,
  isVisible: (record: Record<string, unknown>) => boolean,
  fromRedisRecord: (raw: Record<string, unknown>) => Record<string, unknown>,
): (params: Record<string, unknown>) => Promise<boolean> {
  const matches = buildMatcher(op);
  return async params => {
    const allKeys = await scanAllKeys();
    for (const key of allKeys) {
      const raw = await redis.get(key);
      if (!raw) continue;
      const record = fromRedisRecord(JSON.parse(raw) as Record<string, unknown>);
      if (!isVisible(record)) continue;
      if (matches(record, params)) return true;
    }
    return false;
  };
}
