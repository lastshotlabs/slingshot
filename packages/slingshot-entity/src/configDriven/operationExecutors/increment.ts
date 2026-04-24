/**
 * Runtime executor: op.increment — atomically increment (or decrement) a numeric field.
 *
 * The record is identified by its primary key. The named field is treated as a number;
 * if the stored value is not a number it is treated as `0` before adding `effectiveBy`.
 * Pass a negative `by` value to decrement.
 *
 * `effectiveBy` is resolved as: call-time `by` argument → `op.by` → `1`.
 *
 * **Error behaviour:** All backends throw `Error('[EntityName] Not found')` when no
 * record with the given primary key exists.
 */
import type { IncrementOpConfig, ResolvedEntityConfig } from '@lastshotlabs/slingshot-core';
import { toSnakeCase } from '../fieldUtils';
import type { MemoryEntry, MongoModel, PgPool, RedisClient, SqliteDb } from './dbInterfaces';

// ---------------------------------------------------------------------------
// Memory
// ---------------------------------------------------------------------------

/**
 * Create an increment executor for the in-memory store.
 *
 * Looks up the entry by primary key, coerces the current field value to a number
 * (defaulting to `0` when absent or non-numeric), adds `effectiveBy`, and writes
 * the new value in-place.
 *
 * @param op        - Increment operation config with `field` and optional `by`.
 * @param config    - Resolved entity config (used for error messages and pk field).
 * @param store     - The entity's in-memory store map.
 * @param isAlive   - TTL check for each entry.
 * @param isVisible - Tenant visibility check.
 * @returns An async function `(id, by?) => Promise<Record<string, unknown>>`
 *   returning the full updated record.
 * @throws If the record is not found.
 */
export function incrementMemory(
  op: IncrementOpConfig,
  config: ResolvedEntityConfig,
  store: Map<string | number, MemoryEntry>,
  isAlive: (entry: MemoryEntry) => boolean,
  isVisible: (record: Record<string, unknown>) => boolean,
): (id: unknown, by?: number) => Promise<Record<string, unknown>> {
  return (id, by) => {
    const effectiveBy = by ?? op.by ?? 1;
    const entry = store.get(String(id));
    if (!entry || !isAlive(entry) || !isVisible(entry.record)) {
      throw new Error(`[${config.name}] Not found`);
    }
    const current = entry.record[op.field];
    entry.record[op.field] = (typeof current === 'number' ? current : 0) + effectiveBy;
    return Promise.resolve({ ...entry.record });
  };
}

// ---------------------------------------------------------------------------
// SQLite
// ---------------------------------------------------------------------------

/**
 * Create an increment executor for the SQLite store.
 *
 * Uses `UPDATE {table} SET {field} = COALESCE({field}, 0) + ? WHERE {pk} = ?` for
 * the increment, then re-fetches the row to return the canonical record.
 * Throws if no record exists.
 *
 * @param op          - Increment operation config with `field` and optional `by`.
 * @param config      - Resolved entity config.
 * @param db          - Bun SQLite database handle.
 * @param table       - SQL table name.
 * @param ensureTable - Idempotent table-creation function.
 * @param fromRow     - Converts a raw SQLite row to a canonical record.
 * @returns An async function `(id, by?) => Promise<Record<string, unknown>>`.
 * @throws If the record does not exist.
 */
export function incrementSqlite(
  op: IncrementOpConfig,
  config: ResolvedEntityConfig,
  db: SqliteDb,
  table: string,
  ensureTable: () => void,
  fromRow: (row: Record<string, unknown>) => Record<string, unknown>,
): (id: unknown, by?: number) => Promise<Record<string, unknown>> {
  const pkCol = toSnakeCase(config._pkField);
  const snakeField = toSnakeCase(op.field);
  return (id, by) => {
    ensureTable();
    const effectiveBy = by ?? op.by ?? 1;
    const exists = db
      .query<Record<string, unknown>>(`SELECT 1 FROM ${table} WHERE ${pkCol} = ?`)
      .get(id);
    if (!exists) throw new Error(`[${config.name}] Not found`);
    db.run(
      `UPDATE ${table} SET ${snakeField} = COALESCE(${snakeField}, 0) + ? WHERE ${pkCol} = ?`,
      [effectiveBy, id],
    );
    const updated = db
      .query<Record<string, unknown>>(`SELECT * FROM ${table} WHERE ${pkCol} = ?`)
      .get(id);
    if (!updated) throw new Error(`[${config.name}] Not found`);
    return Promise.resolve(fromRow(updated));
  };
}

// ---------------------------------------------------------------------------
// Postgres
// ---------------------------------------------------------------------------

