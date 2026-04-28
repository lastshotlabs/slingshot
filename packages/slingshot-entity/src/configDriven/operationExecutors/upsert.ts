/**
 * Runtime executor: `op.upsert` — insert-or-update by unique key combination.
 *
 * Each exported function is a per-backend factory. The returned async function
 * accepts the input record and either creates a new entity (if no match is found)
 * or updates the specified fields of the existing one.
 *
 * **Match semantics:** `op.match` is an array of field names. An existing record
 * is found when all match-field values equal the corresponding input values.
 *
 * **Set semantics:** `op.set` is an array of field names whose values are written
 * on update. On insert, the full `input` is used (plus `op.onCreate` defaults).
 *
 * **`op.onCreate`** — default-value map applied only during insertion:
 * - `'uuid'` → `crypto.randomUUID()`.
 * - `'cuid'` → a compact cuid-style identifier.
 * - `'now'` → `new Date()`.
 * - Any other value → used as a literal.
 *
 * **`op.returns`** — when `{ created: true }`, the return value is
 * `{ entity: Record<string, unknown>, created: boolean }` rather than the plain record.
 *
 * **Atomicity:**
 * - Memory: serialized per-store via `serializeOnStore` — concurrent upserts on
 *   the same table run FIFO, so a find-or-insert sequence cannot interleave with
 *   another caller's read between the scan and the write. Single-call semantics
 *   (return shape, error behaviour) are unchanged.
 * - SQLite: `INSERT ... ON CONFLICT DO UPDATE SET` — atomic.
 * - Postgres: `INSERT ... ON CONFLICT DO UPDATE SET ... RETURNING *` — atomic.
 * - Mongo: `updateOne(query, { $set, $setOnInsert }, { upsert: true })` — atomic.
 * - Redis: iterative scan — not atomic; concurrent upserts may create duplicates.
 */
import type { ResolvedEntityConfig, UpsertOpConfig } from '@lastshotlabs/slingshot-core';
import { applyDefaults, toSnakeCase } from '../fieldUtils';
import type { MemoryEntry, MongoModel, PgPool, RedisClient, SqliteDb } from './dbInterfaces';
import { serializeOnStore } from './memoryMutex';

