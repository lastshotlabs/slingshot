/**
 * Runtime executor: `op.fieldUpdate` — targeted partial write on a matched entity record.
 *
 * Each exported function is a per-backend factory. The returned executor accepts
 * two arguments: `params` (for matching) and `input` (the new field values), and
 * returns the full updated record.
 *
 * **Match semantics:** `op.match` is a `Record<string, string>` mapping field names
 * to either `'param:x'` (resolved from `params`) or literal string values. All match
 * conditions must hold for a record to be targeted.
 *
 * **Set semantics:** `op.set` is an array of field names. Only fields present in both
 * `op.set` and `input` (i.e., `input[f] !== undefined`) are written.
 *
 * **Error behaviour:** All backends throw `Error('[EntityName] Record not found')` when
 * no record satisfies the match conditions.
 *
 * **Atomicity:**
 * - Memory: in-place mutation — single-threaded, effectively atomic.
 * - SQLite: `UPDATE ... WHERE` followed by `SELECT` (two statements, not wrapped in
 *   an explicit transaction).
 * - Postgres: `UPDATE ... WHERE ... RETURNING *` — single atomic statement.
 * - Mongo: `updateOne + findOne` — not atomic; a concurrent delete could cause the
 *   follow-up `findOne` to return `null`, triggering the "Record not found" error.
 * - Redis: read-modify-write — not atomic across keys.
 */
import type { FieldUpdateOpConfig, ResolvedEntityConfig } from '@lastshotlabs/slingshot-core';
import { toSnakeCase } from '../fieldUtils';
import type { MemoryEntry, MongoModel, PgPool, RedisClient, SqliteDb } from './dbInterfaces';

function resolveParams(
  match: Record<string, string>,
  params: Record<string, unknown>,
): Record<string, unknown> {
  const resolved: Record<string, unknown> = {};
  for (const [field, value] of Object.entries(match)) {
    resolved[field] = value.startsWith('param:') ? params[value.slice(6)] : value;
  }
  return resolved;
}

