/**
 * op.arrayPush generator — append a value to an array field on a specific record.
 *
 * The record is looked up by primary key. If `dedupe` is true (the default),
 * the value is only appended when it does not already exist in the array.
 *
 * The `value` binding syntax mirrors `param:x` used in other ops:
 * - `'ctx:key'`   → resolved at the HTTP layer from Hono context (e.g. `actor.id`)
 * - `'param:key'` → resolved at the HTTP layer from a URL path param
 * - `'input:key'` → resolved at the HTTP layer from the request body
 * - literal       → constant value baked into the generated code
 *
 * Generated method signature:
 * `async {opName}(id: PkType, value: unknown): Promise<Entity>`
 */
import { toSnakeCase } from '../../lib/naming';
import type { ResolvedEntityConfig } from '../../types/entity';
import type { ArrayPushOpConfig } from '../../types/operations';
import type { Backend } from '../filter';

/**
 * Generate the arrayPush operation method body for a specific backend.
 *
 * Locates the record by primary key, appends `value` to the array stored in
 * `op.field` (with optional deduplication), and returns the updated entity.
 * Throws when the record is not found.
 *
 * @param opName - Operation name as declared in the entity config.
 * @param op - The arrayPush operation config.
 * @param entity - The resolved entity config.
 * @param backend - Target backend.
 * @returns A TypeScript source string for the operation method body.
 */
export function generateArrayPush(
  opName: string,
  op: ArrayPushOpConfig,
  entity: ResolvedEntityConfig,
  backend: Backend,
): string {
  const entityName = entity.name;
  const field = op.field;
  const snakeField = toSnakeCase(field);
  const dedupe = op.dedupe !== false; // default true
  const pkCol = toSnakeCase(entity._pkField);
  const pkDef = entity.fields[entity._pkField];
  const pkType = pkDef.type === 'string' ? 'string' : 'number';

  switch (backend) {
    case 'memory': {
      const dedupeGuard = dedupe
        ? `      if (Array.isArray(entry.record['${field}']) && (entry.record['${field}'] as unknown[]).includes(value)) {\n        return { ...entry.record } as Entity;\n      }`
        : '';
      return `    async ${opName}(id: ${pkType}, value: unknown): Promise<Entity> {
      const entry = store.get(String(id));
      if (!entry || !isAlive(entry) || !isVisible(entry.record)) {
        throw new Error(\`[${entityName}] Not found\`);
      }
${dedupeGuard}
      const current = Array.isArray(entry.record['${field}']) ? [...(entry.record['${field}'] as unknown[])] : [];
      current.push(value);
      entry.record['${field}'] = current;
      return { ...entry.record } as Entity;
    }`;
    }

    case 'sqlite': {
      const dedupeCheck = dedupe
        ? `      if (current.includes(value)) return fromRow(db.query(\`SELECT * FROM \${table} WHERE ${pkCol} = ?\`).get(id) as Record<string, unknown>);\n`
        : '';
      return `    async ${opName}(id: ${pkType}, value: unknown): Promise<Entity> {
      ensureTable();
      const existing = db.query(\`SELECT * FROM \${table} WHERE ${pkCol} = ?\`).get(id) as Record<string, unknown> | null;
      if (!existing) throw new Error(\`[${entityName}] Not found\`);
      const rawVal = existing['${snakeField}'];
      const current = Array.isArray(rawVal) ? [...rawVal] : typeof rawVal === 'string' ? (JSON.parse(rawVal) as unknown[]) : [];
${dedupeCheck}      current.push(value);
      db.run(\`UPDATE \${table} SET ${snakeField} = ? WHERE ${pkCol} = ?\`, [JSON.stringify(current), id]);
      const updated = db.query(\`SELECT * FROM \${table} WHERE ${pkCol} = ?\`).get(id) as Record<string, unknown>;
      return fromRow(updated);
    }`;
    }

    case 'postgres': {
      const fieldDef = entity.fields[field];
      const isNativeArray = fieldDef.type === 'string[]';
      const dedupeCheck = dedupe
        ? `      const existing${field} = (row['${snakeField}'] ?? []) as unknown[];\n      if (existing${field}.includes(value)) return fromRow(row as Record<string, unknown>);\n`
        : '';
      if (isNativeArray) {
        return `    async ${opName}(id: ${pkType}, value: unknown): Promise<Entity> {
      await ensureTable();
      const sel = await pool.query(\`SELECT * FROM \${table} WHERE ${pkCol} = $1\`, [id]);
      if (!sel.rows[0]) throw new Error(\`[${entityName}] Not found\`);
      const row = sel.rows[0];
${dedupeCheck}      const current = [...((row['${snakeField}'] ?? []) as unknown[]), value];
      const result = await pool.query(\`UPDATE \${table} SET ${snakeField} = $2 WHERE ${pkCol} = $1 RETURNING *\`, [id, current]);
      return fromRow(result.rows[0] as Record<string, unknown>);
    }`;
      }
      // json/jsonb field
      return `    async ${opName}(id: ${pkType}, value: unknown): Promise<Entity> {
      await ensureTable();
      const sel = await pool.query(\`SELECT * FROM \${table} WHERE ${pkCol} = $1\`, [id]);
      if (!sel.rows[0]) throw new Error(\`[${entityName}] Not found\`);
      const row = sel.rows[0];
      const rawVal = row['${snakeField}'];
      const current = Array.isArray(rawVal) ? [...rawVal] : typeof rawVal === 'string' ? (JSON.parse(rawVal) as unknown[]) : [];
${dedupeCheck}      current.push(value);
      const result = await pool.query(\`UPDATE \${table} SET ${snakeField} = $2::jsonb WHERE ${pkCol} = $1 RETURNING *\`, [id, JSON.stringify(current)]);
      return fromRow(result.rows[0] as Record<string, unknown>);
    }`;
    }

    case 'mongo': {
      const arrayOp = dedupe ? '$addToSet' : '$push';
      return `    async ${opName}(id: ${pkType}, value: unknown): Promise<Entity> {
      const Model = getModel();
      await Model.updateOne({ _id: id }, { ${arrayOp}: { ${field}: value } });
      const doc = await Model.findOne({ _id: id }).lean();
      if (!doc) throw new Error(\`[${entityName}] Not found\`);
      return fromMongoDoc(doc) as Entity;
    }`;
    }

    case 'redis': {
      const dedupeCheck = dedupe
        ? `      const arr = r['${field}'];\n      if (Array.isArray(arr) && arr.includes(value)) { return { ...r } as Entity; }\n`
        : '';
      return `    async ${opName}(id: ${pkType}, value: unknown): Promise<Entity> {
      const raw = await redis.get(rkey(id));
      if (!raw) throw new Error(\`[${entityName}] Not found\`);
      const r = fromRedisRecord(JSON.parse(raw) as Record<string, unknown>);
      if (!isVisible(r)) throw new Error(\`[${entityName}] Not found\`);
${dedupeCheck}      const current = Array.isArray(r['${field}']) ? [...(r['${field}'] as unknown[])] : [];
      current.push(value);
      r['${field}'] = current;
      await storeRecord(r);
      return { ...r } as Entity;
    }`;
    }
  }
}
