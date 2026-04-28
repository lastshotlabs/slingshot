/**
 * Runtime executor: `op.transition` — conditional state-machine field update.
 *
 * Each exported function is a per-backend factory. The returned executor accepts
 * `params` (used for matching and optional side-effect field values) and atomically
 * updates the entity only when the state transition guard passes.
 *
 * **Transition guard:** The record is updated only when:
 * 1. All `op.match` conditions are satisfied.
 * 2. The current value of `op.field` equals `op.from`.
 *
 * If the guard fails (no matching record, or the field is not in the `from` state),
 * the executor returns `null` without writing anything.
 *
 * **Side-effect fields (`op.set`):** Additional fields to write alongside the
 * state transition. Supports `'now'` (current `Date`) and `'param:x'` references.
 *
 * **Return value:** The updated record as `Record<string, unknown>`, or `null` if
 * the transition did not proceed.
 *
 * **Atomicity:**
 * - Memory: serialized per-store via `serializeOnStore` — concurrent transitions
 *   on the same table run FIFO, so the find-and-mutate cycle cannot interleave.
 * - SQLite: single `UPDATE ... WHERE ... AND {field} = {from}` — atomic. Returns
 *   `null` via `changes === 0` check.
 * - Postgres: `UPDATE ... WHERE ... AND {field} = {from} RETURNING *` — atomic.
 * - Mongo: `updateOne(query ∪ { [field]: from }, { $set })` — atomic per document.
 *   A follow-up `findOne` retrieves the updated document; `query` has the `field`
 *   condition removed before re-fetching.
 * - Redis: read-modify-write — not atomic; concurrent writes may race.
 */
import type { ResolvedEntityConfig, TransitionOpConfig } from '@lastshotlabs/slingshot-core';
import { toSnakeCase } from '../fieldUtils';
import type { MemoryEntry, MongoModel, PgPool, RedisClient, SqliteDb } from './dbInterfaces';
import { serializeOnStore } from './memoryMutex';

function fromValues(op: TransitionOpConfig): readonly (string | number | boolean)[] {
  if (Array.isArray(op.from)) {
    return op.from as readonly (string | number | boolean)[];
  }
  return [op.from as string | number | boolean];
}

function matchesFrom(op: TransitionOpConfig, value: unknown): boolean {
  return fromValues(op).some(candidate => candidate === value);
}

function resolveSetFields(
  op: TransitionOpConfig,
  record: Record<string, unknown>,
  params: Record<string, unknown>,
): void {
  record[op.field] = op.to;
  if (op.set) {
    for (const [f, v] of Object.entries(op.set)) {
      if (v === 'now') record[f] = new Date();
      else if (typeof v === 'string' && v.startsWith('param:')) record[f] = params[v.slice(6)];
      else record[f] = v;
    }
  }
}

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

// ---------------------------------------------------------------------------
// Memory
// ---------------------------------------------------------------------------

/**
 * Create a transition executor for the in-memory store.
 *
 * Scans the store, resolves `op.match` conditions from `params`, and finds the
 * first entry where all match fields equal the resolved values. If found but the
 * `op.field` value does not equal `op.from`, returns `null`. If both match and
 * guard pass, applies `op.to` and any `op.set` side effects in-place.
 *
 * @param op - Transition operation config with `match`, `field`, `from`, `to`, and `set`.
 * @param store - The entity's in-memory store map.
 * @param isAlive - TTL check for each entry.
 * @param isVisible - Tenant visibility check.
 * @returns An async function `(params) => Promise<Record<string, unknown> | null>`.
 *   Returns `null` when the transition guard fails or no matching record exists.
 */
export function transitionMemory(
  op: TransitionOpConfig,
  store: Map<string | number, MemoryEntry>,
  isAlive: (entry: MemoryEntry) => boolean,
  isVisible: (record: Record<string, unknown>) => boolean,
): (params: Record<string, unknown>) => Promise<Record<string, unknown> | null> {
  return params =>
    serializeOnStore(store, () => {
      const resolved = resolveParams(op.match, params);
      for (const entry of store.values()) {
        if (!isAlive(entry) || !isVisible(entry.record)) continue;
        let matches = true;
        for (const [field, target] of Object.entries(resolved)) {
          if (entry.record[field] !== target) {
            matches = false;
            break;
          }
        }
        if (!matches) continue;
        if (!matchesFrom(op, entry.record[op.field])) return Promise.resolve(null);
        resolveSetFields(op, entry.record, params);
        return Promise.resolve({ ...entry.record });
      }
      return Promise.resolve(null);
    });
}

// ---------------------------------------------------------------------------
// SQLite
// ---------------------------------------------------------------------------

