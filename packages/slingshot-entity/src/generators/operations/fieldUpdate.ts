/**
 * op.fieldUpdate generator — targeted field write on parent entity.
 *
 * Updates only the specified fields on a record matched by key.
 * Prevents accidental writes to fields not in the 'set' list.
 */
import { toSnakeCase } from '../../lib/naming';
import type { ResolvedEntityConfig } from '../../types/entity';
import type { FieldUpdateOpConfig } from '../../types/operations';
import type { Backend } from '../filter';

/**
 * Generate the fieldUpdate operation method body for a specific backend.
 *
 * A `fieldUpdate` operation locates a record by `op.match` conditions and
 * writes only the fields listed in `op.set` — ignoring any other keys on the
 * `input` object. This prevents accidental writes to fields outside the
 * declared allow-list.
 *
 * The generated method signature is `async {opName}(matchParams…, input)`.
 * Only `param:x` values in `op.match` become positional parameters; literal
 * match values are embedded in the generated WHERE / predicate expression.
 *
 * Backend implementations:
 * - `memory`: iterates the store, finds the matching entry, writes allowed
 *   fields in-place, and returns a shallow copy of the updated record.
 * - `redis`: scans all keys, deserialises, writes allowed fields, re-serialises
 *   via `storeRecord()`, and returns the updated record.
 * - `sqlite`: conditionally builds `SET` clauses and `?` bindings only for
 *   `input` keys that are defined, then re-fetches the row after the `UPDATE`.
 * - `postgres`: same as SQLite but uses `$N` positional placeholders; uses a
 *   dynamically constructed `$MATCH_field` placeholder approach that is
 *   rewritten at query-build time.
 * - `mongo`: uses `Model.findOneAndUpdate({ $set: allowedFields }, { returnDocument: 'after' })`.
 *
 * @param opName - Operation name as declared in the entity config.
 * @param op - The field update operation config (match map, set field list).
 * @param entity - The resolved entity config (used for Mongo `_id` mapping).
 * @param backend - Target backend.
 * @returns A TypeScript source string for the operation method body.
 *
 * @throws `Error` with message `[{entityName}] Record not found` when no
 *   record matches `op.match` — embedded in the generated code.
 */
