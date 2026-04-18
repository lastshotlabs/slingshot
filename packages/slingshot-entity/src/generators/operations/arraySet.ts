/**
 * op.arraySet generator — replace the entire contents of an array field on a specific record.
 *
 * The record is looked up by primary key. The stored array is replaced wholesale with `value`
 * (which must be an array). When `dedupe` is true (the default), the incoming array is
 * deduplicated server-side before writing (`[...new Set(value)]`).
 *
 * The `value` binding syntax mirrors `param:x` used in other ops:
 * - `'input:key'` → resolved at the HTTP layer from the request body (recommended for arrays)
 * - `'ctx:key'`   → resolved at the HTTP layer from Hono context
 * - `'param:key'` → resolved at the HTTP layer from a URL path param
 * - literal       → constant value baked into the generated code (rare)
 *
 * Generated method signature:
 * `async {opName}(id: PkType, value: unknown[]): Promise<Entity>`
 */
import { toSnakeCase } from '../../lib/naming';
import type { ResolvedEntityConfig } from '../../types/entity';
import type { ArraySetOpConfig } from '../../types/operations';
import type { Backend } from '../filter';

/**
 * Generate the arraySet operation method body for a specific backend.
 *
 * Locates the record by primary key, applies optional server-side deduplication to
 * the incoming array, replaces the field, and returns the updated entity.
 * Throws when the record is not found or the provided value is not an array.
 *
 * @param opName - Operation name as declared in the entity config.
 * @param op - The arraySet operation config.
 * @param entity - The resolved entity config.
 * @param backend - Target backend.
 * @returns A TypeScript source string for the operation method body.
 */
export function generateArraySet(
  opName: string,
  op: ArraySetOpConfig,
  entity: ResolvedEntityConfig,
  backend: Backend,
): string {
  const entityName = entity.name;
  const field = op.field;
  const snakeField = toSnakeCase(field);
  const pkCol = toSnakeCase(entity._pkField);
  const pkDef = entity.fields[entity._pkField];
  const pkType = pkDef.type === 'string' ? 'string' : 'number';
  const dedupe = op.dedupe !== false; // default true

  const dedupeExpr = dedupe ? '[...new Set(value)]' : 'value';

  switch (backend) {
    case 'memory': {
      return `    async ${opName}(id: ${pkType}, value: unknown[]): Promise<Entity> {
      if (!Array.isArray(value)) throw new Error(\`[${entityName}] arraySet value must be an array\`);
      const entry = store.get(String(id));
      if (!entry || !isAlive(entry) || !isVisible(entry.record)) {
        throw new Error(\`[${entityName}] Not found\`);
      }
      entry.record['${field}'] = ${dedupeExpr};
      return { ...entry.record } as Entity;
    }`;
    }

    case 'sqlite': {
      return `    async ${opName}(id: ${pkType}, value: unknown[]): Promise<Entity> {
      if (!Array.isArray(value)) throw new Error(\`[${entityName}] arraySet value must be an array\`);
      ensureTable();
      const exists = db.query(\`SELECT 1 FROM \${table} WHERE ${pkCol} = ?\`).get(id);
      if (!exists) throw new Error(\`[${entityName}] Not found\`);
      const deduped = ${dedupeExpr};
      db.run(\`UPDATE \${table} SET ${snakeField} = ? WHERE ${pkCol} = ?\`, [JSON.stringify(deduped), id]);
      const updated = db.query(\`SELECT * FROM \${table} WHERE ${pkCol} = ?\`).get(id) as Record<string, unknown>;
      return fromRow(updated);
    }`;
    }

    case 'postgres': {
      const fieldDef = entity.fields[field];
      const isNativeArray = fieldDef.type === 'string[]';
      if (isNativeArray) {
        return `    async ${opName}(id: ${pkType}, value: unknown[]): Promise<Entity> {
      if (!Array.isArray(value)) throw new Error(\`[${entityName}] arraySet value must be an array\`);
      await ensureTable();
      const deduped = ${dedupeExpr};
      const result = await pool.query(\`UPDATE \${table} SET ${snakeField} = $2 WHERE ${pkCol} = $1 RETURNING *\`, [id, deduped]);
      if (!result.rows[0]) throw new Error(\`[${entityName}] Not found\`);
      return fromRow(result.rows[0] as Record<string, unknown>);
    }`;
      }
      return `    async ${opName}(id: ${pkType}, value: unknown[]): Promise<Entity> {
      if (!Array.isArray(value)) throw new Error(\`[${entityName}] arraySet value must be an array\`);
      await ensureTable();
      const deduped = ${dedupeExpr};
      const result = await pool.query(\`UPDATE \${table} SET ${snakeField} = $2::jsonb WHERE ${pkCol} = $1 RETURNING *\`, [id, JSON.stringify(deduped)]);
      if (!result.rows[0]) throw new Error(\`[${entityName}] Not found\`);
      return fromRow(result.rows[0] as Record<string, unknown>);
    }`;
    }

    case 'mongo': {
      return `    async ${opName}(id: ${pkType}, value: unknown[]): Promise<Entity> {
      if (!Array.isArray(value)) throw new Error(\`[${entityName}] arraySet value must be an array\`);
      const deduped = ${dedupeExpr};
      const Model = getModel();
      const result = await Model.updateOne({ _id: id }, { $set: { ${field}: deduped } });
      if (result.matchedCount === 0) throw new Error(\`[${entityName}] Not found\`);
      const doc = await Model.findOne({ _id: id }).lean();
      if (!doc) throw new Error(\`[${entityName}] Not found\`);
      return fromMongoDoc(doc) as Entity;
    }`;
    }

    case 'redis': {
      return `    async ${opName}(id: ${pkType}, value: unknown[]): Promise<Entity> {
      if (!Array.isArray(value)) throw new Error(\`[${entityName}] arraySet value must be an array\`);
      const deduped = ${dedupeExpr};
      const raw = await redis.get(rkey(id));
      if (!raw) throw new Error(\`[${entityName}] Not found\`);
      const r = fromRedisRecord(JSON.parse(raw) as Record<string, unknown>);
      if (!isVisible(r)) throw new Error(\`[${entityName}] Not found\`);
      r['${field}'] = deduped;
      await storeRecord(r);
      return { ...r } as Entity;
    }`;
    }
  }
}