/**
 * Create an increment executor for the Postgres store.
 *
 * Uses `UPDATE {table} SET {field} = COALESCE({field}, 0) + $2 WHERE {pk} = $1 RETURNING *`
 * — a single atomic statement. Throws if no rows are returned (record not found).
 *
 * @param op          - Increment operation config with `field` and optional `by`.
 * @param config      - Resolved entity config.
 * @param pool        - Postgres connection pool.
 * @param table       - SQL table name.
 * @param ensureTable - Async idempotent table-creation function.
 * @param fromRow     - Converts a raw Postgres row to a canonical record.
 * @returns An async function `(id, by?) => Promise<Record<string, unknown>>`.
 * @throws If the record does not exist.
 */
export function incrementPostgres(
  op: IncrementOpConfig,
  config: ResolvedEntityConfig,
  pool: PgPool,
  table: string,
  ensureTable: () => Promise<void>,
  fromRow: (row: Record<string, unknown>) => Record<string, unknown>,
): (id: unknown, by?: number) => Promise<Record<string, unknown>> {
  const pkCol = toSnakeCase(config._pkField);
  const snakeField = toSnakeCase(op.field);
  return async (id, by) => {
    await ensureTable();
    const effectiveBy = by ?? op.by ?? 1;
    const result = await pool.query(
      `UPDATE ${table} SET ${snakeField} = COALESCE(${snakeField}, 0) + $2 WHERE ${pkCol} = $1 RETURNING *`,
      [id, effectiveBy],
    );
    if (!result.rows[0]) throw new Error(`[${config.name}] Not found`);
    return fromRow(result.rows[0]);
  };
}

// ---------------------------------------------------------------------------
// MongoDB
// ---------------------------------------------------------------------------

/**
 * Create an increment executor for the MongoDB store.
 *
 * Uses `Model.updateOne({ _id: id }, { $inc: { [field]: effectiveBy } })` to
 * atomically increment the field, then fetches and returns the updated document
 * via `Model.findOne({ _id: id }).lean()`.
 *
 * @param op       - Increment operation config with `field` and optional `by`.
 * @param config   - Resolved entity config (used for error messages).
 * @param getModel - Lazy getter returning the Mongoose model.
 * @param fromDoc  - Converts a raw Mongoose lean doc to a canonical record.
 * @returns An async function `(id, by?) => Promise<Record<string, unknown>>`.
 * @throws If the record does not exist.
 */
export function incrementMongo(
  op: IncrementOpConfig,
  config: ResolvedEntityConfig,
  getModel: () => MongoModel,
  fromDoc: (doc: Record<string, unknown>) => Record<string, unknown>,
): (id: unknown, by?: number) => Promise<Record<string, unknown>> {
  return async (id, by) => {
    const effectiveBy = by ?? op.by ?? 1;
    const Model = getModel();
    const pkField = config._storageFields.mongoPkField;
    const result = await Model.updateOne({ [pkField]: id }, { $inc: { [op.field]: effectiveBy } });
    if (result.matchedCount === 0) throw new Error(`[${config.name}] Not found`);
    const doc = await Model.findOne({ [pkField]: id }).lean();
    if (!doc) throw new Error(`[${config.name}] Not found`);
    return fromDoc(doc);
  };
}

// ---------------------------------------------------------------------------
// Redis
// ---------------------------------------------------------------------------

/**
 * Create an increment executor for the Redis store.
 *
 * Scans all keys, finds the record matching the given primary key, reads the
 * current field value, adds `effectiveBy` (treating non-numeric as `0`), and
 * writes the updated record back via `storeRecord`.
 *
 * @param op              - Increment operation config with `field` and optional `by`.
 * @param config          - Resolved entity config (used for pk field and error messages).
 * @param redis           - ioredis client instance.
 * @param scanAllKeys     - Returns all key strings for this entity's key space.
 * @param isVisible       - Tenant visibility check.
 * @param fromRedisRecord - Deserialises a raw Redis record into the canonical shape.
 * @param storeRecord     - Serialises and writes an updated record back to Redis.
 * @returns An async function `(id, by?) => Promise<Record<string, unknown>>`.
 * @throws If no matching record is found.
 */
export function incrementRedis(
  op: IncrementOpConfig,
  config: ResolvedEntityConfig,
  redis: RedisClient,
  scanAllKeys: () => Promise<string[]>,
  isVisible: (record: Record<string, unknown>) => boolean,
  fromRedisRecord: (raw: Record<string, unknown>) => Record<string, unknown>,
  storeRecord: (record: Record<string, unknown>) => Promise<void>,
): (id: unknown, by?: number) => Promise<Record<string, unknown>> {
  const pkField = config._pkField;
  return async (id, by) => {
    const effectiveBy = by ?? op.by ?? 1;
    const allKeys = await scanAllKeys();
    for (const key of allKeys) {
      const raw = await redis.get(key);
      if (!raw) continue;
      const record = fromRedisRecord(JSON.parse(raw) as Record<string, unknown>);
      if (!isVisible(record)) continue;
      if (record[pkField] !== id && String(record[pkField]) !== String(id)) continue;
      const current = record[op.field];
      record[op.field] = (typeof current === 'number' ? current : 0) + effectiveBy;
      await storeRecord(record);
      return { ...record };
    }
    throw new Error(`[${config.name}] Not found`);
  };
}
