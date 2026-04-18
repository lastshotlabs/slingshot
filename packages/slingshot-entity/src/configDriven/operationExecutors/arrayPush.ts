/**
 * Runtime executor: op.arrayPush — append a value to an array field on a specific record.
 *
 * The record is identified by its primary key. When `dedupe` is true (the default),
 * the value is only appended if it is not already present — making the operation
 * idempotent. Returns the updated entity record.
 *
 * The `value` binding (`ctx:key`, `param:key`, `input:key`, literal) is resolved
 * at the HTTP layer before the executor is called; the executor receives the resolved
 * value directly as its second argument.
 */
import type { ArrayPushOpConfig, ResolvedEntityConfig } from '@lastshotlabs/slingshot-core';
import { toSnakeCase } from '../fieldUtils';
import type { MemoryEntry, MongoModel, PgPool, RedisClient, SqliteDb } from './dbInterfaces';
import { withOptionalPostgresTransaction } from './postgresTransaction';

// ---------------------------------------------------------------------------
// Memory
// ---------------------------------------------------------------------------

export function arrayPushMemory(
  op: ArrayPushOpConfig,
  config: ResolvedEntityConfig,
  store: Map<string | number, MemoryEntry>,
  isAlive: (entry: MemoryEntry) => boolean,
  isVisible: (record: Record<string, unknown>) => boolean,
): (id: unknown, value: unknown) => Promise<Record<string, unknown>> {
  const dedupe = op.dedupe !== false;
  return (id, value) => {
    const entry = store.get(String(id));
    if (!entry || !isAlive(entry) || !isVisible(entry.record)) {
      throw new Error(`[${config.name}] Not found`);
    }
    const current = Array.isArray(entry.record[op.field])
      ? (entry.record[op.field] as unknown[])
      : [];
    if (dedupe && current.includes(value)) {
      return Promise.resolve({ ...entry.record });
    }
    entry.record[op.field] = [...current, value];
    return Promise.resolve({ ...entry.record });
  };
}

// ---------------------------------------------------------------------------
// SQLite
// ---------------------------------------------------------------------------

export function arrayPushSqlite(
  op: ArrayPushOpConfig,
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
    const row = db
      .query<Record<string, unknown>>(`SELECT * FROM ${table} WHERE ${pkCol} = ?`)
      .get(id);
    if (!row) throw new Error(`[${config.name}] Not found`);
    const rawVal = row[snakeField];
    const current: unknown[] = Array.isArray(rawVal)
      ? [...(rawVal as unknown[])]
      : typeof rawVal === 'string'
        ? (JSON.parse(rawVal) as unknown[])
        : [];
    if (dedupe && current.includes(value)) {
      return Promise.resolve(fromRow(row));
    }
    current.push(value);
    db.run(`UPDATE ${table} SET ${snakeField} = ? WHERE ${pkCol} = ?`, [
      JSON.stringify(current),
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

export function arrayPushPostgres(
  op: ArrayPushOpConfig,
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
    return withOptionalPostgresTransaction(pool, async queryable => {
      const sel = await queryable.query(`SELECT * FROM ${table} WHERE ${pkCol} = $1 FOR UPDATE`, [
        id,
      ]);
      if (!sel.rows[0]) throw new Error(`[${config.name}] Not found`);
      const rawVal = sel.rows[0][snakeField];
      const current: unknown[] = Array.isArray(rawVal)
        ? [...(rawVal as unknown[])]
        : typeof rawVal === 'string'
          ? (JSON.parse(rawVal) as unknown[])
          : [];
      if (dedupe && current.includes(value)) {
        return fromRow(sel.rows[0]);
      }
      current.push(value);
      const serialized = isNativeArray ? current : JSON.stringify(current);
      const result = await queryable.query(
        `UPDATE ${table} SET ${snakeField} = $2 WHERE ${pkCol} = $1 RETURNING *`,
        [id, serialized],
      );
      if (!result.rows[0]) throw new Error(`[${config.name}] Not found`);
      return fromRow(result.rows[0]);
    });
  };
}

// ---------------------------------------------------------------------------
// MongoDB
// ---------------------------------------------------------------------------

export function arrayPushMongo(
  op: ArrayPushOpConfig,
  config: ResolvedEntityConfig,
  getModel: () => MongoModel,
  fromDoc: (doc: Record<string, unknown>) => Record<string, unknown>,
): (id: unknown, value: unknown) => Promise<Record<string, unknown>> {
  const dedupe = op.dedupe !== false;
  return async (id, value) => {
    const Model = getModel();
    const arrayOp = dedupe ? '$addToSet' : '$push';
    await Model.updateOne({ _id: id }, { [arrayOp]: { [op.field]: value } });
    const doc = await Model.findOne({ _id: id }).lean();
    if (!doc) throw new Error(`[${config.name}] Not found`);
    return fromDoc(doc);
  };
}

// ---------------------------------------------------------------------------
// Redis
// ---------------------------------------------------------------------------

export function arrayPushRedis(
  op: ArrayPushOpConfig,
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
    const allKeys = await scanAllKeys();
    for (const key of allKeys) {
      const raw = await redis.get(key);
      if (!raw) continue;
      const record = fromRedisRecord(JSON.parse(raw) as Record<string, unknown>);
      if (!isVisible(record)) continue;
      if (record[pkField] !== id && String(record[pkField]) !== String(id)) continue;
      const current = Array.isArray(record[op.field]) ? [...(record[op.field] as unknown[])] : [];
      if (dedupe && current.includes(value)) {
        return { ...record };
      }
      current.push(value);
      record[op.field] = current;
      await storeRecord(record);
      return { ...record };
    }
    throw new Error(`[${config.name}] Not found`);
  };
}
