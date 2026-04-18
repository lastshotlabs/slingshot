/**
 * op.lookup generator — find by non-primary key(s).
 *
 * Generates a method that queries records by 1+ field conditions.
 * Returns one record or a paginated list depending on config.
 */
import { toSnakeCase } from '../../lib/naming';
import type { ResolvedEntityConfig } from '../../types/entity';
import type { LookupOpConfig } from '../../types/operations';
import type { Backend } from '../filter';

/**
 * Generate the lookup operation method body for a specific backend.
 *
 * A `lookup` operation finds records by one or more non-primary-key field
 * conditions. The generated method's return type depends on `op.returns`:
 * - `'one'`: returns `Entity | null` — stops at the first match.
 * - `'many'` (default): returns a paginated result set via `paginateResults()`.
 *
 * For `'many'` lookups the generated signature includes an `opts` parameter
 * for pagination options (limit, cursor).
 *
 * Backend implementations:
 * - `memory`: iterates the store in JS, evaluates field conditions inline.
 * - `redis`: scans all keys with `scanAllKeys()`, deserialises each record, and
 *   applies JS conditions.
 * - `sqlite`: emits `SELECT * FROM … WHERE … [LIMIT 1]` with `?` bindings.
 * - `postgres`: emits `SELECT * FROM … WHERE … [LIMIT 1]` with `$N` bindings.
 * - `mongo`: emits `Model.findOne()` or `Model.find()` with a query object;
 *   primary-key fields are mapped to `_id`.
 *
 * @param opName - Operation name as declared in the entity config.
 * @param op - The lookup operation config (fields match map, returns mode).
 * @param entity - The resolved entity config (used for Mongo `_id` mapping).
 * @param backend - Target backend.
 * @returns A TypeScript source string for the operation method body.
 *
 * @remarks
 * Only `param:x` values in `op.fields` become method parameters. Literal
 * string values are baked into the generated WHERE / condition expression.
 */
export function generateLookup(
  opName: string,
  op: LookupOpConfig,
  entity: ResolvedEntityConfig,
  backend: Backend,
): string {
  const fields = Object.entries(op.fields);
  const params = fields.filter(([, v]) => isParamRef(v)).map(([, v]) => (v as string).slice(6));

  switch (backend) {
    case 'memory':
      return generateLookupMemory(opName, op, entity, params, fields);
    case 'sqlite':
      return generateLookupSqlite(opName, op, entity, params, fields);
    case 'postgres':
      return generateLookupPostgres(opName, op, entity, params, fields);
    case 'mongo':
      return generateLookupMongo(opName, op, entity, params, fields);
    case 'redis':
      return generateLookupRedis(opName, op, entity, params, fields);
  }
}

type FieldEntry = [string, string | number | boolean];

function isParamRef(value: string | number | boolean): value is string {
  return typeof value === 'string' && value.startsWith('param:');
}

function toJsLiteral(value: string | number | boolean): string {
  return isParamRef(value) ? value.slice(6) : JSON.stringify(value);
}

function toSqlLiteral(value: string | number | boolean): string {
  return typeof value === 'string' ? `'${value.replace(/'/g, "''")}'` : String(value);
}

function generateLookupMemory(
  opName: string,
  op: LookupOpConfig,
  _entity: ResolvedEntityConfig,
  params: string[],
  fields: FieldEntry[],
): string {
  const conditions = fields.map(([field, value]) => {
    const rhs = toJsLiteral(value);
    return `r['${field}'] === ${rhs}`;
  });
  const predicate = conditions.join(' && ');

  if (op.returns === 'one') {
    return `    async ${opName}(${params.join(', ')}) {
      for (const entry of store.values()) {
        if (!isAlive(entry) || !isVisible(entry.record)) continue;
        const r = entry.record;
        if (${predicate}) return { ...r } as Entity;
      }
      return null;
    }`;
  }

  return `    async ${opName}(${params.join(', ')}, opts) {
      const results = [];
      for (const entry of store.values()) {
        if (!isAlive(entry) || !isVisible(entry.record)) continue;
        const r = entry.record;
        if (${predicate}) results.push({ ...r } as Entity);
      }
      return paginateResults(results, opts);
    }`;
}

