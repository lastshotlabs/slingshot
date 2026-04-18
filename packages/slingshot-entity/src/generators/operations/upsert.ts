/**
 * op.upsert generator — insert or update by unique key.
 */
import { toSnakeCase } from '../../lib/naming';
import type { ResolvedEntityConfig } from '../../types/entity';
import type { UpsertOpConfig } from '../../types/operations';
import type { Backend } from '../filter';

/**
 * Generate the upsert operation method body for a specific backend.
 *
 * An `upsert` operation inserts a new record or updates an existing one matched
 * by `op.match` fields. On insert the optional `op.onCreate` map applies
 * defaults (`'uuid'`, `'cuid'`, `'now'`, or a literal string). On update only
 * the `op.set` fields are written.
 *
 * The generated method signature is `async {opName}(input)`.
 *
 * Backend implementations:
 * - `memory`: iterates the store to find a match; updates in-place or inserts
 *   a new entry with `store.set(pk, …)`.
 * - `redis`: scans all keys to find a match; updates and re-serialises via
 *   `storeRecord()` or calls `storeRecord()` for the new record.
 * - `sqlite`: single `INSERT … ON CONFLICT(matchCols) DO UPDATE SET …`; then
 *   re-fetches the row to return the current state.
 * - `postgres`: `INSERT … ON CONFLICT (matchCols) DO UPDATE SET … RETURNING *`.
 * - `mongo`: `Model.findOneAndUpdate({ …match }, { $set: …, $setOnInsert: … },
 *   { upsert: true, returnDocument: 'after' })`.
 *
 * When `op.returns` includes `{ created: true }` the generated method returns
 * `{ entity: Entity, created: boolean }` instead of `Entity`. Note: for SQL
 * and Mongo backends the `created` flag is hardcoded to `false` in the
 * generated code — detecting a true insert vs update requires additional
 * instrumentation (e.g. `xmax = 0` in Postgres) that is not emitted by
 * default.
 *
 * @param opName - Operation name as declared in the entity config.
 * @param op - The upsert operation config (match fields, set fields, optional
 *   onCreate defaults, optional returns shape).
 * @param entity - The resolved entity config (used for Mongo `_id` mapping).
 * @param backend - Target backend.
 * @returns A TypeScript source string for the operation method body.
 */
