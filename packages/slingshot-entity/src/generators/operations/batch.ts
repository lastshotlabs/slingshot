/**
 * op.batch generator — multi-record update/delete by filter.
 */
import { toSnakeCase } from '../../lib/naming';
import type { ResolvedEntityConfig } from '../../types/entity';
import type { BatchOpConfig } from '../../types/operations';
import type { Backend } from '../filter';
import {
  compileFilterMemory,
  compileFilterMongo,
  compileFilterPostgres,
  compileFilterRedis,
  compileFilterSqlite,
  extractParams,
} from '../filter';

/**
 * Generate the batch operation method body for a specific backend.
 *
 * Produces a `async {opName}(params)` method body that applies a bulk
 * `delete` or field `update` to all records matching a filter expression.
 * Optionally returns the count of affected records when `op.returns === 'count'`.
 *
 * Backend implementations:
 * - `memory`: iterates the store in JS, applies the compiled predicate, and
 *   deletes or mutates matching entries.
 * - `redis`: iterates via `scanAllKeys()` + `GET`, filters in JS, then deletes
 *   or `SET`s the modified record back.
 * - `sqlite`: single `DELETE FROM … WHERE …` or
 *   `UPDATE … SET … WHERE …` SQL statement using `?` placeholders.
 * - `postgres`: same as SQLite but with `$N` positional placeholders; returns
 *   `result.rowCount`.
 * - `mongo`: `Model.deleteMany(filter)` or `Model.updateMany(filter, { $set: … })`.
 *
 * @param opName - Operation name as declared in the entity config.
 * @param op - The batch operation config (action, filter, optional set map,
 *   optional returns).
 * @param entity - The resolved entity config.
 * @param backend - Target backend.
 * @returns A TypeScript source string for the operation method body.
 */
