/**
 * op.arrayPull generator — remove all occurrences of a value from an array field.
 *
 * The record is looked up by primary key. All occurrences of `value` are removed
 * from the target array field. Returns the updated entity. Throws when the record
 * is not found.
 *
 * Uses the same `value` binding syntax as `arrayPush` — resolved at the HTTP
 * layer before the adapter method is called.
 *
 * Generated method signature:
 * `async {opName}(id: PkType, value: unknown): Promise<Entity>`
 */
import { toSnakeCase } from '../../lib/naming';
import type { ResolvedEntityConfig } from '../../types/entity';
import type { ArrayPullOpConfig } from '../../types/operations';
import type { Backend } from '../filter';

/**
 * Generate the arrayPull operation method body for a specific backend.
 *
 * Locates the record by primary key, removes all occurrences of `value` from
 * the array stored in `op.field`, and returns the updated entity.
 *
 * @param opName - Operation name as declared in the entity config.
 * @param op - The arrayPull operation config.
 * @param entity - The resolved entity config.
 * @param backend - Target backend.
 * @returns A TypeScript source string for the operation method body.
 */
export function generateArrayPull(
  opName: string,
  op: ArrayPullOpConfig,
  entity: ResolvedEntityConfig,
  backend: Backend,
): string {
  const entityName = entity.name;
  const field = op.field;
  const snakeField = toSnakeCase(field);
  const pkCol = toSnakeCase(entity._pkField);
  const pkDef = entity.fields[entity._pkField];
  const pkType = pkDef.type === 'string' ? 'string' : 'number';

  switch (backend) {
    case 'memory': {
      return `    async ${opName}(id: ${pkType}, value: unknown): Promise<Entity> {
      const entry = store.get(String(id));
      if (!entry || !isAlive(entry) || !isVisible(entry.record)) {
        throw new Error(\`[${entityName}] Not found\`);
      }
      const current = Array.isArray(entry.record['${field}']) ? (entry.record['${field}'] as unknown[]).filter(v => v !== value) : [];
      entry.record['${field}'] = current;
      return { ...entry.record } as Entity;
    }`;
    }

    case 'sqlite': {
      return `    async ${opName}(id: ${pkType}, value: unknown): Promise<Entity> {
      ensureTable();
      const existing = db.query(\`SELECT * FROM \${table} WHERE ${pkCol} = ?\`).get(id) as Record<string, unknown> | null;
      if (!existing) throw new Error(\`[${entityName}] Not found\`);
      const rawVal = existing['${snakeField}'];
      const current = Array.isArray(rawVal) ? rawVal : typeof rawVal === 'string' ? (JSON.parse(rawVal) as unknown[]) : [];
      const updated = (current as unknown[]).filter(v => v !== value);
      db.run(\`UPDATE \${table} SET ${snakeField} = ? WHERE ${pkCol} = ?\`, [JSON.stringify(updated), id]);
      const row = db.query(\`SELECT * FROM \${table} WHERE ${pkCol} = ?\`).get(id) as Record<string, unknown>;
      return fromRow(row);
    }`;
    }

    case 'postgres': {
      const fieldDef = entity.fields[field];
      const isNativeArray = fieldDef.type === 'string[]';
      if (isNativeArray) {
        return `    async ${opName}(id: ${pkType}, value: unknown): Promise<Entity> {
      await ensureTable();
      const sel = await pool.query(\`SELECT * FROM \${table} WHERE ${pkCol} = $1\`, [id]);
      if (!sel.rows[0]) throw new Error(\`[${entityName}] Not found\`);
      const current = ((sel.rows[0]['${snakeField}'] ?? []) as unknown[]).filter(v => v !== value);
      const result = await pool.query(\`UPDATE \${table} SET ${snakeField} = $2 WHERE ${pkCol} = $1 RETURNING *\`, [id, current]);
      return fromRow(result.rows[0] as Record<string, unknown>);
    }`;
      }
      // json/jsonb field
      return `    async ${opName}(id: ${pkType}, value: unknown): Promise<Entity> {
      await ensureTable();
      const sel = await pool.query(\`SELECT * FROM \${table} WHERE ${pkCol} = $1\`, [id]);
      if (!sel.rows[0]) throw new Error(\`[${entityName}] Not found\`);
      const rawVal = sel.rows[0]['${snakeField}'];
      const current = Array.isArray(rawVal) ? rawVal : typeof rawVal === 'string' ? (JSON.parse(rawVal) as unknown[]) : [];
      const updated = (current as unknown[]).filter(v => v !== value);
      const result = await pool.query(\`UPDATE \${table} SET ${snakeField} = $2::jsonb WHERE ${pkCol} = $1 RETURNING *\`, [id, JSON.stringify(updated)]);
      return fromRow(result.rows[0] as Record<string, unknown>);
    }`;
    }

    case 'mongo': {
      return `    async ${opName}(id: ${pkType}, value: unknown): Promise<Entity> {
      const Model = getModel();
      await Model.updateOne({ _id: id }, { $pull: { ${field}: value } });
      const doc = await Model.findOne({ _id: id }).lean();
      if (!doc) throw new Error(\`[${entityName}] Not found\`);
      return fromMongoDoc(doc) as Entity;
    }`;
    }

    case 'redis': {
      return `    async ${opName}(id: ${pkType}, value: unknown): Promise<Entity> {
      const raw = await redis.get(rkey(id));
      if (!raw) throw new Error(\`[${entityName}] Not found\`);
      const r = fromRedisRecord(JSON.parse(raw) as Record<string, unknown>);
      if (!isVisible(r)) throw new Error(\`[${entityName}] Not found\`);
      const current = Array.isArray(r['${field}']) ? (r['${field}'] as unknown[]).filter(v => v !== value) : [];
      r['${field}'] = current;
      await storeRecord(r);
      return { ...r } as Entity;
    }`;
    }
  }
}