export function generateUpsert(
  opName: string,
  op: UpsertOpConfig,
  entity: ResolvedEntityConfig,
  backend: Backend,
): string {
  const allFields = [...op.match, ...op.set];
  const returnsCreated = typeof op.returns === 'object' && op.returns.created;

  switch (backend) {
    case 'memory': {
      const matchCondition = op.match.map(f => `r['${f}'] === input['${f}']`).join(' && ');
      const onCreateDefaults = op.onCreate
        ? Object.entries(op.onCreate).map(([f, v]) => {
            if (v === 'uuid') return `record['${f}'] = crypto.randomUUID();`;
            if (v === 'cuid')
              return `record['${f}'] = 'c' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);`;
            if (v === 'now') return `record['${f}'] = new Date();`;
            return `record['${f}'] = '${v}';`;
          })
        : [];

      return `    async ${opName}(input) {
      // Find existing by match fields
      for (const entry of store.values()) {
        if (!isAlive(entry) || !isVisible(entry.record)) continue;
        const r = entry.record;
        if (${matchCondition}) {
          ${op.set.map(f => `if (input['${f}'] !== undefined) entry.record['${f}'] = input['${f}'];`).join('\n          ')}
          ${returnsCreated ? 'return { entity: { ...entry.record } as Entity, created: false };' : 'return { ...entry.record } as Entity;'}
        }
      }
      // Create new
      const record = { ...input };
      ${onCreateDefaults.join('\n      ')}
      const pk = record[pkField];
      store.set(pk, { record, expiresAt: ttlMs ? Date.now() + ttlMs : undefined });
      ${returnsCreated ? 'return { entity: { ...record } as Entity, created: true };' : 'return { ...record } as Entity;'}
    }`;
    }

    case 'sqlite': {
      const matchCols = op.match.map(f => toSnakeCase(f));
      const allCols = allFields.map(f => toSnakeCase(f));
      const onCreateCols = op.onCreate ? Object.keys(op.onCreate).map(f => toSnakeCase(f)) : [];
      const insertCols = [...allCols, ...onCreateCols];
      const placeholders = insertCols.map(() => '?').join(', ');
      const conflictCols = matchCols.join(', ');
      const updateCols = op.set.map(f => `${toSnakeCase(f)} = excluded.${toSnakeCase(f)}`);

      return `    async ${opName}(input) {
      ensureTable();
      const values = [${allFields.map(f => `input['${f}']`).join(', ')}${
        op.onCreate
          ? ', ' +
            Object.entries(op.onCreate)
              .map(([, v]) => {
                if (v === 'uuid') return 'crypto.randomUUID()';
                if (v === 'cuid')
                  return "'c' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8)";
                if (v === 'now') return 'Date.now()';
                return `'${v}'`;
              })
              .join(', ')
          : ''
      }];
      db.run(\`INSERT INTO \${table} (${insertCols.join(', ')}) VALUES (${placeholders}) ON CONFLICT(${conflictCols}) DO UPDATE SET ${updateCols.join(', ')}\`, values);
      const row = db.query(\`SELECT * FROM \${table} WHERE ${matchCols.map(c => `${c} = ?`).join(' AND ')}\`).get(${op.match.map(f => `input['${f}']`).join(', ')});
      return ${returnsCreated ? '{ entity: fromRow(row) as Entity, created: false }' : 'fromRow(row) as Entity'};
    }`;
    }

    case 'postgres': {
      const matchCols = op.match.map(f => toSnakeCase(f));
      const allCols = allFields.map(f => toSnakeCase(f));
      const onCreateCols = op.onCreate ? Object.keys(op.onCreate).map(f => toSnakeCase(f)) : [];
      const insertCols = [...allCols, ...onCreateCols];
      const placeholders = insertCols.map((_, i) => `$${i + 1}`).join(', ');
      const conflictCols = matchCols.join(', ');
      const updateCols = op.set.map(f => `${toSnakeCase(f)} = EXCLUDED.${toSnakeCase(f)}`);

      return `    async ${opName}(input) {
      await ensureTable();
      const values = [${allFields.map(f => `input['${f}']`).join(', ')}${
        op.onCreate
          ? ', ' +
            Object.entries(op.onCreate)
              .map(([, v]) => {
                if (v === 'uuid') return 'crypto.randomUUID()';
                if (v === 'now') return 'new Date()';
                return `'${v}'`;
              })
              .join(', ')
          : ''
      }];
      const result = await pool.query(
        \`INSERT INTO \${table} (${insertCols.join(', ')}) VALUES (${placeholders}) ON CONFLICT (${conflictCols}) DO UPDATE SET ${updateCols.join(', ')} RETURNING *\`,
        values
      );
      return ${returnsCreated ? '{ entity: fromRow(result.rows[0]) as Entity, created: false }' : 'fromRow(result.rows[0]) as Entity'};
    }`;
    }

    case 'mongo': {
      const matchQuery = op.match.map(f => {
        const fieldDef = (
          entity.fields as Record<string, (typeof entity.fields)[string] | undefined>
        )[f];
        const mongoField = fieldDef?.primary ? '_id' : f;
        return `${mongoField}: input['${f}']`;
      });
      const setFields = op.set.map(f => `${f}: input['${f}']`);
      const onInsertFields = op.onCreate
        ? Object.entries(op.onCreate).map(([f, v]) => {
            if (v === 'uuid') return `${f}: crypto.randomUUID()`;
            if (v === 'now') return `${f}: new Date()`;
            return `${f}: '${v}'`;
          })
        : [];

      return `    async ${opName}(input) {
      const Model = getModel();
      const doc = await Model.findOneAndUpdate(
        { ${matchQuery.join(', ')} },
        { $set: { ${setFields.join(', ')} }${onInsertFields.length > 0 ? `, $setOnInsert: { ${onInsertFields.join(', ')} }` : ''} },
        { upsert: true, returnDocument: 'after' }
      ).lean();
      return ${returnsCreated ? '{ entity: fromMongoDoc(doc) as Entity, created: false }' : 'fromMongoDoc(doc) as Entity'};
    }`;
    }

    case 'redis': {
      const matchCondition = op.match.map(f => `r['${f}'] === input['${f}']`).join(' && ');
      const onCreateDefaults = op.onCreate
        ? Object.entries(op.onCreate).map(([f, v]) => {
            if (v === 'uuid') return `record['${f}'] = crypto.randomUUID();`;
            if (v === 'now') return `record['${f}'] = new Date();`;
            return `record['${f}'] = '${v}';`;
          })
        : [];

      return `    async ${opName}(input) {
      const allKeys = await scanAllKeys();
      for (const key of allKeys) {
        const raw = await redis.get(key);
        if (!raw) continue;
        const r = fromRedisRecord(JSON.parse(raw));
        if (!isVisible(r)) continue;
        if (${matchCondition}) {
          ${op.set.map(f => `if (input['${f}'] !== undefined) r['${f}'] = input['${f}'];`).join('\n          ')}
          await storeRecord(r);
          ${returnsCreated ? 'return { entity: { ...r } as Entity, created: false };' : 'return { ...r } as Entity;'}
        }
      }
      const record = { ...input };
      ${onCreateDefaults.join('\n      ')}
      await storeRecord(record);
      ${returnsCreated ? 'return { entity: { ...record } as Entity, created: true };' : 'return { ...record } as Entity;'}
    }`;
    }
  }
}