export function generateBatch(
  opName: string,
  op: BatchOpConfig,
  entity: ResolvedEntityConfig,
  backend: Backend,
): string {
  const params = extractParams(op.filter);
  const paramList = params.join(', ');
  const returnsCount = op.returns === 'count';

  switch (backend) {
    case 'memory': {
      const predicate = compileFilterMemory(op.filter);
      if (op.action === 'delete') {
        return `    async ${opName}(${paramList}) {
      let count = 0;
      for (const [pk, entry] of store) {
        if (!isAlive(entry) || !isVisible(entry.record)) continue;
        const record = entry.record;
        if (${predicate}) { store.delete(pk); count++; }
      }
      ${returnsCount ? 'return count;' : ''}
    }`;
      }
      const setStatements = op.set
        ? Object.entries(op.set).map(([f, v]) => {
            if (v === 'now') return `entry.record['${f}'] = new Date();`;
            if (typeof v === 'string' && v.startsWith('param:'))
              return `entry.record['${f}'] = ${v.slice(6)};`;
            return `entry.record['${f}'] = ${typeof v === 'string' ? `'${v}'` : v};`;
          })
        : [];
      return `    async ${opName}(${paramList}) {
      let count = 0;
      for (const entry of store.values()) {
        if (!isAlive(entry) || !isVisible(entry.record)) continue;
        const record = entry.record;
        if (${predicate}) {
          ${setStatements.join('\n          ')}
          count++;
        }
      }
      ${returnsCount ? 'return count;' : ''}
    }`;
    }

    case 'sqlite': {
      const { where, params: sqlParams } = compileFilterSqlite(op.filter, entity);
      if (op.action === 'delete') {
        return `    async ${opName}(${paramList}) {
      ensureTable();
      const result = db.run(\`DELETE FROM \${table} WHERE ${where}\`, [${sqlParams.join(', ')}]);
      ${returnsCount ? 'return result.changes;' : ''}
    }`;
      }
      const setClauses = op.set
        ? Object.entries(op.set).map(([f, v]) => {
            if (v === 'now') return `${toSnakeCase(f)} = ?`;
            return `${toSnakeCase(f)} = ?`;
          })
        : [];
      const setValues = op.set
        ? Object.values(op.set).map(v => {
            if (v === 'now') return 'Date.now()';
            if (typeof v === 'string' && v.startsWith('param:')) return v.slice(6);
            return typeof v === 'string' ? `'${v}'` : String(v);
          })
        : [];
      return `    async ${opName}(${paramList}) {
      ensureTable();
      const result = db.run(\`UPDATE \${table} SET ${setClauses.join(', ')} WHERE ${where}\`, [${[...setValues, ...sqlParams].join(', ')}]);
      ${returnsCount ? 'return result.changes;' : ''}
    }`;
    }

    case 'postgres': {
      const { where, params: pgParams, paramIdx } = compileFilterPostgres(op.filter, entity);
      if (op.action === 'delete') {
        return `    async ${opName}(${paramList}) {
      await ensureTable();
      const result = await pool.query(\`DELETE FROM \${table} WHERE ${where}\`, [${pgParams.join(', ')}]);
      ${returnsCount ? 'return result.rowCount ?? 0;' : ''}
    }`;
      }
      let pIdx = paramIdx;
      const setClauses = op.set
        ? Object.entries(op.set).map(([f]) => `${toSnakeCase(f)} = $${++pIdx}`)
        : [];
      const setValues = op.set
        ? Object.values(op.set).map(v => {
            if (v === 'now') return 'new Date()';
            if (typeof v === 'string' && v.startsWith('param:')) return v.slice(6);
            return typeof v === 'string' ? `'${v}'` : String(v);
          })
        : [];
      return `    async ${opName}(${paramList}) {
      await ensureTable();
      const result = await pool.query(\`UPDATE \${table} SET ${setClauses.join(', ')} WHERE ${where}\`, [${[...pgParams, ...setValues].join(', ')}]);
      ${returnsCount ? 'return result.rowCount ?? 0;' : ''}
    }`;
    }

    case 'mongo': {
      const mongoFilter = compileFilterMongo(op.filter);
      if (op.action === 'delete') {
        return `    async ${opName}(${paramList}) {
      const Model = getModel();
      const result = await Model.deleteMany(${mongoFilter});
      ${returnsCount ? 'return result.deletedCount;' : ''}
    }`;
      }
      const setFields = op.set
        ? Object.entries(op.set).map(([f, v]) => {
            if (v === 'now') return `${f}: new Date()`;
            if (typeof v === 'string' && v.startsWith('param:')) return `${f}: ${v.slice(6)}`;
            return `${f}: ${typeof v === 'string' ? `'${v}'` : v}`;
          })
        : [];
      return `    async ${opName}(${paramList}) {
      const Model = getModel();
      const result = await Model.updateMany(${mongoFilter}, { $set: { ${setFields.join(', ')} } });
      ${returnsCount ? 'return result.modifiedCount;' : ''}
    }`;
    }

    case 'redis': {
      const predicate = compileFilterRedis(op.filter);
      if (op.action === 'delete') {
        return `    async ${opName}(${paramList}) {
      const allKeys = await scanAllKeys();
      let count = 0;
      for (const key of allKeys) {
        const raw = await redis.get(key);
        if (!raw) continue;
        const record = fromRedisRecord(JSON.parse(raw));
        if (!isVisible(record)) continue;
        if (${predicate}) { await redis.del(key); count++; }
      }
      ${returnsCount ? 'return count;' : ''}
    }`;
      }
      const setStatements = op.set
        ? Object.entries(op.set).map(([f, v]) => {
            if (v === 'now') return `record['${f}'] = new Date();`;
            if (typeof v === 'string' && v.startsWith('param:'))
              return `record['${f}'] = ${v.slice(6)};`;
            return `record['${f}'] = ${typeof v === 'string' ? `'${v}'` : v};`;
          })
        : [];
      return `    async ${opName}(${paramList}) {
      const allKeys = await scanAllKeys();
      let count = 0;
      for (const key of allKeys) {
        const raw = await redis.get(key);
        if (!raw) continue;
        const record = fromRedisRecord(JSON.parse(raw));
        if (!isVisible(record)) continue;
        if (${predicate}) {
          ${setStatements.join('\n          ')}
          await storeRecord(record);
          count++;
        }
      }
      ${returnsCount ? 'return count;' : ''}
    }`;
    }
  }
}
