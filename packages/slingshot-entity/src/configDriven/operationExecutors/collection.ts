/**
 * Runtime executor: `op.collection` — CRUD on a sub-entity list scoped to a parent record.
 *
 * Each exported function is a per-backend factory returning a {@link CollectionResult}
 * object. The result contains only the operation methods listed in `op.operations`
 * (`list`, `add`, `remove`, `update`, `set`).
 *
 * **Storage strategy per backend:**
 * - Memory: isolated `Map<parentId, item[]>` per collection op.
 * - SQLite: a separate junction table `{parentTable}_{opName}` with a `parentKey` column.
 *   The table is created lazily (`ensureTable`) on first access.
 * - Postgres: same junction-table model as SQLite with `$N` placeholders.
 * - Mongo: embedded array on the parent document (`$push`, `$pull`, `$pop`, positional
 *   array filters). The array field name matches `opName`.
 * - Redis: a separate Redis key per parent — `{prefix}collection:{opName}:{parentId}` —
 *   storing the full items array as a JSON string.
 *
 * **`maxItems` enforcement:** When configured, adding a new item beyond the cap removes
 * the oldest item (shift for memory/Redis, `DELETE ... ORDER BY rowid ASC LIMIT 1` for
 * SQLite, `$pop: -1` for Mongo, no built-in enforcement for Postgres `add`).
 *
 * **`identifyBy`:** The field used to find items within the collection for `remove` and
 * `update` operations. Defaults to `'id'`.
 *
 * **Error behavior:** `update` throws `Error('[EntityName] Collection item not found')`
 * when the target item does not exist.
 */
import type { CollectionOpConfig, ResolvedEntityConfig } from '@lastshotlabs/slingshot-core';
import { toSnakeCase } from '../fieldUtils';
import type { MongoModel, PgPool, RedisClient, SqliteDb } from './dbInterfaces';
import { withOptionalPostgresTransaction } from './postgresTransaction';

/**
 * The per-operation method bag returned by each `collection*` factory.
 *
 * Only methods corresponding to the `op.operations` array are populated.
 * Callers must check for presence before calling (the type reflects this with `?`).
 *
 * - `list` — return all items for the given parent.
 * - `add` — append an item to the collection (respects `maxItems` cap).
 * - `remove` — remove the item identified by `identifyValue` (matched on `identifyBy` field).
 * - `update` — apply partial `updates` to the item identified by `identifyValue`.
 * - `set` — atomically replace the entire collection for the given parent.
 */
export interface CollectionResult {
  /** Return all items owned by `parentId`. */
  list?: (parentId: string | number) => Promise<Array<Record<string, unknown>>>;
  /**
   * Append `item` to the collection for `parentId`.
   * When `maxItems` is set and the cap is reached, the oldest item is removed first.
   * @returns The inserted item (shallow copy).
   */
  add?: (
    parentId: string | number,
    item: Record<string, unknown>,
  ) => Promise<Record<string, unknown>>;
  /** Remove the item whose `identifyBy` field equals `identifyValue`. */
  remove?: (parentId: string | number, identifyValue: unknown) => Promise<void>;
  /**
   * Apply `updates` to the item identified by `identifyValue`.
   * @throws If no item with that `identifyValue` exists.
   * @returns The full updated item (shallow copy).
   */
  update?: (
    parentId: string | number,
    identifyValue: unknown,
    updates: Record<string, unknown>,
  ) => Promise<Record<string, unknown>>;
  /** Replace the entire collection for `parentId` with `items`. */
  set?: (parentId: string | number, items: Array<Record<string, unknown>>) => Promise<void>;
}

// ---------------------------------------------------------------------------
// Memory
// ---------------------------------------------------------------------------