function resolveOnCreate(
  op: UpsertOpConfig,
  config: ResolvedEntityConfig,
  input: Record<string, unknown>,
): Record<string, unknown> {
  const record = applyDefaults(input, config.fields, config._conventions?.autoDefault);
  if (op.onCreate) {
    for (const [f, v] of Object.entries(op.onCreate)) {
      if (v === 'uuid') record[f] = crypto.randomUUID();
      else if (v === 'cuid')
        record[f] = `c${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
      else if (v === 'now') record[f] = new Date();
      else record[f] = v;
    }
  }
  return record;
}

// ---------------------------------------------------------------------------
// Memory
// ---------------------------------------------------------------------------

/**
 * Create an upsert executor for the in-memory store.
 *
 * Scans the store for a matching record. If found, mutates `op.set` fields in-place.
 * If not found, applies `op.onCreate` defaults and inserts a new entry.
 *
 * @param op - Upsert operation config.
 * @param config - Resolved entity config.
 * @param store - The entity's in-memory store map.
 * @param isAlive - TTL check — expired entries are skipped during match.
 * @param isVisible - Tenant visibility check.
 * @param pkField - Primary key field name for indexing new entries in the store.
 * @param ttlMs - Optional TTL in milliseconds applied to newly inserted entries.
 * @returns An async function `(input) => Promise<Record<string, unknown>>`.
 */
export function upsertMemory(
  op: UpsertOpConfig,
  config: ResolvedEntityConfig,
  store: Map<string | number, MemoryEntry>,
  isAlive: (entry: MemoryEntry) => boolean,
  isVisible: (record: Record<string, unknown>) => boolean,
  pkField: string,
  ttlMs: number | undefined,
): (input: Record<string, unknown>) => Promise<Record<string, unknown>> {
  const returnsCreated = typeof op.returns === 'object' && op.returns.created;
  return input =>
    serializeOnStore(store, () => {
      for (const entry of store.values()) {
        if (!isAlive(entry) || !isVisible(entry.record)) continue;
        if (op.match.every(f => entry.record[f] === input[f])) {
          for (const f of op.set) {
            if (input[f] !== undefined) entry.record[f] = input[f];
          }
          return Promise.resolve(
            returnsCreated ? { entity: { ...entry.record }, created: false } : { ...entry.record },
          );
        }
      }
      const record = resolveOnCreate(op, config, input);
      const pk = record[pkField] as string | number;
      store.set(pk, { record, expiresAt: ttlMs ? Date.now() + ttlMs : undefined });
      return Promise.resolve(
        returnsCreated ? { entity: { ...record }, created: true } : { ...record },
      );
    });
}

// ---------------------------------------------------------------------------
// SQLite
// ---------------------------------------------------------------------------

/**
 * Create an upsert executor for the SQLite store.
 *
 * Uses `INSERT INTO ... ON CONFLICT(...) DO UPDATE SET ...` which is atomic
 * within SQLite's WAL mode. After the statement, a `SELECT` re-fetches the
 * final row so the return value always reflects the persisted state.
 *
 * @param op - Upsert operation config.
 * @param config - Resolved entity config.
 * @param db - Bun SQLite database handle.
 * @param table - SQL table name.
 * @param ensureTable - Idempotent table-creation function.
 * @param toRow - Converts a canonical record to a flat SQLite row (snake_case columns).
 * @param fromRow - Converts a raw SQLite row back to a canonical record.
 * @returns An async function `(input) => Promise<Record<string, unknown>>`.
 */
export function upsertSqlite(
  op: UpsertOpConfig,
  config: ResolvedEntityConfig,
  db: SqliteDb,
  table: string,
  ensureTable: () => void,
  toRow: (record: Record<string, unknown>) => Record<string, unknown>,
  fromRow: (row: Record<string, unknown>) => Record<string, unknown>,
): (input: Record<string, unknown>) => Promise<Record<string, unknown>> {
  const matchCols = op.match.map(f => toSnakeCase(f));
  const updateCols = op.set.map(f => `${toSnakeCase(f)} = excluded.${toSnakeCase(f)}`);
  return input => {
    ensureTable();
    const record = resolveOnCreate(op, config, input);
    const row = toRow(record);
    const columns = Object.keys(row);
    const placeholders = columns.map(() => '?').join(', ');
    const values = columns.map(c => row[c]);
    db.run(
      `INSERT INTO ${table} (${columns.join(', ')}) VALUES (${placeholders}) ON CONFLICT(${matchCols.join(', ')}) DO UPDATE SET ${updateCols.join(', ')}`,
      values,
    );
    const fetched = db
      .query<
        Record<string, unknown>
      >(`SELECT * FROM ${table} WHERE ${matchCols.map(c => `${c} = ?`).join(' AND ')}`)
      .get(...op.match.map(f => input[f]));
    return Promise.resolve(fetched ? fromRow(fetched) : record);
  };
}

// ---------------------------------------------------------------------------
// Postgres
// ---------------------------------------------------------------------------

/**
 * Create an upsert executor for the Postgres store.
 *
 * Uses `INSERT INTO ... ON CONFLICT (...) DO UPDATE SET ... RETURNING *`, which is
 * atomic and returns the final row in a single round-trip (no second `SELECT` needed).
 *
 * @param op - Upsert operation config.
 * @param config - Resolved entity config.
 * @param pool - Postgres connection pool.
 * @param table - SQL table name.
 * @param ensureTable - Async idempotent table-creation function.
 * @param toRow - Converts a canonical record to a flat Postgres row.
 * @param fromRow - Converts a raw Postgres row to a canonical record.
 * @returns An async function `(input) => Promise<Record<string, unknown>>`.
 */
export function upsertPostgres(
  op: UpsertOpConfig,
  config: ResolvedEntityConfig,
  pool: PgPool,
  table: string,
  ensureTable: () => Promise<void>,
  toRow: (record: Record<string, unknown>) => Record<string, unknown>,
  fromRow: (row: Record<string, unknown>) => Record<string, unknown>,
): (input: Record<string, unknown>) => Promise<Record<string, unknown>> {
  const matchCols = op.match.map(f => toSnakeCase(f));
  const updateCols = op.set.map(f => `${toSnakeCase(f)} = EXCLUDED.${toSnakeCase(f)}`);
  return async input => {
    await ensureTable();
    const record = resolveOnCreate(op, config, input);
    const row = toRow(record);
    const columns = Object.keys(row);
    const placeholders = columns.map((_, i) => `$${i + 1}`).join(', ');
    const values = columns.map(c => row[c]);
    const result = await pool.query(
      `INSERT INTO ${table} (${columns.join(', ')}) VALUES (${placeholders}) ON CONFLICT (${matchCols.join(', ')}) DO UPDATE SET ${updateCols.join(', ')} RETURNING *`,
      values,
    );
    return result.rows[0] ? fromRow(result.rows[0]) : record;
  };
}

// ---------------------------------------------------------------------------
// Mongo
// ---------------------------------------------------------------------------

/**
 * Create an upsert executor for the MongoDB store.
 *
 * Uses `Model.updateOne(query, { $set, $setOnInsert }, { upsert: true })` followed
 * by a `findOne` to return the final document. `$setOnInsert` is populated from
 * `op.onCreate` defaults and is only applied on the insert path. `$set` applies
 * `op.set` fields on both paths.
 *
 * @param op - Upsert operation config.
 * @param config - Resolved entity config (provides `fields` metadata and `_pkField`).
 * @param getModel - Lazy getter returning the Mongoose model.
 * @param fromDoc - Converts a raw Mongoose lean doc to a canonical record.
 * @returns An async function `(input) => Promise<Record<string, unknown>>`.
 */
export function upsertMongo(
  op: UpsertOpConfig,
  config: ResolvedEntityConfig,
  getModel: () => MongoModel,
  fromDoc: (doc: Record<string, unknown>) => Record<string, unknown>,
): (input: Record<string, unknown>) => Promise<Record<string, unknown>> {
  return async input => {
    const query: Record<string, unknown> = {};
    for (const f of op.match) {
      query[config.fields[f].primary ? '_id' : f] = input[f];
    }
    const $set: Record<string, unknown> = {};
    for (const f of op.set) {
      if (input[f] !== undefined) $set[f] = input[f];
    }
    const $setOnInsert: Record<string, unknown> = {};
    const insertRecord = resolveOnCreate(op, config, input);
    for (const [f, v] of Object.entries(insertRecord)) {
      if (op.match.includes(f) || op.set.includes(f)) continue;
      const mongoField = f === config._pkField ? '_id' : f;
      $setOnInsert[mongoField] = v;
    }
    const Model = getModel();
    const update: Record<string, unknown> = { $set };
    if (Object.keys($setOnInsert).length > 0) update.$setOnInsert = $setOnInsert;
    await Model.updateOne(query, update, { upsert: true });
    const doc = await Model.findOne(query).lean();
    return doc ? fromDoc(doc) : input;
  };
}

// ---------------------------------------------------------------------------
// Redis
// ---------------------------------------------------------------------------

/**
 * Create an upsert executor for the Redis store.
 *
 * Scans all keys to find a matching record. If found, applies `op.set` field
 * updates and writes back via `storeRecord`. If not found, applies `op.onCreate`
 * defaults, inserts the new record, and returns it. Not atomic — concurrent
 * upserts on the same match keys may result in duplicate records.
 *
 * @param op - Upsert operation config.
 * @param config - Resolved entity config.
 * @param redis - ioredis client instance.
 * @param scanAllKeys - Returns all key strings for this entity's key space.
 * @param isVisible - Tenant visibility check applied before match.
 * @param fromRedisRecord - Deserialises a raw Redis record into the canonical shape.
 * @param storeRecord - Serialises and writes a record to Redis.
 * @returns An async function `(input) => Promise<Record<string, unknown>>`.
 */
export function upsertRedis(
  op: UpsertOpConfig,
  config: ResolvedEntityConfig,
  redis: RedisClient,
  scanAllKeys: () => Promise<string[]>,
  isVisible: (record: Record<string, unknown>) => boolean,
  fromRedisRecord: (raw: Record<string, unknown>) => Record<string, unknown>,
  storeRecord: (record: Record<string, unknown>) => Promise<void>,
): (input: Record<string, unknown>) => Promise<Record<string, unknown>> {
  return async input => {
    const allKeys = await scanAllKeys();
    for (const key of allKeys) {
      const raw = await redis.get(key);
      if (!raw) continue;
      const record = fromRedisRecord(JSON.parse(raw) as Record<string, unknown>);
      if (!isVisible(record)) continue;
      if (op.match.every(f => record[f] === input[f])) {
        for (const f of op.set) {
          if (input[f] !== undefined) record[f] = input[f];
        }
        await storeRecord(record);
        return { ...record };
      }
    }
    const record = resolveOnCreate(op, config, input);
    await storeRecord(record);
    return { ...record };
  };
}
