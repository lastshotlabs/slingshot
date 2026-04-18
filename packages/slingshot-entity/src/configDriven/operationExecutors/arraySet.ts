/**
 * Runtime executor: op.arraySet — replace an entire array field on a matched record.
 *
 * The record is identified by its primary key. The stored array becomes exactly the
 * incoming `value` (which must be an array). When `dedupe` is true (the default),
 * the incoming array is deduplicated server-side — `[...new Set(incoming)]` — before
 * writing, preserving the first occurrence of each value in insertion order.
 *
 * The `value` binding is resolved at the HTTP layer before the executor is called;
 * the executor receives the resolved array directly as its second argument.
 *
 * **Error behaviour:** All backends throw `Error('[EntityName] Not found')` when no
 * record with the given primary key exists. All backends throw
 * `Error('[EntityName] arraySet value must be an array')` when `value` is not an array.
 */
import type { ArraySetOpConfig, ResolvedEntityConfig } from '@lastshotlabs/slingshot-core';
import { toSnakeCase } from '../fieldUtils';
import type { MemoryEntry, MongoModel, PgPool, RedisClient, SqliteDb } from './dbInterfaces';

function ensureArray(value: unknown, entityName: string): unknown[] {
  if (!Array.isArray(value)) {
    throw new Error(`[${entityName}] arraySet value must be an array`);
  }
  return value;
}

function applyDedupe(arr: unknown[], dedupe: boolean): unknown[] {
  return dedupe ? [...new Set(arr)] : arr;
}

// ---------------------------------------------------------------------------
// Memory
// ---------------------------------------------------------------------------

/**
 * Create an arraySet executor for the in-memory store.
 *
 * Looks up the entry by primary key, validates `value` is an array, applies optional
 * deduplication, and replaces the field in-place.
 *
 * @param op     - ArraySet operation config with `field` and optional `dedupe`.
 * @param config - Resolved entity config (used for error messages and pk field).
 * @param store  - The entity's in-memory store map.
 * @param isAlive   - TTL check for each entry.
 * @param isVisible - Tenant visibility check.
 * @returns An async function `(id, value) => Promise<Record<string, unknown>>`
 *   returning the full updated record.
 * @throws If the record is not found or `value` is not an array.
 */
export function arraySetMemory(
  op: ArraySetOpConfig,
  config: ResolvedEntityConfig,
  store: Map<string | number, MemoryEntry>,
  isAlive: (entry: MemoryEntry) => boolean,
  isVisible: (record: Record<string, unknown>) => boolean,
): (id: unknown, value: unknown) => Promise<Record<string, unknown>> {
  const dedupe = op.dedupe !== false;
  return (id, value) => {
    let incoming: unknown[];
    try {
      incoming = ensureArray(value, config.name);
    } catch (error) {
      return Promise.reject(error instanceof Error ? error : new Error(String(error)));
    }
    const entry = store.get(String(id));
    if (!entry || !isAlive(entry) || !isVisible(entry.record)) {
      return Promise.reject(new Error(`[${config.name}] Not found`));
    }
    entry.record[op.field] = applyDedupe(incoming, dedupe);
    return Promise.resolve({ ...entry.record });
  };
}

// ---------------------------------------------------------------------------
// SQLite
// ---------------------------------------------------------------------------

/**
 * Create an arraySet executor for the SQLite store.
 *
 * Fetches the existing row to confirm it exists, then runs a single
 * `UPDATE {table} SET {field} = ? WHERE {pk} = ?` with the deduplicated array
 * serialized as JSON. Re-fetches via `SELECT` to return the canonical record.
 *
 * @param op          - ArraySet operation config.
 * @param config      - Resolved entity config.
 * @param db          - Bun SQLite database handle.
 * @param table       - SQL table name.
 * @param ensureTable - Idempotent table-creation function.
 * @param fromRow     - Converts a raw SQLite row to a canonical record.
 * @returns An async function `(id, value) => Promise<Record<string, unknown>>`.
 * @throws If the record does not exist or `value` is not an array.
 */