/**
 * Create a transition executor for the SQLite store.
 *
 * Emits `UPDATE {table} SET {field}={to}, ... WHERE {match} AND {field}={from}`.
 * When `changes === 0` the guard failed and `null` is returned. On success, a
 * follow-up `SELECT` re-fetches the updated row.
 *
 * @param op - Transition operation config.
 * @param db - Bun SQLite database handle.
 * @param table - SQL table name.
 * @param ensureTable - Idempotent table-creation function.
 * @param fromRow - Converts a raw SQLite row to a canonical record.
 * @returns An async function `(params) => Promise<Record<string, unknown> | null>`.
 */
export function transitionSqlite(
  op: TransitionOpConfig,
  db: SqliteDb,
  table: string,
  ensureTable: () => void,
  fromRow: (row: Record<string, unknown>) => Record<string, unknown>,
): (params: Record<string, unknown>) => Promise<Record<string, unknown> | null> {
  const col = toSnakeCase(op.field);
  const matchEntries = Object.entries(op.match);

  return params => {
    ensureTable();
    const resolved = resolveParams(op.match, params);

    const setClauses = [`${col} = ?`];
    const setValues: unknown[] = [op.to];
    if (op.set) {
      for (const [f, v] of Object.entries(op.set)) {
        setClauses.push(`${toSnakeCase(f)} = ?`);
        if (v === 'now') setValues.push(Date.now());
        else if (typeof v === 'string' && v.startsWith('param:'))
          setValues.push(params[v.slice(6)]);
        else setValues.push(v);
      }
    }

    const whereParts = matchEntries.map(([f]) => `${toSnakeCase(f)} = ?`);
    const allowedFrom = fromValues(op);
    whereParts.push(
      allowedFrom.length === 1
        ? `${col} = ?`
        : `${col} IN (${allowedFrom.map(() => '?').join(', ')})`,
    );
    const whereValues = matchEntries.map(([f]) => resolved[f]);
    whereValues.push(...allowedFrom);

    const result = db.run(
      `UPDATE ${table} SET ${setClauses.join(', ')} WHERE ${whereParts.join(' AND ')}`,
      [...setValues, ...whereValues],
    );
    if (result.changes === 0) return Promise.resolve(null);

    const row = db
      .query<
        Record<string, unknown>
      >(`SELECT * FROM ${table} WHERE ${matchEntries.map(([f]) => `${toSnakeCase(f)} = ?`).join(' AND ')}`)
      .get(...matchEntries.map(([f]) => resolved[f]));
    return Promise.resolve(row ? fromRow(row) : null);
  };
}

// ---------------------------------------------------------------------------
// Postgres
// ---------------------------------------------------------------------------

/**
 * Create a transition executor for the Postgres store.
 *
 * Emits `UPDATE {table} SET {field}=$1, ... WHERE {match} AND {field}=${n} RETURNING *`.
 * Returns `null` when no rows are returned (guard failed or no match).
 *
 * @param op - Transition operation config.
 * @param pool - Postgres connection pool.
 * @param table - SQL table name.
 * @param ensureTable - Async idempotent table-creation function.
 * @param fromRow - Converts a raw Postgres row to a canonical record.
 * @returns An async function `(params) => Promise<Record<string, unknown> | null>`.
 */
export function transitionPostgres(
  op: TransitionOpConfig,
  pool: PgPool,
  table: string,
  ensureTable: () => Promise<void>,
  fromRow: (row: Record<string, unknown>) => Record<string, unknown>,
): (params: Record<string, unknown>) => Promise<Record<string, unknown> | null> {
  const col = toSnakeCase(op.field);
  const matchEntries = Object.entries(op.match);

  return async params => {
    await ensureTable();
    const resolved = resolveParams(op.match, params);

    let pIdx = 0;
    const setClauses = [`${col} = $${++pIdx}`];
    const values: unknown[] = [op.to];
    if (op.set) {
      for (const [f, v] of Object.entries(op.set)) {
        setClauses.push(`${toSnakeCase(f)} = $${++pIdx}`);
        if (v === 'now') values.push(new Date());
        else if (typeof v === 'string' && v.startsWith('param:')) values.push(params[v.slice(6)]);
        else values.push(v);
      }
    }

    const whereParts = matchEntries.map(([f]) => `${toSnakeCase(f)} = $${++pIdx}`);
    const allowedFrom = fromValues(op);
    if (allowedFrom.length === 1) {
      whereParts.push(`${col} = $${++pIdx}`);
      values.push(allowedFrom[0]);
    } else {
      const placeholders = allowedFrom.map(() => `$${++pIdx}`);
      whereParts.push(`${col} IN (${placeholders.join(', ')})`);
      values.push(...allowedFrom);
    }
    for (const [f] of matchEntries) values.push(resolved[f]);

    const result = await pool.query(
      `UPDATE ${table} SET ${setClauses.join(', ')} WHERE ${whereParts.join(' AND ')} RETURNING *`,
      values,
    );
    return result.rows[0] ? fromRow(result.rows[0]) : null;
  };
}

