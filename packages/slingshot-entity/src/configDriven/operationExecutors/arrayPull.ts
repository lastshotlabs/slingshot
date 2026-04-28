/**
 * Runtime executor: op.arrayPull — remove all occurrences of a value from an array field.
 *
 * The record is identified by its primary key. All occurrences of `value` are
 * removed from the target array field. Returns the updated entity record.
 *
 * The `value` binding is resolved at the HTTP layer before the executor is called.
 */
import type { ArrayPullOpConfig, ResolvedEntityConfig } from '@lastshotlabs/slingshot-core';
import { toSnakeCase } from '../fieldUtils';
import type { MemoryEntry, MongoModel, PgPool, RedisClient, SqliteDb } from './dbInterfaces';
import { serializeOnStore } from './memoryMutex';
import { withOptionalPostgresTransaction } from './postgresTransaction';

// ---------------------------------------------------------------------------
// Memory
// ---------------------------------------------------------------------------

export function arrayPullMemory(
  op: ArrayPullOpConfig,
  config: ResolvedEntityConfig,
  store: Map<string | number, MemoryEntry>,
  isAlive: (entry: MemoryEntry) => boolean,
  isVisible: (record: Record<string, unknown>) => boolean,
): (id: unknown, value: unknown) => Promise<Record<string, unknown>> {
  return (id, value) =>
    serializeOnStore(store, () => {
      const entry = store.get(String(id));
      if (!entry || !isAlive(entry) || !isVisible(entry.record)) {
        return Promise.reject(new Error(`[${config.name}] Not found`));
      }
      const current = Array.isArray(entry.record[op.field])
        ? (entry.record[op.field] as unknown[]).filter(v => v !== value)
        : [];
      entry.record[op.field] = current;
      return Promise.resolve({ ...entry.record });
    });
}

// ---------------------------------------------------------------------------
// SQLite
// ---------------------------------------------------------------------------

export function arrayPullSqlite(
  op: ArrayPullOpConfig,
  config: ResolvedEntityConfig,
  db: SqliteDb,
  table: string,
  ensureTable: () => void,
  fromRow: (row: Record<string, unknown>) => Record<string, unknown>,
): (id: unknown, value: unknown) => Promise<Record<string, unknown>> {
  const pkCol = toSnakeCase(config._pkField);
  const snakeField = toSnakeCase(op.field);
  return (id, value) => {
    ensureTable();
    const row = db
      .query<Record<string, unknown>>(`SELECT * FROM ${table} WHERE ${pkCol} = ?`)
      .get(id);
    if (!row) throw new Error(`[${config.name}] Not found`);
    const rawVal = row[snakeField];
    const current: unknown[] = Array.isArray(rawVal)
      ? rawVal
      : typeof rawVal === 'string'
        ? (JSON.parse(rawVal) as unknown[])
        : [];
    const updated = current.filter(v => v !== value);
    db.run(`UPDATE ${table} SET ${snakeField} = ? WHERE ${pkCol} = ?`, [
      JSON.stringify(updated),
      id,
    ]);
    const updatedRow = db
      .query<Record<string, unknown>>(`SELECT * FROM ${table} WHERE ${pkCol} = ?`)
      .get(id);
    if (!updatedRow) throw new Error(`[${config.name}] Not found`);
    return Promise.resolve(fromRow(updatedRow));
  };
}

// ---------------------------------------------------------------------------
// Postgres
// ---------------------------------------------------------------------------

export function arrayPullPostgres(
  op: ArrayPullOpConfig,
  config: ResolvedEntityConfig,
  pool: PgPool,
  table: string,
  ensureTable: () => Promise<void>,
  fromRow: (row: Record<string, unknown>) => Record<string, unknown>,
): (id: unknown, value: unknown) => Promise<Record<string, unknown>> {
  const pkCol = toSnakeCase(config._pkField);
  const snakeField = toSnakeCase(op.field);
  const isNativeArray = config.fields[op.field].type === 'string[]';
  return async (id, value) => {
    await ensureTable();
    return withOptionalPostgresTransaction(pool, async queryable => {
      const sel = await queryable.query(`SELECT * FROM ${table} WHERE ${pkCol} = $1 FOR UPDATE`, [
        id,
      ]);
      if (!sel.rows[0]) throw new Error(`[${config.name}] Not found`);
      const rawVal = sel.rows[0][snakeField];
      const current: unknown[] = Array.isArray(rawVal)
        ? rawVal
        : typeof rawVal === 'string'
          ? (JSON.parse(rawVal) as unknown[])
          : [];
      const updated = current.filter(v => v !== value);
      const serialized = isNativeArray ? updated : JSON.stringify(updated);
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

export function arrayPullMongo(
  op: ArrayPullOpConfig,
  config: ResolvedEntityConfig,
  getModel: () => MongoModel,
  fromDoc: (doc: Record<string, unknown>) => Record<string, unknown>,
): (id: unknown, value: unknown) => Promise<Record<string, unknown>> {
  return async (id, value) => {
    const Model = getModel();
    const pkField = config._storageFields.mongoPkField;
    await Model.updateOne({ [pkField]: id }, { $pull: { [op.field]: value } });
    const doc = await Model.findOne({ [pkField]: id }).lean();
    if (!doc) throw new Error(`[${config.name}] Not found`);
    return fromDoc(doc);
  };
}

// ---------------------------------------------------------------------------
// Redis
// ---------------------------------------------------------------------------

export function arrayPullRedis(
  op: ArrayPullOpConfig,
  config: ResolvedEntityConfig,
  redis: RedisClient,
  scanAllKeys: () => Promise<string[]>,
  isVisible: (record: Record<string, unknown>) => boolean,
  fromRedisRecord: (raw: Record<string, unknown>) => Record<string, unknown>,
  storeRecord: (record: Record<string, unknown>) => Promise<void>,
): (id: unknown, value: unknown) => Promise<Record<string, unknown>> {
  const pkField = config._pkField;
  return async (id, value) => {
    const allKeys = await scanAllKeys();
    for (const key of allKeys) {
      const raw = await redis.get(key);
      if (!raw) continue;
      const record = fromRedisRecord(JSON.parse(raw) as Record<string, unknown>);
      if (!isVisible(record)) continue;
      if (record[pkField] !== id && String(record[pkField]) !== String(id)) continue;
      const current = Array.isArray(record[op.field])
        ? (record[op.field] as unknown[]).filter(v => v !== value)
        : [];
      record[op.field] = current;
      await storeRecord(record);
      return { ...record };
    }
    throw new Error(`[${config.name}] Not found`);
  };
}
