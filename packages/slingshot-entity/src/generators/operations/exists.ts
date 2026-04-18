/**
 * op.exists generator — boolean existence/predicate check.
 *
 * Like lookup but returns boolean. Optionally checks a field value
 * on the found record (not just existence).
 */
import { toSnakeCase } from '../../lib/naming';
import type { ResolvedEntityConfig } from '../../types/entity';
import type { ExistsOpConfig } from '../../types/operations';
import type { Backend } from '../filter';

/**
 * Generate the exists operation method body for a specific backend.
 *
 * An `exists` operation returns a `boolean` indicating whether a record
 * matching all `op.fields` conditions exists. An optional `op.check` map
 * adds additional field equality conditions on the found record (for example,
 * verifying a status field without exposing the full record).
 *
 * Backend implementations:
 * - `memory`: iterates the store in JS, evaluates field conditions and the
 *   optional `check` map inline.
 * - `redis`: scans all keys with `scanAllKeys()`, deserialises each record,
 *   and applies the same JS predicates.
 * - `sqlite`: emits `SELECT 1 FROM … WHERE … LIMIT 1`, binding `?`
 *   placeholders for all `param:x` fields and literal check values.
 * - `postgres`: emits `SELECT 1 FROM … WHERE … LIMIT 1` with `$N` positional
 *   placeholders.
 * - `mongo`: emits `Model.findOne({ … }).lean()` and checks for `doc != null`;
 *   primary-key fields are mapped to `_id`.
 *
 * @param opName - Operation name as declared in the entity config.
 * @param op - The exists operation config (fields match map, optional check
 *   map).
 * @param entity - The resolved entity config (used to detect primary key fields
 *   for Mongo `_id` mapping).
 * @param backend - Target backend.
 * @returns A TypeScript source string for the operation method body.
 *
 * @remarks
 * Only `param:x` values in `op.fields` become method parameters. Literal
 * string values are embedded directly in the generated WHERE / predicate
 * expression. The `op.check` conditions are always embedded as literals.
 */
export function generateExists(
  opName: string,
  op: ExistsOpConfig,
  entity: ResolvedEntityConfig,
  backend: Backend,
): string {
  const fields = Object.entries(op.fields);
  const params = fields.filter(([, v]) => v.startsWith('param:')).map(([, v]) => v.slice(6));
  const paramList = params.join(', ');

  switch (backend) {
    case 'memory':
    case 'redis': {
      const conditions = fields.map(([field, value]) => {
        const rhs = value.startsWith('param:') ? value.slice(6) : `'${value}'`;
        return `r['${field}'] === ${rhs}`;
      });
      let predicate = conditions.join(' && ');
      if (op.check) {
        const checks = Object.entries(op.check).map(
          ([f, v]) => `r['${f}'] === ${typeof v === 'string' ? `'${v}'` : v}`,
        );
        predicate += ` && ${checks.join(' && ')}`;
      }

      if (backend === 'memory') {
        return `    async ${opName}(${paramList}) {
      for (const entry of store.values()) {
        if (!isAlive(entry) || !isVisible(entry.record)) continue;
        const r = entry.record;
        if (${predicate}) return true;
      }
      return false;
    }`;
      }

      return `    async ${opName}(${paramList}) {
      const allKeys = await scanAllKeys();
      for (const key of allKeys) {
        const raw = await redis.get(key);
        if (!raw) continue;
        const r = fromRedisRecord(JSON.parse(raw));
        if (!isVisible(r)) continue;
        if (${predicate}) return true;
      }
      return false;
    }`;
    }

    case 'sqlite': {
      const conditions = fields.map(([field, value]) => {
        const col = toSnakeCase(field);
        return value.startsWith('param:') ? `${col} = ?` : `${col} = '${value}'`;
      });
      if (op.check) {
        for (const [f, v] of Object.entries(op.check)) {
          conditions.push(`${toSnakeCase(f)} = ?`);
          params.push(String(v));
        }
      }
      const where = conditions.join(' AND ');
      return `    async ${opName}(${paramList}) {
      ensureTable();
      const row = db.query(\`SELECT 1 FROM \${table} WHERE ${where} LIMIT 1\`).get(${params.join(', ')});
      return row != null;
    }`;
    }

    case 'postgres': {
      let paramIdx = 0;
      const conditions = fields.map(([field, value]) => {
        const col = toSnakeCase(field);
        if (value.startsWith('param:')) {
          paramIdx++;
          return `${col} = $${paramIdx}`;
        }
        return `${col} = '${value}'`;
      });
      const pgParams = [...params];
      if (op.check) {
        for (const [f, v] of Object.entries(op.check)) {
          paramIdx++;
          conditions.push(`${toSnakeCase(f)} = $${paramIdx}`);
          pgParams.push(String(v));
        }
      }
      const where = conditions.join(' AND ');
      return `    async ${opName}(${paramList}) {
      await ensureTable();
      const result = await pool.query(\`SELECT 1 FROM \${table} WHERE ${where} LIMIT 1\`, [${pgParams.join(', ')}]);
      return result.rows.length > 0;
    }`;
    }

    case 'mongo': {
      const queryParts = fields.map(([field, value]) => {
        const mongoField = entity.fields[field].primary ? '_id' : field;
        const rhs = value.startsWith('param:') ? value.slice(6) : `'${value}'`;
        return `${mongoField}: ${rhs}`;
      });
      if (op.check) {
        for (const [f, v] of Object.entries(op.check)) {
          queryParts.push(`${f}: ${typeof v === 'string' ? `'${v}'` : v}`);
        }
      }
      const query = `{ ${queryParts.join(', ')} }`;
      return `    async ${opName}(${paramList}) {
      const Model = getModel();
      const doc = await Model.findOne(${query}).lean();
      return doc != null;
    }`;
    }
  }
}