// ---------------------------------------------------------------------------
// Mongo
// ---------------------------------------------------------------------------

/**
 * Create a transition executor for the MongoDB store.
 *
 * Builds a query that includes both the match conditions and `{ [field]: from }`.
 * Calls `Model.updateOne(query, { $set: { [field]: to, ...sideEffects } })`. A
 * follow-up `findOne` (without the guard condition) retrieves the updated document.
 * Returns `null` when `findOne` produces no document.
 *
 * @param op - Transition operation config.
 * @param config - Resolved entity config (provides `fields` for PK detection).
 * @param getModel - Lazy getter returning the Mongoose model.
 * @param fromDoc - Converts a raw Mongoose lean doc to a canonical record.
 * @returns An async function `(params) => Promise<Record<string, unknown> | null>`.
 */
export function transitionMongo(
  op: TransitionOpConfig,
  config: ResolvedEntityConfig,
  getModel: () => MongoModel,
  fromDoc: (doc: Record<string, unknown>) => Record<string, unknown>,
): (params: Record<string, unknown>) => Promise<Record<string, unknown> | null> {
  return async params => {
    const resolved = resolveParams(op.match, params);
    const query: Record<string, unknown> = {};
    for (const [field, target] of Object.entries(resolved)) {
      query[config.fields[field].primary ? config._storageFields.mongoPkField : field] = target;
    }
    const allowedFrom = fromValues(op);
    query[op.field] = allowedFrom.length === 1 ? allowedFrom[0] : { $in: allowedFrom };

    const $set: Record<string, unknown> = { [op.field]: op.to };
    if (op.set) {
      for (const [f, v] of Object.entries(op.set)) {
        if (v === 'now') $set[f] = new Date();
        else if (typeof v === 'string' && v.startsWith('param:')) $set[f] = params[v.slice(6)];
        else $set[f] = v;
      }
    }

    const Model = getModel();
    const result = await Model.updateOne(query, { $set });
    if (!result.modifiedCount) return null;
    const fetchQuery = Object.fromEntries(Object.entries(query).filter(([k]) => k !== op.field));
    const doc = await Model.findOne(fetchQuery).lean();
    return doc ? fromDoc(doc) : null;
  };
}

// ---------------------------------------------------------------------------
// Redis
// ---------------------------------------------------------------------------

/**
 * Create a transition executor for the Redis store.
 *
 * Scans all keys, deserialises each record, applies visibility and match checks.
 * When a matching record is found, verifies the guard (`record[op.field] === op.from`).
 * If the guard fails, returns `null` immediately. If it passes, applies the transition
 * and side-effect fields, writes back via `storeRecord`, and returns the updated record.
 *
 * @param op - Transition operation config.
 * @param redis - ioredis client instance.
 * @param scanAllKeys - Returns all key strings for this entity's key space.
 * @param isVisible - Tenant visibility check.
 * @param fromRedisRecord - Deserialises a raw Redis record into the canonical shape.
 * @param storeRecord - Serialises and writes the updated record back to Redis.
 * @returns An async function `(params) => Promise<Record<string, unknown> | null>`.
 */
export function transitionRedis(
  op: TransitionOpConfig,
  redis: RedisClient,
  scanAllKeys: () => Promise<string[]>,
  isVisible: (record: Record<string, unknown>) => boolean,
  fromRedisRecord: (raw: Record<string, unknown>) => Record<string, unknown>,
  storeRecord: (record: Record<string, unknown>) => Promise<void>,
): (params: Record<string, unknown>) => Promise<Record<string, unknown> | null> {
  return async params => {
    const resolved = resolveParams(op.match, params);
    const allKeys = await scanAllKeys();
    for (const key of allKeys) {
      const raw = await redis.get(key);
      if (!raw) continue;
      const record = fromRedisRecord(JSON.parse(raw) as Record<string, unknown>);
      if (!isVisible(record)) continue;
      let matches = true;
      for (const [field, target] of Object.entries(resolved)) {
        if (record[field] !== target) {
          matches = false;
          break;
        }
      }
      if (!matches) continue;
      if (!matchesFrom(op, record[op.field])) return null;
      resolveSetFields(op, record, params);
      await storeRecord(record);
      return { ...record };
    }
    return null;
  };
}