/**
 * Create a collection executor for the in-memory store.
 *
 * Maintains a private `Map<parentId, item[]>` — entirely separate from the parent
 * entity's store. All operations act on shallow copies of items to prevent external
 * mutation of stored data.
 *
 * @param opName - The operation name (used as a logging/error label).
 * @param op - Collection operation config including `operations`, `identifyBy`,
 *   `itemFields`, `parentKey`, and optional `maxItems`.
 * @param config - Resolved entity config (used for error messages).
 * @returns A {@link CollectionResult} with only the requested operation methods populated.
 */
export function collectionMemory(
  opName: string,
  op: CollectionOpConfig,
  config: ResolvedEntityConfig,
): CollectionResult {
  const result: CollectionResult = {};
  const idField = op.identifyBy ?? 'id';
  const store = new Map<string | number, Array<Record<string, unknown>>>();

  function getItems(parentId: string | number): Array<Record<string, unknown>> {
    return store.get(parentId) ?? [];
  }
  function setItems(parentId: string | number, items: Array<Record<string, unknown>>): void {
    store.set(parentId, items);
  }

  if (op.operations.includes('list')) {
    result.list = parentId => Promise.resolve([...getItems(parentId)]);
  }
  if (op.operations.includes('add')) {
    result.add = (parentId, item) => {
      const items = getItems(parentId);
      if (op.maxItems) {
        const max = typeof op.maxItems === 'number' ? op.maxItems : Number(op.maxItems);
        if (items.length >= max) items.shift();
      }
      items.push({ ...item });
      setItems(parentId, items);
      return Promise.resolve({ ...item });
    };
  }
  if (op.operations.includes('remove')) {
    result.remove = (parentId, identifyValue) => {
      setItems(
        parentId,
        getItems(parentId).filter(i => i[idField] !== identifyValue),
      );
      return Promise.resolve();
    };
  }
  if (op.operations.includes('update')) {
    result.update = (parentId, identifyValue, updates) => {
      const items = getItems(parentId);
      const item = items.find(i => i[idField] === identifyValue);
      if (!item) throw new Error(`[${config.name}] Collection item not found`);
      Object.assign(item, updates);
      setItems(parentId, items);
      return Promise.resolve({ ...item });
    };
  }
  if (op.operations.includes('set')) {
    result.set = (parentId, items) => {
      setItems(
        parentId,
        items.map(i => ({ ...i })),
      );
      return Promise.resolve();
    };
  }

  return result;
}

// ---------------------------------------------------------------------------
// SQLite
// ---------------------------------------------------------------------------

/**
 * Create a collection executor for the SQLite store.
 *
 * Uses a dedicated junction table named `{parentTable}_{opName}`. The table is
 * created lazily via `ensureTable()` (which first calls `ensureParentTable()`).
 * Column types are derived from `op.itemFields` type descriptors.
 *
 * The `set` operation is implemented as a `DELETE ... WHERE parentKey = ?` followed
 * by individual `INSERT` statements — not wrapped in an explicit transaction.
 *
 * @param opName - Operation name — used as the junction table suffix.
 * @param op - Collection operation config.
 * @param config - Resolved entity config.
 * @param db - Bun SQLite database handle.
 * @param parentTable - The parent entity's table name.
 * @param ensureParentTable - Idempotent function that creates the parent table if absent.
 * @returns A {@link CollectionResult} with only the requested operation methods populated.
 */