function recordMatches(
  record: Record<string, unknown>,
  resolved: Record<string, unknown>,
): boolean {
  for (const [field, target] of Object.entries(resolved)) {
    if (record[field] !== target) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Memory
// ---------------------------------------------------------------------------

/**
 * Create a fieldUpdate executor for the in-memory store.
 *
 * Scans the store, applies TTL and visibility checks, matches on `op.match`, then
 * mutates `op.set` fields in-place on the first matching entry.
 *
 * @param op - FieldUpdate operation config with `match` and `set`.
 * @param config - Resolved entity config (used for error messages).
 * @param store - The entity's in-memory store map.
 * @param isAlive - TTL check for each entry.
 * @param isVisible - Tenant visibility check.
 * @returns An async function `(params, input) => Promise<Record<string, unknown>>`
 *   returning the full updated record.
 * @throws If no matching record is found.
 */
export function fieldUpdateMemory(
  op: FieldUpdateOpConfig,
  config: ResolvedEntityConfig,
  store: Map<string | number, MemoryEntry>,
  isAlive: (entry: MemoryEntry) => boolean,
  isVisible: (record: Record<string, unknown>) => boolean,
): (
  params: Record<string, unknown>,
  input: Record<string, unknown>,
) => Promise<Record<string, unknown>> {
  return (params, input) => {
    const resolved = resolveParams(op.match, params);
    for (const entry of store.values()) {
      if (!isAlive(entry) || !isVisible(entry.record)) continue;
      if (!recordMatches(entry.record, resolved)) continue;
      for (const f of op.set) {
        if (input[f] !== undefined) entry.record[f] = input[f];
      }
      return Promise.resolve({ ...entry.record });
    }
    return Promise.reject(new Error(`[${config.name}] Record not found`));
  };
}

// ---------------------------------------------------------------------------
// SQLite
// ---------------------------------------------------------------------------

/**
 * Create a fieldUpdate executor for the SQLite store.
 *
 * Runs `UPDATE {table} SET ... WHERE {matchCols}` (if there are fields to set),
 * then re-fetches the row with `SELECT * FROM {table} WHERE {matchCols}`. Throws
 * if the re-fetch returns no row (record not found or deleted mid-flight).
 *
 * @param op - FieldUpdate operation config.
 * @param config - Resolved entity config.
 * @param db - Bun SQLite database handle.
 * @param table - SQL table name.
 * @param ensureTable - Idempotent table-creation function.
 * @param fromRow - Converts a raw SQLite row to a canonical record.
 * @returns An async function `(params, input) => Promise<Record<string, unknown>>`.
 * @throws If the target record does not exist after the update.
 */
export function fieldUpdateSqlite(
  op: FieldUpdateOpConfig,
  config: ResolvedEntityConfig,
  db: SqliteDb,
  table: string,
  ensureTable: () => void,
  fromRow: (row: Record<string, unknown>) => Record<string, unknown>,
): (
  params: Record<string, unknown>,
  input: Record<string, unknown>,
) => Promise<Record<string, unknown>> {
  const matchKeys = Object.keys(op.match);
  return (params, input) => {
    ensureTable();
    const resolved = resolveParams(op.match, params);
    const setClauses: string[] = [];
    const values: unknown[] = [];
    for (const f of op.set) {
      if (input[f] !== undefined) {
        setClauses.push(`${toSnakeCase(f)} = ?`);
        values.push(input[f]);
      }
    }
    const whereParts = matchKeys.map(f => `${toSnakeCase(f)} = ?`);
    const whereValues = matchKeys.map(f => resolved[f]);

    if (setClauses.length > 0) {
      db.run(`UPDATE ${table} SET ${setClauses.join(', ')} WHERE ${whereParts.join(' AND ')}`, [
        ...values,
        ...whereValues,
      ]);
    }
    const row = db
      .query<Record<string, unknown>>(`SELECT * FROM ${table} WHERE ${whereParts.join(' AND ')}`)
      .get(...whereValues);
    if (!row) throw new Error(`[${config.name}] Record not found`);
    return Promise.resolve(fromRow(row));
  };
}

// ---------------------------------------------------------------------------
// Postgres
// ---------------------------------------------------------------------------

/**
 * Create a fieldUpdate executor for the Postgres store.
 *
 * Runs `UPDATE {table} SET ... WHERE {matchCols} RETURNING *`. When the update
 * affects a row it is returned directly. When no rows are affected (no fields to
 * set or no match), a follow-up `SELECT` re-fetches the row, throwing if absent.
 *
 * @param op - FieldUpdate operation config.
 * @param config - Resolved entity config.
 * @param pool - Postgres connection pool.
 * @param table - SQL table name.
 * @param ensureTable - Async idempotent table-creation function.
 * @param fromRow - Converts a raw Postgres row to a canonical record.
 * @returns An async function `(params, input) => Promise<Record<string, unknown>>`.
 * @throws If the target record does not exist.
 */
export function fieldUpdatePostgres(
  op: FieldUpdateOpConfig,
  config: ResolvedEntityConfig,
  pool: PgPool,
  table: string,
  ensureTable: () => Promise<void>,
  fromRow: (row: Record<string, unknown>) => Record<string, unknown>,
): (
  params: Record<string, unknown>,
  input: Record<string, unknown>,
) => Promise<Record<string, unknown>> {
  const matchKeys = Object.keys(op.match);
  return async (params, input) => {
    await ensureTable();
    const resolved = resolveParams(op.match, params);
    const setClauses: string[] = [];
    const values: unknown[] = [];
    let pIdx = 0;
    for (const f of op.set) {
      if (input[f] !== undefined) {
        setClauses.push(`${toSnakeCase(f)} = $${++pIdx}`);
        values.push(input[f]);
      }
    }
    const whereParts = matchKeys.map(f => `${toSnakeCase(f)} = $${++pIdx}`);
    for (const f of matchKeys) values.push(resolved[f]);

    if (setClauses.length > 0) {
      const result = await pool.query(
        `UPDATE ${table} SET ${setClauses.join(', ')} WHERE ${whereParts.join(' AND ')} RETURNING *`,
        values,
      );
      if (result.rows[0]) return fromRow(result.rows[0]);
    }
    const result = await pool.query(
      `SELECT * FROM ${table} WHERE ${whereParts.join(' AND ')}`,
      matchKeys.map(f => resolved[f]),
    );
    if (!result.rows[0]) throw new Error(`[${config.name}] Record not found`);
    return fromRow(result.rows[0]);
  };
}

// ---------------------------------------------------------------------------
// Mongo
// ---------------------------------------------------------------------------

/**
 * Create a fieldUpdate executor for the MongoDB store.
 *
 * Calls `Model.updateOne(query, { $set })` then `Model.findOne(query).lean()`.
 * The follow-up read is necessary because Mongoose's `updateOne` does not return
 * the updated document. Throws if `findOne` returns `null`.
 *
 * @param op - FieldUpdate operation config.
 * @param config - Resolved entity config (provides `fields` for PK detection).
 * @param getModel - Lazy getter returning the Mongoose model.
 * @param fromDoc - Converts a raw Mongoose lean doc to a canonical record.
 * @returns An async function `(params, input) => Promise<Record<string, unknown>>`.
 * @throws If the target record does not exist after the update.
 */
export function fieldUpdateMongo(
  op: FieldUpdateOpConfig,
  config: ResolvedEntityConfig,
  getModel: () => MongoModel,
  fromDoc: (doc: Record<string, unknown>) => Record<string, unknown>,
): (
  params: Record<string, unknown>,
  input: Record<string, unknown>,
) => Promise<Record<string, unknown>> {
  return async (params, input) => {
    const resolved = resolveParams(op.match, params);
    const query: Record<string, unknown> = {};
    for (const [field, target] of Object.entries(resolved)) {
      query[config.fields[field].primary ? config._storageFields.mongoPkField : field] = target;
    }
    const $set: Record<string, unknown> = {};
    for (const f of op.set) {
      if (input[f] !== undefined) $set[f] = input[f];
    }
    const Model = getModel();
    await Model.updateOne(query, { $set });
    const doc = await Model.findOne(query).lean();
    if (!doc) throw new Error(`[${config.name}] Record not found`);
    return fromDoc(doc);
  };
}

// ---------------------------------------------------------------------------
// Redis
// ---------------------------------------------------------------------------

/**
 * Create a fieldUpdate executor for the Redis store.
 *
 * Scans all keys, deserialises each record, applies visibility and match checks,
 * then mutates `op.set` fields in-place and writes the updated record back via
 * `storeRecord`. Throws if no matching record is found.
 *
 * @param op - FieldUpdate operation config.
 * @param config - Resolved entity config (used for error messages).
 * @param redis - ioredis client instance.
 * @param scanAllKeys - Returns all key strings for this entity's key space.
 * @param isVisible - Tenant visibility check.
 * @param fromRedisRecord - Deserialises a raw Redis record into the canonical shape.
 * @param storeRecord - Serialises and writes an updated record back to Redis.
 * @returns An async function `(params, input) => Promise<Record<string, unknown>>`.
 * @throws If no matching record is found.
 */
export function fieldUpdateRedis(
  op: FieldUpdateOpConfig,
  config: ResolvedEntityConfig,
  redis: RedisClient,
  scanAllKeys: () => Promise<string[]>,
  isVisible: (record: Record<string, unknown>) => boolean,
  fromRedisRecord: (raw: Record<string, unknown>) => Record<string, unknown>,
  storeRecord: (record: Record<string, unknown>) => Promise<void>,
): (
  params: Record<string, unknown>,
  input: Record<string, unknown>,
) => Promise<Record<string, unknown>> {
  return async (params, input) => {
    const resolved = resolveParams(op.match, params);
    const allKeys = await scanAllKeys();
    for (const key of allKeys) {
      const raw = await redis.get(key);
      if (!raw) continue;
      const record = fromRedisRecord(JSON.parse(raw) as Record<string, unknown>);
      if (!isVisible(record)) continue;
      if (!recordMatches(record, resolved)) continue;
      for (const f of op.set) {
        if (input[f] !== undefined) record[f] = input[f];
      }
      await storeRecord(record);
      return { ...record };
    }
    throw new Error(`[${config.name}] Record not found`);
  };
}