function generateLookupSqlite(
  opName: string,
  op: LookupOpConfig,
  entity: ResolvedEntityConfig,
  params: string[],
  fields: FieldEntry[],
): string {
  const conditions = fields.map(([field, value]) => {
    const col = toSnakeCase(field);
    return isParamRef(value) ? `${col} = ?` : `${col} = ${toSqlLiteral(value)}`;
  });
  const where = conditions.join(' AND ');
  const paramBinds = params.map(p => p);

  if (op.returns === 'one') {
    return `    async ${opName}(${params.join(', ')}) {
      ensureTable();
      const row = db.query(\`SELECT * FROM \${table} WHERE ${where} LIMIT 1\`).get(${paramBinds.join(', ')});
      if (!row) return null;
      return fromRow(row) as Entity;
    }`;
  }

  return `    async ${opName}(${params.join(', ')}, opts) {
      ensureTable();
      const rows = db.query(\`SELECT * FROM \${table} WHERE ${where}\`).all(${paramBinds.join(', ')});
      const items = rows.map(r => fromRow(r) as Entity);
      return paginateResults(items, opts);
    }`;
}

function generateLookupPostgres(
  opName: string,
  op: LookupOpConfig,
  entity: ResolvedEntityConfig,
  params: string[],
  fields: FieldEntry[],
): string {
  let paramIdx = 0;
  const conditions = fields.map(([field, value]) => {
    const col = toSnakeCase(field);
    if (isParamRef(value)) {
      paramIdx++;
      return `${col} = $${paramIdx}`;
    }
    return `${col} = ${toSqlLiteral(value)}`;
  });
  const where = conditions.join(' AND ');

  if (op.returns === 'one') {
    return `    async ${opName}(${params.join(', ')}) {
      await ensureTable();
      const result = await pool.query(\`SELECT * FROM \${table} WHERE ${where} LIMIT 1\`, [${params.join(', ')}]);
      if (!result.rows[0]) return null;
      return fromRow(result.rows[0]) as Entity;
    }`;
  }

  return `    async ${opName}(${params.join(', ')}, opts) {
      await ensureTable();
      const result = await pool.query(\`SELECT * FROM \${table} WHERE ${where}\`, [${params.join(', ')}]);
      const items = result.rows.map(r => fromRow(r) as Entity);
      return paginateResults(items, opts);
    }`;
}

function generateLookupMongo(
  opName: string,
  op: LookupOpConfig,
  entity: ResolvedEntityConfig,
  params: string[],
  fields: FieldEntry[],
): string {
  const queryParts = fields.map(([field, value]) => {
    const mongoField = entity.fields[field].primary ? '_id' : field;
    const rhs = toJsLiteral(value);
    return `${mongoField}: ${rhs}`;
  });
  const query = `{ ${queryParts.join(', ')} }`;

  if (op.returns === 'one') {
    return `    async ${opName}(${params.join(', ')}) {
      const Model = getModel();
      const doc = await Model.findOne(${query}).lean();
      if (!doc) return null;
      return fromMongoDoc(doc) as Entity;
    }`;
  }

  return `    async ${opName}(${params.join(', ')}, opts) {
      const Model = getModel();
      const docs = await Model.find(${query}).lean();
      const items = docs.map(d => fromMongoDoc(d) as Entity);
      return paginateResults(items, opts);
    }`;
}

function generateLookupRedis(
  opName: string,
  op: LookupOpConfig,
  _entity: ResolvedEntityConfig,
  params: string[],
  fields: FieldEntry[],
): string {
  const conditions = fields.map(([field, value]) => {
    const rhs = toJsLiteral(value);
    return `r['${field}'] === ${rhs}`;
  });
  const predicate = conditions.join(' && ');

  if (op.returns === 'one') {
    return `    async ${opName}(${params.join(', ')}) {
      const allKeys = await scanAllKeys();
      for (const key of allKeys) {
        const raw = await redis.get(key);
        if (!raw) continue;
        const r = fromRedisRecord(JSON.parse(raw));
        if (!isVisible(r)) continue;
        if (${predicate}) return { ...r } as Entity;
      }
      return null;
    }`;
  }

  return `    async ${opName}(${params.join(', ')}, opts) {
      const allKeys = await scanAllKeys();
      const results = [];
      for (const key of allKeys) {
        const raw = await redis.get(key);
        if (!raw) continue;
        const r = fromRedisRecord(JSON.parse(raw));
        if (!isVisible(r)) continue;
        if (${predicate}) results.push({ ...r } as Entity);
      }
      return paginateResults(results, opts);
    }`;
}