export function collectionSqlite(
  opName: string,
  op: CollectionOpConfig,
  config: ResolvedEntityConfig,
  db: SqliteDb,
  parentTable: string,
  ensureParentTable: () => void,
): CollectionResult {
  const result: CollectionResult = {};
  const idField = op.identifyBy ?? 'id';
  const parentKeyCol = toSnakeCase(op.parentKey);
  const idCol = toSnakeCase(idField);
  const table = `${parentTable}_${opName}`;
  let initialized = false;

  function ensureTable(): void {
    if (initialized) return;
    ensureParentTable();
    const cols: string[] = [`${parentKeyCol} TEXT NOT NULL`];
    for (const [name, def] of Object.entries(op.itemFields)) {
      const col = toSnakeCase(name);
      const sqlType =
        def.type === 'integer'
          ? 'INTEGER'
          : def.type === 'number'
            ? 'REAL'
            : def.type === 'boolean'
              ? 'INTEGER'
              : 'TEXT';
      cols.push(`${col} ${sqlType}`);
    }
    db.run(`CREATE TABLE IF NOT EXISTS ${table} (${cols.join(', ')})`);
    initialized = true;
  }

  function rowToItem(row: Record<string, unknown>): Record<string, unknown> {
    const item: Record<string, unknown> = {};
    for (const name of Object.keys(op.itemFields)) {
      item[name] = row[toSnakeCase(name)];
    }
    return item;
  }

  if (op.operations.includes('list')) {
    result.list = parentId => {
      ensureTable();
      const rows = db
        .query<Record<string, unknown>>(`SELECT * FROM ${table} WHERE ${parentKeyCol} = ?`)
        .all(parentId);
      return Promise.resolve(rows.map(rowToItem));
    };
  }
  if (op.operations.includes('add')) {
    result.add = (parentId, item) => {
      ensureTable();
      if (op.maxItems) {
        const max = typeof op.maxItems === 'number' ? op.maxItems : Number(op.maxItems);
        const count = db
          .query<
            Record<string, unknown>
          >(`SELECT COUNT(*) as cnt FROM ${table} WHERE ${parentKeyCol} = ?`)
          .get(parentId);
        if (count && Number(count.cnt) >= max) {
          db.run(
            `DELETE FROM ${table} WHERE rowid IN (SELECT rowid FROM ${table} WHERE ${parentKeyCol} = ? ORDER BY rowid ASC LIMIT 1)`,
            [parentId],
          );
        }
      }
      const cols = [parentKeyCol, ...Object.keys(op.itemFields).map(n => toSnakeCase(n))];
      const vals = [parentId, ...Object.keys(op.itemFields).map(n => item[n])];
      db.run(
        `INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`,
        vals,
      );
      return Promise.resolve({ ...item });
    };
  }
  if (op.operations.includes('remove')) {
    result.remove = (parentId, identifyValue) => {
      ensureTable();
      db.run(`DELETE FROM ${table} WHERE ${parentKeyCol} = ? AND ${idCol} = ?`, [
        parentId,
        identifyValue,
      ]);
      return Promise.resolve();
    };
  }
  if (op.operations.includes('update')) {
    result.update = (parentId, identifyValue, updates) => {
      ensureTable();
      const setClauses: string[] = [];
      const values: unknown[] = [];
      for (const [name, val] of Object.entries(updates)) {
        if (name in op.itemFields) {
          setClauses.push(`${toSnakeCase(name)} = ?`);
          values.push(val);
        }
      }
      if (setClauses.length > 0) {
        db.run(
          `UPDATE ${table} SET ${setClauses.join(', ')} WHERE ${parentKeyCol} = ? AND ${idCol} = ?`,
          [...values, parentId, identifyValue],
        );
      }
      const row = db
        .query<
          Record<string, unknown>
        >(`SELECT * FROM ${table} WHERE ${parentKeyCol} = ? AND ${idCol} = ?`)
        .get(parentId, identifyValue);
      if (!row) throw new Error(`[${config.name}] Collection item not found`);
      return Promise.resolve(rowToItem(row));
    };
  }
  if (op.operations.includes('set')) {
    result.set = (parentId, items) => {
      ensureTable();
      db.run(`DELETE FROM ${table} WHERE ${parentKeyCol} = ?`, [parentId]);
      for (const item of items) {
        const cols = [parentKeyCol, ...Object.keys(op.itemFields).map(n => toSnakeCase(n))];
        const vals = [parentId, ...Object.keys(op.itemFields).map(n => item[n])];
        db.run(
          `INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`,
          vals,
        );
      }
      return Promise.resolve();
    };
  }

  return result;
}

