/**
 * op.transition generator — state machine field update.
 *
 * Conditionally updates a field from one value to another,
 * only if the current value matches the 'from' state.
 * Returns the updated entity or null if precondition fails.
 */
import { toSnakeCase } from '../../lib/naming';
import type { ResolvedEntityConfig } from '../../types/entity';
import type { TransitionOpConfig } from '../../types/operations';
import type { Backend } from '../filter';

function primitiveToCode(v: string | number | boolean): string {
  return typeof v === 'string' ? `'${v}'` : String(v);
}

/**
 * Generate the transition operation method body for a specific backend.
 *
 * A `transition` operation is a conditional field write that acts as a
 * state-machine guard: it only updates `op.field` from `op.from` to `op.to`
 * when the current value of `op.field` matches `op.from`. If the precondition
 * fails the generated method returns `null` without mutating anything.
 *
 * An optional `op.set` map allows additional fields to be written atomically
 * with the transition (for example, setting a `completedAt` timestamp).
 * Values of `'now'` in `op.set` produce `new Date()` / `Date.now()` depending
 * on the backend; `param:x` values become extra method parameters.
 *
 * Backend implementations:
 * - `memory`: checks `entry.record[op.field] !== fromVal` and mutates in-place.
 * - `redis`: same logic over `scanAllKeys()`, re-serialises via `storeRecord()`.
 * - `sqlite`: single `UPDATE … WHERE field = ? AND … AND state_col = ?`;
 *   returns `null` when `result.changes === 0`; re-fetches to return the record.
 * - `postgres`: `UPDATE … WHERE … RETURNING *`; returns `null` when no rows.
 * - `mongo`: `Model.findOneAndUpdate({ field: fromVal, …match }, { $set: … })`;
 *   returns `null` when `doc` is falsy.
 *
 * @param opName - Operation name as declared in the entity config.
 * @param op - The transition operation config (match, field, from, to,
 *   optional set).
 * @param entity - The resolved entity config (used for Mongo `_id` mapping).
 * @param backend - Target backend.
 * @returns A TypeScript source string for the operation method body.
 *
 * @remarks
 * Parameters are derived from both `op.match` (identity conditions) and
 * `op.set` (extra write values). Duplicate names across both maps are
 * deduplicated in the generated parameter list.
 */