export function generateFieldUpdate(
  opName: string,
  op: FieldUpdateOpConfig,
  entity: ResolvedEntityConfig,
  backend: Backend,
): string {
  const matchEntries = Object.entries(op.match);
  const matchParams = matchEntries
    .filter(([, v]) => v.startsWith('param:'))
    .map(([, v]) => v.slice(6));
  const paramList = matchParams.join(', ');

  switch (backend) {
    case 'memory': {
      const matchConds = matchEntries.map(([field, value]) => {
        const rhs = value.startsWith('param:') ? value.slice(6) : `'${value}'`;
        return `entry.record['${field}'] === ${rhs}`;
      });
      const findPredicate = matchConds.join(' && ');
      const setStatements = op.set.map(
        f => `if (input['${f}'] !== undefined) entry.record['${f}'] = input['${f}'];`,
      );

      return `    async ${opName}(${paramList}, input) {
      for (const entry of store.values()) {
        if (!isAlive(entry) || !isVisible(entry.record)) continue;
        if (!(${findPredicate})) continue;
        ${setStatements.join('\n        ')}
        return { ...entry.record } as Entity;
      }
      throw new Error(\`[\${entityName}] Record not found\`);
    }`;
    }

    case 'sqlite': {
      const whereParts = matchEntries.map(([field, value]) => {
        const col = toSnakeCase(field);
        return value.startsWith('param:') ? `${col} = ?` : `${col} = '${value}'`;
      });
      const where = whereParts.join(' AND ');
      const setCols = op.set.map(f => toSnakeCase(f));

      return `    async ${opName}(${paramList}, input) {
      ensureTable();
      const setClauses = [];
      const values = [];
      ${op.set.map((f, i) => `if (input['${f}'] !== undefined) { setClauses.push('${setCols[i]} = ?'); values.push(input['${f}']); }`).join('\n      ')}
      if (setClauses.length === 0) {
        const row = db.query(\`SELECT * FROM \${table} WHERE ${where}\`).get(${matchParams.join(', ')});
        if (!row) throw new Error(\`[\${entityName}] Record not found\`);
        return fromRow(row) as Entity;
      }
      db.run(\`UPDATE \${table} SET \${setClauses.join(', ')} WHERE ${where}\`, [...values, ${matchParams.join(', ')}]);
      const row = db.query(\`SELECT * FROM \${table} WHERE ${where}\`).get(${matchParams.join(', ')});
      if (!row) throw new Error(\`[\${entityName}] Record not found\`);
      return fromRow(row) as Entity;
    }`;
    }

    case 'postgres': {
      let paramIdx = 0;
      const setCols = op.set.map(f => toSnakeCase(f));

      const whereParts = matchEntries.map(([field, value]) => {
        if (value.startsWith('param:')) return `${toSnakeCase(field)} = $MATCH_${field}`;
        return `${toSnakeCase(field)} = '${value}'`;
      });
      const where = whereParts.join(' AND ');

      return `    async ${opName}(${paramList}, input) {
      await ensureTable();
      const setClauses = [];
      const values = [];
      let paramIdx = 0;
      ${op.set.map((f, i) => `if (input['${f}'] !== undefined) { paramIdx++; setClauses.push('${setCols[i]} = $' + paramIdx); values.push(input['${f}']); }`).join('\n      ')}
      ${matchParams.map(p => `paramIdx++; values.push(${p});`).join('\n      ')}
      const where = '${where}'.replace(${matchEntries
        .filter(([, v]) => v.startsWith('param:'))
        .map(([f]) => `'$MATCH_${f}'`)
        .join(', ')}, ${
        matchEntries
          .filter(([, v]) => v.startsWith('param:'))
          .map(() => `'$' + (paramIdx - ${matchParams.length - 1})`)
          .join(', ') || "''"
      });
      if (setClauses.length === 0) {
        const result = await pool.query(\`SELECT * FROM \${table} WHERE ${where.replace(/\$MATCH_\w+/g, () => `$${++paramIdx}`)}\`, [${matchParams.join(', ')}]);
        if (!result.rows[0]) throw new Error(\`[\${entityName}] Record not found\`);
        return fromRow(result.rows[0]) as Entity;
      }
      const result = await pool.query(\`UPDATE \${table} SET \${setClauses.join(', ')} WHERE \${[${whereParts.map((_, i) => `'${matchEntries[i][0]}'`).join(', ')}].map((f, i) => \`\${toSnakeCase(f)} = $\${paramIdx - ${matchParams.length} + i + 1}\`).join(' AND ')} RETURNING *\`, values);
      if (result.rows.length === 0) throw new Error(\`[\${entityName}] Record not found\`);
      return fromRow(result.rows[0]) as Entity;
    }`;
    }

    case 'mongo': {
      const matchQuery = matchEntries.map(([field, value]) => {
        const mongoField = entity.fields[field].primary ? '_id' : field;
        const rhs = value.startsWith('param:') ? value.slice(6) : `'${value}'`;
        return `${mongoField}: ${rhs}`;
      });

      return `    async ${opName}(${paramList}, input) {
      const Model = getModel();
      const $set = {};
      ${op.set.map(f => `if (input['${f}'] !== undefined) $set['${f}'] = input['${f}'];`).join('\n      ')}
      const doc = await Model.findOneAndUpdate(
        { ${matchQuery.join(', ')} },
        { $set },
        { returnDocument: 'after' }
      ).lean();
      if (!doc) throw new Error(\`[\${entityName}] Record not found\`);
      return fromMongoDoc(doc) as Entity;
    }`;
    }

    case 'redis': {
      const matchConds = matchEntries.map(([field, value]) => {
        const rhs = value.startsWith('param:') ? value.slice(6) : `'${value}'`;
        return `r['${field}'] === ${rhs}`;
      });
      const findPredicate = matchConds.join(' && ');

      return `    async ${opName}(${paramList}, input) {
      const allKeys = await scanAllKeys();
      for (const key of allKeys) {
        const raw = await redis.get(key);
        if (!raw) continue;
        const r = fromRedisRecord(JSON.parse(raw));
        if (!isVisible(r)) continue;
        if (!(${findPredicate})) continue;
        ${op.set.map(f => `if (input['${f}'] !== undefined) r['${f}'] = input['${f}'];`).join('\n        ')}
        await storeRecord(r);
        return { ...r } as Entity;
      }
      throw new Error(\`[\${entityName}] Record not found\`);
    }`;
    }
  }
}