// ---------------------------------------------------------------------------
// Postgres
// ---------------------------------------------------------------------------

/**
 * Create a collection executor for the Postgres store.
 *
 * Equivalent to the SQLite executor but uses a `pg` connection pool and `$N`
 * positional parameters. Postgres-specific type mapping applies
 * (`BOOLEAN`, `TIMESTAMPTZ`, `NUMERIC` instead of SQLite `INTEGER`/`REAL`/`TEXT`).
 * Table creation is awaited asynchronously; all operations `await ensureTable()`.
 *
 * @param opName - Operation name — used as the junction table suffix.
 * @param op - Collection operation config.
 * @param config - Resolved entity config.
 * @param pool - Postgres connection pool.
 * @param parentTable - The parent entity's table name.
 * @param ensureParentTable - Async idempotent function that creates the parent table.
 * @returns A {@link CollectionResult} with only the requested operation methods populated.
 */
export function collectionPostgres(
  opName: string,
  op: CollectionOpConfig,
  config: ResolvedEntityConfig,
  pool: PgPool,
  parentTable: string,
  ensureParentTable: () => Promise<void>,
): CollectionResult {
  const result: CollectionResult = {};
  const idField = op.identifyBy ?? 'id';
  const parentKeyCol = toSnakeCase(op.parentKey);
  const idCol = toSnakeCase(idField);
  const table = `${parentTable}_${opName}`;
  let initialized = false;

  async function ensureTable(): Promise<void> {
    if (initialized) return;
    await ensureParentTable();
    const cols: string[] = [`${parentKeyCol} TEXT NOT NULL`];
    for (const [name, def] of Object.entries(op.itemFields)) {
      const col = toSnakeCase(name);
      const pgType =
        def.type === 'integer'
          ? 'INTEGER'
          : def.type === 'number'
            ? 'NUMERIC'
            : def.type === 'boolean'
              ? 'BOOLEAN'
              : def.type === 'date'
                ? 'TIMESTAMPTZ'
                : 'TEXT';
      cols.push(`${col} ${pgType}`);
    }
    await pool.query(`CREATE TABLE IF NOT EXISTS ${table} (${cols.join(', ')})`);
    initialized = true;
  }

  function rowToItem(row: Record<string, unknown>): Record<string, unknown> {
    const item: Record<string, unknown> = {};
    for (const name of Object.keys(op.itemFields)) {
      item[name] = row[toSnakeCase(name)];
    }
    return item;
  }

  if (op.operations.includes('list')) {
    result.list = async parentId => {
      await ensureTable();
      const res = await pool.query(`SELECT * FROM ${table} WHERE ${parentKeyCol} = $1`, [parentId]);
      return res.rows.map(rowToItem);
    };
  }
  if (op.operations.includes('add')) {
    result.add = async (parentId, item) => {
      await ensureTable();
      const cols = [parentKeyCol, ...Object.keys(op.itemFields).map(n => toSnakeCase(n))];
      const vals = [parentId, ...Object.keys(op.itemFields).map(n => item[n])];
      await pool.query(
        `INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')})`,
        vals,
      );
      return { ...item };
    };
  }
  if (op.operations.includes('remove')) {
    result.remove = async (parentId, identifyValue) => {
      await ensureTable();
      await pool.query(`DELETE FROM ${table} WHERE ${parentKeyCol} = $1 AND ${idCol} = $2`, [
        parentId,
        identifyValue,
      ]);
    };
  }
  if (op.operations.includes('update')) {
    result.update = async (parentId, identifyValue, updates) => {
      await ensureTable();
      const setClauses: string[] = [];
      const values: unknown[] = [];
      let pIdx = 0;
      for (const [name, val] of Object.entries(updates)) {
        if (name in op.itemFields) {
          setClauses.push(`${toSnakeCase(name)} = $${++pIdx}`);
          values.push(val);
        }
      }
      if (setClauses.length > 0) {
        values.push(parentId, identifyValue);
        const parentPIdx = pIdx + 1;
        const idPIdx = pIdx + 2;
        await pool.query(
          `UPDATE ${table} SET ${setClauses.join(', ')} WHERE ${parentKeyCol} = $${parentPIdx} AND ${idCol} = $${idPIdx}`,
          values,
        );
      }
      const res = await pool.query(
        `SELECT * FROM ${table} WHERE ${parentKeyCol} = $1 AND ${idCol} = $2`,
        [parentId, identifyValue],
      );
      if (!res.rows[0]) throw new Error(`[${config.name}] Collection item not found`);
      return rowToItem(res.rows[0]);
    };
  }
  if (op.operations.includes('set')) {
    result.set = async (parentId, items) => {
      await ensureTable();
      await withOptionalPostgresTransaction(pool, async queryable => {
        await queryable.query(`DELETE FROM ${table} WHERE ${parentKeyCol} = $1`, [parentId]);
        for (const item of items) {
          const cols = [parentKeyCol, ...Object.keys(op.itemFields).map(n => toSnakeCase(n))];
          const vals = [parentId, ...Object.keys(op.itemFields).map(n => item[n])];
          await queryable.query(
            `INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')})`,
            vals,
          );
        }
      });
    };
  }

  return result;
}

