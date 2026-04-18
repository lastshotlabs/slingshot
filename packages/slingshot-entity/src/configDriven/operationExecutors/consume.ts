/**
 * Runtime executor: op.consume — atomic find + remove (one-time-use tokens).
 */
import type { ConsumeOpConfig, ResolvedEntityConfig } from '@lastshotlabs/slingshot-core';
import { toSnakeCase } from '../fieldUtils';
import { evaluateFilter } from '../filterEvaluator';
import type { MemoryEntry, MongoModel, PgPool, RedisClient, SqliteDb } from './dbInterfaces';

function checkExpiry(record: Record<string, unknown>, expiryField: string | undefined): boolean {
  if (!expiryField) return true;
  const val = record[expiryField];
  if (val == null) return true;
  return val > new Date();
}

// ---------------------------------------------------------------------------
// Memory
// ---------------------------------------------------------------------------

export function consumeMemory(
  op: ConsumeOpConfig,
  store: Map<string | number, MemoryEntry>,
  isAlive: (entry: MemoryEntry) => boolean,
): (params: Record<string, unknown>) => Promise<Record<string, unknown> | boolean | null> {
  const returnsBool = op.returns === 'boolean';
  const expiryField = op.expiry?.field;
  return params => {
    for (const [pk, entry] of store) {
      if (!isAlive(entry)) continue;
      if (!evaluateFilter(entry.record, op.filter, params)) continue;
      if (!checkExpiry(entry.record, expiryField)) continue;
      store.delete(pk);
      return Promise.resolve(returnsBool ? true : { ...entry.record });
    }
    return Promise.resolve(returnsBool ? false : null);
  };
}

// ---------------------------------------------------------------------------
// SQLite
// ---------------------------------------------------------------------------

export function consumeSqlite(
  op: ConsumeOpConfig,
  config: ResolvedEntityConfig,
  db: SqliteDb,
  table: string,
  ensureTable: () => void,
  fromRow: (row: Record<string, unknown>) => Record<string, unknown>,
): (params: Record<string, unknown>) => Promise<Record<string, unknown> | boolean | null> {
  const returnsBool = op.returns === 'boolean';
  const pkCol = toSnakeCase(config._pkField);
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
      } else {
        conditions.push(`${col} = ?`);
        bindValues.push(value);
      }
    }
    if (op.expiry) {
      conditions.push(
        `(${toSnakeCase(op.expiry.field)} IS NULL OR ${toSnakeCase(op.expiry.field)} > ?)`,
      );
      bindValues.push(Date.now());
    }
    const where = conditions.join(' AND ');
    const row = db
      .query<Record<string, unknown>>(`SELECT * FROM ${table} WHERE ${where} LIMIT 1`)
      .get(...bindValues);
    if (!row) return Promise.resolve(returnsBool ? false : null);
    db.run(`DELETE FROM ${table} WHERE ${pkCol} = ?`, [row[pkCol]]);
    return Promise.resolve(returnsBool ? true : fromRow(row));
  };
}

// ---------------------------------------------------------------------------
// Postgres
// ---------------------------------------------------------------------------

export function consumePostgres(
  op: ConsumeOpConfig,
  config: ResolvedEntityConfig,
  pool: PgPool,
  table: string,
  ensureTable: () => Promise<void>,
  fromRow: (row: Record<string, unknown>) => Record<string, unknown>,
): (params: Record<string, unknown>) => Promise<Record<string, unknown> | boolean | null> {
  const returnsBool = op.returns === 'boolean';
  return async params => {
    await ensureTable();
    const conditions: string[] = [];
    const bindValues: unknown[] = [];
    for (const [key, value] of Object.entries(op.filter)) {
      if (key === '$and' || key === '$or') continue;
      const col = toSnakeCase(key);
      if (typeof value === 'string' && value.startsWith('param:')) {
        bindValues.push(params[value.slice(6)]);
        conditions.push(`${col} = $${bindValues.length}`);
      } else {
        bindValues.push(value);
        conditions.push(`${col} = $${bindValues.length}`);
      }
    }
    if (op.expiry) {
      bindValues.push(new Date());
      conditions.push(
        `(${toSnakeCase(op.expiry.field)} IS NULL OR ${toSnakeCase(op.expiry.field)} > $${bindValues.length})`,
      );
    }
    const where = conditions.join(' AND ');
    const result = await pool.query(`DELETE FROM ${table} WHERE ${where} RETURNING *`, bindValues);
    if (result.rows.length === 0) return returnsBool ? false : null;
    return returnsBool ? true : fromRow(result.rows[0]);
  };
}

// ---------------------------------------------------------------------------
// Mongo
// ---------------------------------------------------------------------------

export function consumeMongo(
  op: ConsumeOpConfig,
  getModel: () => MongoModel,
  fromDoc: (doc: Record<string, unknown>) => Record<string, unknown>,
): (params: Record<string, unknown>) => Promise<Record<string, unknown> | boolean | null> {
  const returnsBool = op.returns === 'boolean';
  return async params => {
    const query: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(op.filter)) {
      if (key === '$and' || key === '$or') continue;
      query[key] =
        typeof value === 'string' && value.startsWith('param:') ? params[value.slice(6)] : value;
    }
    if (op.expiry) {
      query[op.expiry.field] = { $gt: new Date() };
    }
    const Model = getModel();
    const doc = await Model.findOne(query).lean();
    if (!doc) return returnsBool ? false : null;
    await Model.deleteOne({ _id: doc._id });
    return returnsBool ? true : fromDoc(doc);
  };
}

// ---------------------------------------------------------------------------
// Redis
// ---------------------------------------------------------------------------

export function consumeRedis(
  op: ConsumeOpConfig,
  redis: RedisClient,
  scanAllKeys: () => Promise<string[]>,
  fromRedisRecord: (raw: Record<string, unknown>) => Record<string, unknown>,
): (params: Record<string, unknown>) => Promise<Record<string, unknown> | boolean | null> {
  const returnsBool = op.returns === 'boolean';
  const expiryField = op.expiry?.field;
  return async params => {
    const allKeys = await scanAllKeys();
    for (const key of allKeys) {
      const raw = await redis.get(key);
      if (!raw) continue;
      const record = fromRedisRecord(JSON.parse(raw) as Record<string, unknown>);
      if (!evaluateFilter(record, op.filter, params)) continue;
      if (!checkExpiry(record, expiryField)) continue;
      await redis.del(key);
      return returnsBool ? true : { ...record };
    }
    return returnsBool ? false : null;
  };
}