export function arraySetSqlite(
  op: ArraySetOpConfig,
  config: ResolvedEntityConfig,
  db: SqliteDb,
  table: string,
  ensureTable: () => void,
  fromRow: (row: Record<string, unknown>) => Record<string, unknown>,
): (id: unknown, value: unknown) => Promise<Record<string, unknown>> {
  const pkCol = toSnakeCase(config._pkField);
  const snakeField = toSnakeCase(op.field);
  const dedupe = op.dedupe !== false;
  return (id, value) => {
    ensureTable();
    const incoming = ensureArray(value, config.name);
    const exists = db
      .query<Record<string, unknown>>(`SELECT 1 FROM ${table} WHERE ${pkCol} = ?`)
      .get(id);
    if (!exists) throw new Error(`[${config.name}] Not found`);
    const deduped = applyDedupe(incoming, dedupe);
    db.run(`UPDATE ${table} SET ${snakeField} = ? WHERE ${pkCol} = ?`, [
      JSON.stringify(deduped),
      id,
    ]);
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
 * Create an arraySet executor for the Postgres store.
 *
 * For `string[]` fields (native Postgres arrays), writes the array directly.
 * For all other array fields, serializes to JSON text.
 * Uses `UPDATE ... WHERE ... RETURNING *` — single atomic statement.
 * Throws if no rows are returned (record not found).
 *
 * @param op          - ArraySet operation config.
 * @param config      - Resolved entity config (used to detect native array fields).
 * @param pool        - Postgres connection pool.
 * @param table       - SQL table name.
 * @param ensureTable - Async idempotent table-creation function.
 * @param fromRow     - Converts a raw Postgres row to a canonical record.
 * @returns An async function `(id, value) => Promise<Record<string, unknown>>`.
 * @throws If the record does not exist or `value` is not an array.
 */
export function arraySetPostgres(
  op: ArraySetOpConfig,
  config: ResolvedEntityConfig,
  pool: PgPool,
  table: string,
  ensureTable: () => Promise<void>,
  fromRow: (row: Record<string, unknown>) => Record<string, unknown>,
): (id: unknown, value: unknown) => Promise<Record<string, unknown>> {
  const pkCol = toSnakeCase(config._pkField);
  const snakeField = toSnakeCase(op.field);
  const isNativeArray = config.fields[op.field].type === 'string[]';
  const dedupe = op.dedupe !== false;
  return async (id, value) => {
    await ensureTable();
    const incoming = ensureArray(value, config.name);
    const deduped = applyDedupe(incoming, dedupe);
    const serialized = isNativeArray ? deduped : JSON.stringify(deduped);
    const result = await pool.query(
      `UPDATE ${table} SET ${snakeField} = $2 WHERE ${pkCol} = $1 RETURNING *`,
      [id, serialized],
    );
    if (!result.rows[0]) throw new Error(`[${config.name}] Not found`);
    return fromRow(result.rows[0]);
  };
}

// ---------------------------------------------------------------------------
// MongoDB
// ---------------------------------------------------------------------------

/**
 * Create an arraySet executor for the MongoDB store.
 *
 * Uses `Model.findOneAndUpdate({ _id: id }, { $set: { [field]: deduped } }, { new: true }).lean()`
 * to atomically replace the array and return the updated document.
 *
 * @param op       - ArraySet operation config.
 * @param config   - Resolved entity config (provides `fields` for PK detection).
 * @param getModel - Lazy getter returning the Mongoose model.
 * @param fromDoc  - Converts a raw Mongoose lean doc to a canonical record.
 * @returns An async function `(id, value) => Promise<Record<string, unknown>>`.
 * @throws If the record does not exist or `value` is not an array.
 */
export function arraySetMongo(
  op: ArraySetOpConfig,
  config: ResolvedEntityConfig,
  getModel: () => MongoModel,
  fromDoc: (doc: Record<string, unknown>) => Record<string, unknown>,
): (id: unknown, value: unknown) => Promise<Record<string, unknown>> {
  const dedupe = op.dedupe !== false;
  return async (id, value) => {
    const incoming = ensureArray(value, config.name);
    const deduped = applyDedupe(incoming, dedupe);
    const Model = getModel();
    const result = await Model.updateOne({ _id: id }, { $set: { [op.field]: deduped } });
    if (result.matchedCount === 0) throw new Error(`[${config.name}] Not found`);
    const doc = await Model.findOne({ _id: id }).lean();
    if (!doc) throw new Error(`[${config.name}] Not found`);
    return fromDoc(doc);
  };
}

// ---------------------------------------------------------------------------
// Redis
// ---------------------------------------------------------------------------

/**
 * Create an arraySet executor for the Redis store.
 *
 * Scans all keys, finds the record matching the given primary key, replaces the
 * array field (with optional deduplication), and writes the updated record back.
 *
 * @param op              - ArraySet operation config.
 * @param config          - Resolved entity config (used for pk field and error messages).
 * @param redis           - ioredis client instance.
 * @param scanAllKeys     - Returns all key strings for this entity's key space.
 * @param isVisible       - Tenant visibility check.
 * @param fromRedisRecord - Deserialises a raw Redis record into the canonical shape.
 * @param storeRecord     - Serialises and writes an updated record back to Redis.
 * @returns An async function `(id, value) => Promise<Record<string, unknown>>`.
 * @throws If no matching record is found or `value` is not an array.
 */
export function arraySetRedis(
  op: ArraySetOpConfig,
  config: ResolvedEntityConfig,
  redis: RedisClient,
  scanAllKeys: () => Promise<string[]>,
  isVisible: (record: Record<string, unknown>) => boolean,
  fromRedisRecord: (raw: Record<string, unknown>) => Record<string, unknown>,
  storeRecord: (record: Record<string, unknown>) => Promise<void>,
): (id: unknown, value: unknown) => Promise<Record<string, unknown>> {
  const pkField = config._pkField;
  const dedupe = op.dedupe !== false;
  return async (id, value) => {
    const incoming = ensureArray(value, config.name);
    const deduped = applyDedupe(incoming, dedupe);
    const allKeys = await scanAllKeys();
    for (const key of allKeys) {
      const raw = await redis.get(key);
      if (!raw) continue;
      const record = fromRedisRecord(JSON.parse(raw) as Record<string, unknown>);
      if (!isVisible(record)) continue;
      if (record[pkField] !== id && String(record[pkField]) !== String(id)) continue;
      record[op.field] = deduped;
      await storeRecord(record);
      return { ...record };
    }
    throw new Error(`[${config.name}] Not found`);
  };
}