// ---------------------------------------------------------------------------
// Mongo — embedded array on parent document
// ---------------------------------------------------------------------------

/**
 * Create a collection executor for the MongoDB store.
 *
 * Items are stored as an embedded array on the parent document. The array field
 * name is `opName`. Operations use Mongoose update operators:
 * - `add`: `$push` (with optional `$pop: -1` to enforce `maxItems`).
 * - `remove`: `$pull` with the `identifyBy` field as the filter.
 * - `update`: `$set` with positional array filter `[elem.<identifyBy>]`.
 * - `set`: `$set` replacing the entire embedded array.
 * - `list`: `findOne().lean()` returning the array field.
 *
 * @param opName - Operation name — used as the embedded array field name.
 * @param op - Collection operation config.
 * @param config - Resolved entity config (provides `_pkField` for query construction).
 * @param getModel - Lazy getter returning the Mongoose model.
 * @returns A {@link CollectionResult} with only the requested operation methods populated.
 */
export function collectionMongo(
  opName: string,
  op: CollectionOpConfig,
  config: ResolvedEntityConfig,
  getModel: () => MongoModel,
): CollectionResult {
  const result: CollectionResult = {};
  const idField = op.identifyBy ?? 'id';
  const arrayField = opName;

  if (op.operations.includes('list')) {
    result.list = async parentId => {
      const doc = await getModel().findOne({ _id: parentId }).lean();
      if (!doc) return [];
      const arr = doc[arrayField];
      return Array.isArray(arr) ? (arr as Array<Record<string, unknown>>) : [];
    };
  }
  if (op.operations.includes('add')) {
    result.add = async (parentId, item) => {
      const Model = getModel();
      if (op.maxItems) {
        const max = typeof op.maxItems === 'number' ? op.maxItems : Number(op.maxItems);
        const doc = await Model.findOne({ _id: parentId }).lean();
        const arr = doc && Array.isArray(doc[arrayField]) ? doc[arrayField] : [];
        if (arr.length >= max) {
          await Model.updateOne({ _id: parentId }, { $pop: { [arrayField]: -1 } });
        }
      }
      const pushOp: Record<string, unknown> = { $push: { [arrayField]: item } };
      await Model.updateOne({ _id: parentId }, pushOp);
      return { ...item };
    };
  }
  if (op.operations.includes('remove')) {
    result.remove = async (parentId, identifyValue) => {
      const pullOp: Record<string, unknown> = {
        $pull: { [arrayField]: { [idField]: identifyValue } },
      };
      await getModel().updateOne({ _id: parentId }, pullOp);
    };
  }
  if (op.operations.includes('update')) {
    result.update = async (parentId, identifyValue, updates) => {
      const setFields: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(updates)) {
        setFields[`${arrayField}.$[elem].${k}`] = v;
      }
      await getModel().updateOne(
        { _id: parentId },
        { $set: setFields },
        { arrayFilters: [{ [`elem.${idField}`]: identifyValue }] },
      );
      const doc = await getModel().findOne({ _id: parentId }).lean();
      const arr =
        doc && Array.isArray(doc[arrayField])
          ? (doc[arrayField] as Array<Record<string, unknown>>)
          : [];
      const item = arr.find(i => i[idField] === identifyValue);
      if (!item) throw new Error(`[${config.name}] Collection item not found`);
      return { ...item };
    };
  }
  if (op.operations.includes('set')) {
    result.set = async (parentId, items) => {
      await getModel().updateOne({ _id: parentId }, { $set: { [arrayField]: items } });
    };
  }

  return result;
}

