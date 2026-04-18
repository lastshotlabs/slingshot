/**
 * op.increment generator — atomically add a numeric delta to a field on a specific record.
 *
 * The record is looked up by primary key. The configured `by` amount (defaulting to `1`)
 * is added to the current field value. If the field is absent or non-numeric at runtime
 * it is treated as `0` before the addition.
 *
 * The `by` config default is baked into the generated code at code-gen time as `defaultBy`.
 * Callers may override it at call-time via the `by` parameter: `effectiveBy = by ?? defaultBy`.
 *
 * Generated method signature:
 * `async {opName}(id: PkType, by?: number): Promise<Entity>`
 */
import { toSnakeCase } from '../../lib/naming';
import type { ResolvedEntityConfig } from '../../types/entity';
import type { IncrementOpConfig } from '../../types/operations';
import type { Backend } from '../filter';

/**
 * Generate the increment operation method body for a specific backend.
 *
 * Locates the record by primary key, adds `effectiveBy` (resolved at runtime as
 * `by ?? defaultBy`, where `defaultBy` is baked in at code-gen time from `op.by ?? 1`)
 * to the current field value (treating non-numeric as `0`), persists the result, and
 * returns the updated entity. Throws when the record is not found.
 *
 * @param opName - Operation name as declared in the entity config.
 * @param op - The increment operation config.
 * @param entity - The resolved entity config.
 * @param backend - Target backend.
 * @returns A TypeScript source string for the operation method body.
 */
export function generateIncrement(
  opName: string,
  op: IncrementOpConfig,
  entity: ResolvedEntityConfig,
  backend: Backend,
): string {
  const entityName = entity.name;
  const field = op.field;
  const snakeField = toSnakeCase(field);
  const pkCol = toSnakeCase(entity._pkField);
  const pkDef = entity.fields[entity._pkField];
  const pkType = pkDef.type === 'string' ? 'string' : 'number';

  // Bake the config default into the generated code at code-gen time.
  const defaultBy = op.by ?? 1;

  switch (backend) {
    case 'memory': {
      return `    async ${opName}(id: ${pkType}, by?: number): Promise<Entity> {
      const entry = store.get(String(id));
      if (!entry || !isAlive(entry) || !isVisible(entry.record)) {
        throw new Error(\`[${entityName}] Not found\`);
      }
      const effectiveBy = by ?? ${defaultBy};
      const current = typeof entry.record['${field}'] === 'number' ? (entry.record['${field}'] as number) : 0;
      entry.record['${field}'] = current + effectiveBy;
      return { ...entry.record } as Entity;
    }`;
    }

    case 'sqlite': {
      return `    async ${opName}(id: ${pkType}, by?: number): Promise<Entity> {
      ensureTable();
      const effectiveBy = by ?? ${defaultBy};
      const exists = db.query(\`SELECT 1 FROM \${table} WHERE ${pkCol} = ?\`).get(id);
      if (!exists) throw new Error(\`[${entityName}] Not found\`);
      db.run(\`UPDATE \${table} SET ${snakeField} = COALESCE(${snakeField}, 0) + ? WHERE ${pkCol} = ?\`, [effectiveBy, id]);
      const updated = db.query(\`SELECT * FROM \${table} WHERE ${pkCol} = ?\`).get(id) as Record<string, unknown>;
      return fromRow(updated);
    }`;
    }

    case 'postgres': {
      return `    async ${opName}(id: ${pkType}, by?: number): Promise<Entity> {
      await ensureTable();
      const effectiveBy = by ?? ${defaultBy};
      const result = await pool.query(\`UPDATE \${table} SET ${snakeField} = COALESCE(${snakeField}, 0) + $2 WHERE ${pkCol} = $1 RETURNING *\`, [id, effectiveBy]);
      if (!result.rows[0]) throw new Error(\`[${entityName}] Not found\`);
      return fromRow(result.rows[0] as Record<string, unknown>);
    }`;
    }

    case 'mongo': {
      return `    async ${opName}(id: ${pkType}, by?: number): Promise<Entity> {
      const effectiveBy = by ?? ${defaultBy};
      const Model = getModel();
      const result = await Model.updateOne({ _id: id }, { $inc: { ${field}: effectiveBy } });
      if (result.matchedCount === 0) throw new Error(\`[${entityName}] Not found\`);
      const doc = await Model.findOne({ _id: id }).lean();
      if (!doc) throw new Error(\`[${entityName}] Not found\`);
      return fromMongoDoc(doc) as Entity;
    }`;
    }

    case 'redis': {
      return `    async ${opName}(id: ${pkType}, by?: number): Promise<Entity> {
      const effectiveBy = by ?? ${defaultBy};
      const raw = await redis.get(rkey(id));
      if (!raw) throw new Error(\`[${entityName}] Not found\`);
      const r = fromRedisRecord(JSON.parse(raw) as Record<string, unknown>);
      if (!isVisible(r)) throw new Error(\`[${entityName}] Not found\`);
      const current = typeof r['${field}'] === 'number' ? (r['${field}'] as number) : 0;
      r['${field}'] = current + effectiveBy;
      await storeRecord(r);
      return { ...r } as Entity;
    }`;
    }
  }
}