export function generateTransition(
  opName: string,
  op: TransitionOpConfig,
  entity: ResolvedEntityConfig,
  backend: Backend,
): string {
  const matchEntries = Object.entries(op.match);
  const params = matchEntries.filter(([, v]) => v.startsWith('param:')).map(([, v]) => v.slice(6));
  const setParams = op.set
    ? Object.entries(op.set)
        .filter(([, v]) => v.startsWith('param:'))
        .map(([, v]) => v.slice(6))
    : [];
  const allParams = [...new Set([...params, ...setParams])];
  const paramList = allParams.join(', ');

  const fromValues = Array.isArray(op.from)
    ? (op.from as readonly (string | number | boolean)[]).map(primitiveToCode)
    : [primitiveToCode(op.from as string | number | boolean)];
  const fromVal = fromValues.length === 1 ? fromValues[0] : `[${fromValues.join(', ')}]`;
  function makeFromCheck(recordExpr: string): string {
    return fromValues.length === 1
      ? `${recordExpr}['${op.field}'] !== ${fromValues[0]}`
      : `![${fromValues.join(', ')}].includes(${recordExpr}['${op.field}'])`;
  }
  const toVal = primitiveToCode(op.to);

  switch (backend) {
    case 'memory': {
      const matchConds = matchEntries.map(([field, value]) => {
        const rhs = value.startsWith('param:') ? value.slice(6) : `'${value}'`;
        return `entry.record['${field}'] === ${rhs}`;
      });
      const findPredicate = matchConds.join(' && ');

      const setStatements = [`entry.record['${op.field}'] = ${toVal};`];
      if (op.set) {
        for (const [f, v] of Object.entries(op.set)) {
          if (v === 'now') setStatements.push(`entry.record['${f}'] = new Date();`);
          else if (v.startsWith('param:'))
            setStatements.push(`entry.record['${f}'] = ${v.slice(6)};`);
          else setStatements.push(`entry.record['${f}'] = '${v}';`);
        }
      }

      return `    async ${opName}(${paramList}) {
      for (const entry of store.values()) {
        if (!isAlive(entry) || !isVisible(entry.record)) continue;
        if (!(${findPredicate})) continue;
        if (${makeFromCheck('entry.record')}) return null;
        ${setStatements.join('\n        ')}
        return { ...entry.record } as Entity;
      }
      return null;
    }`;
    }

    case 'sqlite': {
      const col = toSnakeCase(op.field);
      const setClauses = [`${col} = ?`];
      const setValues = [toVal];
      if (op.set) {
        for (const [f, v] of Object.entries(op.set)) {
          setClauses.push(`${toSnakeCase(f)} = ?`);
          if (v === 'now') setValues.push('Date.now()');
          else if (v.startsWith('param:')) setValues.push(v.slice(6));
          else setValues.push(`'${v}'`);
        }
      }

      const whereParts = matchEntries.map(([field, value]) => {
        const c = toSnakeCase(field);
        return value.startsWith('param:') ? `${c} = ?` : `${c} = '${value}'`;
      });
      whereParts.push(`${col} = ?`);

      return `    async ${opName}(${paramList}) {
      ensureTable();
      const result = db.run(
        \`UPDATE \${table} SET ${setClauses.join(', ')} WHERE ${whereParts.join(' AND ')}\`,
        [${[...setValues, ...params, fromVal].join(', ')}]
      );
      if (result.changes === 0) return null;
      // Re-fetch
      const row = db.query(\`SELECT * FROM \${table} WHERE ${matchEntries.map(([f]) => `${toSnakeCase(f)} = ?`).join(' AND ')}\`).get(${params.join(', ')});
      return row ? fromRow(row) as Entity : null;
    }`;
    }

    case 'postgres': {
      const col = toSnakeCase(op.field);
      let paramIdx = 0;
      const setClauses = [`${col} = $${++paramIdx}`];
      const allValues = [toVal];
      if (op.set) {
        for (const [f, v] of Object.entries(op.set)) {
          setClauses.push(`${toSnakeCase(f)} = $${++paramIdx}`);
          if (v === 'now') allValues.push('new Date()');
          else if (v.startsWith('param:')) allValues.push(v.slice(6));
          else allValues.push(`'${v}'`);
        }
      }

      const whereParts = matchEntries.map(([field, value]) => {
        if (value.startsWith('param:')) return `${toSnakeCase(field)} = $${++paramIdx}`;
        return `${toSnakeCase(field)} = '${value}'`;
      });
      whereParts.push(`${col} = $${++paramIdx}`);

      return `    async ${opName}(${paramList}) {
      await ensureTable();
      const result = await pool.query(
        \`UPDATE \${table} SET ${setClauses.join(', ')} WHERE ${whereParts.join(' AND ')} RETURNING *\`,
        [${[...allValues, ...params, fromVal].join(', ')}]
      );
      if (result.rows.length === 0) return null;
      return fromRow(result.rows[0]) as Entity;
    }`;
    }

    case 'mongo': {
      const matchQuery: string[] = matchEntries.map(([field, value]) => {
        const mongoField = entity.fields[field].primary ? '_id' : field;
        const rhs = value.startsWith('param:') ? value.slice(6) : `'${value}'`;
        return `${mongoField}: ${rhs}`;
      });
      matchQuery.push(`${op.field}: ${fromVal}`);

      const setFields: string[] = [`${op.field}: ${toVal}`];
      if (op.set) {
        for (const [f, v] of Object.entries(op.set)) {
          if (v === 'now') setFields.push(`${f}: new Date()`);
          else if (v.startsWith('param:')) setFields.push(`${f}: ${v.slice(6)}`);
          else setFields.push(`${f}: '${v}'`);
        }
      }

      return `    async ${opName}(${paramList}) {
      const Model = getModel();
      const doc = await Model.findOneAndUpdate(
        { ${matchQuery.join(', ')} },
        { $set: { ${setFields.join(', ')} } },
        { returnDocument: 'after' }
      ).lean();
      if (!doc) return null;
      return fromMongoDoc(doc) as Entity;
    }`;
    }

    case 'redis': {
      const matchConds = matchEntries.map(([field, value]) => {
        const rhs = value.startsWith('param:') ? value.slice(6) : `'${value}'`;
        return `r['${field}'] === ${rhs}`;
      });
      const findPredicate = matchConds.join(' && ');

      const setStatements = [`r['${op.field}'] = ${toVal};`];
      if (op.set) {
        for (const [f, v] of Object.entries(op.set)) {
          if (v === 'now') setStatements.push(`r['${f}'] = new Date();`);
          else if (v.startsWith('param:')) setStatements.push(`r['${f}'] = ${v.slice(6)};`);
          else setStatements.push(`r['${f}'] = '${v}';`);
        }
      }

      return `    async ${opName}(${paramList}) {
      const allKeys = await scanAllKeys();
      for (const key of allKeys) {
        const raw = await redis.get(key);
        if (!raw) continue;
        const r = fromRedisRecord(JSON.parse(raw));
        if (!isVisible(r)) continue;
        if (!(${findPredicate})) continue;
        if (${makeFromCheck('r')}) return null;
        ${setStatements.join('\n        ')}
        await storeRecord(r);
        return { ...r } as Entity;
      }
      return null;
    }`;
    }
  }
}