// ---------------------------------------------------------------------------
// Redis — separate key per parent
// ---------------------------------------------------------------------------

/**
 * Create a collection executor for the Redis store.
 *
 * Items are stored as a JSON-serialised array at key
 * `{prefix}collection:{opName}:{parentId}`. Each operation loads the full array,
 * mutates it, and writes it back — a read-modify-write cycle that is not atomic.
 * Concurrent writes may result in lost updates.
 *
 * @param opName - Operation name — used as the key namespace segment.
 * @param op - Collection operation config.
 * @param config - Resolved entity config (used for error messages).
 * @param redis - ioredis client instance.
 * @param prefix - Entity key prefix (e.g., `"chat:message:"`).
 * @returns A {@link CollectionResult} with only the requested operation methods populated.
 */
export function collectionRedis(
  opName: string,
  op: CollectionOpConfig,
  config: ResolvedEntityConfig,
  redis: RedisClient,
  prefix: string,
): CollectionResult {
  const result: CollectionResult = {};
  const idField = op.identifyBy ?? 'id';

  function key(parentId: string | number): string {
    return `${prefix}collection:${opName}:${parentId}`;
  }

  async function load(parentId: string | number): Promise<Array<Record<string, unknown>>> {
    const raw = await redis.get(key(parentId));
    return raw ? (JSON.parse(raw) as Array<Record<string, unknown>>) : [];
  }

  async function save(
    parentId: string | number,
    items: Array<Record<string, unknown>>,
  ): Promise<void> {
    // Use set with string value (RedisClient.set accepts ...args for EX etc)
    await (redis as { set(key: string, value: string): Promise<unknown> }).set(
      key(parentId),
      JSON.stringify(items),
    );
  }

  if (op.operations.includes('list')) {
    result.list = async parentId => load(parentId);
  }
  if (op.operations.includes('add')) {
    result.add = async (parentId, item) => {
      const items = await load(parentId);
      if (op.maxItems) {
        const max = typeof op.maxItems === 'number' ? op.maxItems : Number(op.maxItems);
        if (items.length >= max) items.shift();
      }
      items.push({ ...item });
      await save(parentId, items);
      return { ...item };
    };
  }
  if (op.operations.includes('remove')) {
    result.remove = async (parentId, identifyValue) => {
      const items = await load(parentId);
      await save(
        parentId,
        items.filter(i => i[idField] !== identifyValue),
      );
    };
  }
  if (op.operations.includes('update')) {
    result.update = async (parentId, identifyValue, updates) => {
      const items = await load(parentId);
      const item = items.find(i => i[idField] === identifyValue);
      if (!item) throw new Error(`[${config.name}] Collection item not found`);
      Object.assign(item, updates);
      await save(parentId, items);
      return { ...item };
    };
  }
  if (op.operations.includes('set')) {
    result.set = async (parentId, items) => {
      await save(
        parentId,
        items.map(i => ({ ...i })),
      );
    };
  }

  return result;
}
