/**
 * op.collection generator — CRUD on sub-entity scoped to parent.
 *
 * Generates multiple methods (list, add, remove, update, set)
 * based on the operations config.
 *
 * Storage: Memory uses separate Map, SQL uses separate table,
 * Mongo uses embedded array, Redis uses separate key namespace.
 */
import { toSnakeCase } from '../../lib/naming';
import type { ResolvedEntityConfig } from '../../types/entity';
import type { CollectionOpConfig } from '../../types/operations';
import type { Backend } from '../filter';

/**
 * Generate all collection sub-operation method bodies for a specific backend.
 *
 * A `collection` operation manages an ordered list of sub-entity items scoped
 * to a parent record. This function iterates `op.operations` (which may include
 * `'list'`, `'add'`, `'remove'`, `'update'`, `'set'`) and delegates each to
 * the corresponding backend-specific generator. The returned strings are joined
 * with `',\n\n'` for embedding inside the adapter factory return object.
 *
 * Storage strategy per backend:
 * - `memory`: a separate `Map<parentKey, items[]>` stored in the factory closure.
 * - `sqlite` / `postgres`: a separate join table `{table}_{opName}` created by
 *   `ensureCollectionTable_{opName}()`.
 * - `mongo`: an embedded array field `{opName}` on the parent document.
 * - `redis`: a separate key `{prefix}collection:{opName}:{parentKey}` storing a
 *   JSON-serialised array.
 *
 * @param opName - Operation name as declared in the entity config.
 * @param op - The collection operation config.
 * @param entity - The resolved entity config.
 * @param backend - Target backend.
 * @returns A TypeScript source string containing one or more method bodies,
 *   joined with `',\n\n'`.
 *
 * @remarks
 * The `update` sub-operation delegates to `{opName}List` and `{opName}Set` for
 * all non-memory backends to avoid duplicating persistence logic.
 */
export function generateCollection(
  opName: string,
  op: CollectionOpConfig,
  entity: ResolvedEntityConfig,
  backend: Backend,
): string {
  const methods: string[] = [];

  for (const operation of op.operations) {
    switch (operation) {
      case 'list':
        methods.push(generateCollectionList(opName, op, entity, backend));
        break;
      case 'add':
        methods.push(generateCollectionAdd(opName, op, entity, backend));
        break;
      case 'remove':
        methods.push(generateCollectionRemove(opName, op, entity, backend));
        break;
      case 'update':
        methods.push(generateCollectionUpdate(opName, op, entity, backend));
        break;
      case 'set':
        methods.push(generateCollectionSet(opName, op, entity, backend));
        break;
    }
  }

  return methods.join(',\n\n');
}

function generateCollectionList(
  opName: string,
  op: CollectionOpConfig,
  entity: ResolvedEntityConfig,
  backend: Backend,
): string {
  switch (backend) {
    case 'memory':
      return `    async ${opName}List(${op.parentKey}) {
      const collectionStore = collectionStores['${opName}'] ?? new Map();
      return collectionStore.get(${op.parentKey}) ?? [];
    }`;
    case 'sqlite':
      return `    async ${opName}List(${op.parentKey}) {
      ensureCollectionTable_${opName}();
      return db.query(\`SELECT * FROM \${table}_${opName} WHERE ${toSnakeCase(op.parentKey)} = ?\`).all(${op.parentKey});
    }`;
    case 'postgres':
      return `    async ${opName}List(${op.parentKey}) {
      await ensureCollectionTable_${opName}();
      const result = await pool.query(\`SELECT * FROM \${table}_${opName} WHERE ${toSnakeCase(op.parentKey)} = $1\`, [${op.parentKey}]);
      return result.rows;
    }`;
    case 'mongo':
      return `    async ${opName}List(${op.parentKey}) {
      const Model = getModel();
      const doc = await Model.findOne({ _id: ${op.parentKey} }).lean();
      return doc?.${opName} ?? [];
    }`;
    case 'redis':
      return `    async ${opName}List(${op.parentKey}) {
      const raw = await redis.get(\`\${prefix}collection:${opName}:\${${op.parentKey}}\`);
      return raw ? JSON.parse(raw) : [];
    }`;
  }
}

function generateCollectionAdd(
  opName: string,
  op: CollectionOpConfig,
  entity: ResolvedEntityConfig,
  backend: Backend,
): string {
  const maxItemsCheck = op.maxItems
    ? typeof op.maxItems === 'number'
      ? `\n      if (items.length >= ${op.maxItems}) items.shift();`
      : `\n      if (items.length >= ${op.maxItems.startsWith('param:') ? op.maxItems.slice(6) : op.maxItems}) items.shift();`
    : '';

  switch (backend) {
    case 'memory':
      return `    async ${opName}Add(${op.parentKey}, item) {
      if (!collectionStores['${opName}']) collectionStores['${opName}'] = new Map();
      const items = collectionStores['${opName}'].get(${op.parentKey}) ?? [];${maxItemsCheck}
      items.push(item);
      collectionStores['${opName}'].set(${op.parentKey}, items);
      return item;
    }`;
    case 'sqlite': {
      const cols = Object.keys(op.itemFields);
      const snakeCols = [toSnakeCase(op.parentKey), ...cols.map(c => toSnakeCase(c))];
      const placeholders = snakeCols.map(() => '?').join(', ');
      return `    async ${opName}Add(${op.parentKey}, item) {
      ensureCollectionTable_${opName}();
      db.run(\`INSERT INTO \${table}_${opName} (${snakeCols.join(', ')}) VALUES (${placeholders})\`, [${op.parentKey}, ${cols.map(c => `item['${c}']`).join(', ')}]);
      return item;
    }`;
    }
    case 'postgres': {
      const cols = Object.keys(op.itemFields);
      const snakeCols = [toSnakeCase(op.parentKey), ...cols.map(c => toSnakeCase(c))];
      const placeholders = snakeCols.map((_, i) => `$${i + 1}`).join(', ');
      return `    async ${opName}Add(${op.parentKey}, item) {
      await ensureCollectionTable_${opName}();
      await pool.query(\`INSERT INTO \${table}_${opName} (${snakeCols.join(', ')}) VALUES (${placeholders})\`, [${op.parentKey}, ${cols.map(c => `item['${c}']`).join(', ')}]);
      return item;
    }`;
    }
    case 'mongo':
      return `    async ${opName}Add(${op.parentKey}, item) {
      const Model = getModel();
      await Model.updateOne({ _id: ${op.parentKey} }, { $push: { ${opName}: item } });
      return item;
    }`;
    case 'redis':
      return `    async ${opName}Add(${op.parentKey}, item) {
      const key = \`\${prefix}collection:${opName}:\${${op.parentKey}}\`;
      const raw = await redis.get(key);
      const items = raw ? JSON.parse(raw) : [];${maxItemsCheck}
      items.push(item);
      await redis.set(key, JSON.stringify(items));
      return item;
    }`;
  }
}

function generateCollectionRemove(
  opName: string,
  op: CollectionOpConfig,
  entity: ResolvedEntityConfig,
  backend: Backend,
): string {
  const idField = op.identifyBy ?? 'id';

  switch (backend) {
    case 'memory':
      return `    async ${opName}Remove(${op.parentKey}, ${idField}) {
      if (!collectionStores['${opName}']) return;
      const items = collectionStores['${opName}'].get(${op.parentKey}) ?? [];
      collectionStores['${opName}'].set(${op.parentKey}, items.filter(i => i['${idField}'] !== ${idField}));
    }`;
    case 'sqlite':
      return `    async ${opName}Remove(${op.parentKey}, ${idField}) {
      ensureCollectionTable_${opName}();
      db.run(\`DELETE FROM \${table}_${opName} WHERE ${toSnakeCase(op.parentKey)} = ? AND ${toSnakeCase(idField)} = ?\`, [${op.parentKey}, ${idField}]);
    }`;
    case 'postgres':
      return `    async ${opName}Remove(${op.parentKey}, ${idField}) {
      await ensureCollectionTable_${opName}();
      await pool.query(\`DELETE FROM \${table}_${opName} WHERE ${toSnakeCase(op.parentKey)} = $1 AND ${toSnakeCase(idField)} = $2\`, [${op.parentKey}, ${idField}]);
    }`;
    case 'mongo':
      return `    async ${opName}Remove(${op.parentKey}, ${idField}) {
      const Model = getModel();
      await Model.updateOne({ _id: ${op.parentKey} }, { $pull: { ${opName}: { ${idField}: ${idField} } } });
    }`;
    case 'redis':
      return `    async ${opName}Remove(${op.parentKey}, ${idField}) {
      const key = \`\${prefix}collection:${opName}:\${${op.parentKey}}\`;
      const raw = await redis.get(key);
      if (!raw) return;
      const items = JSON.parse(raw).filter(i => i['${idField}'] !== ${idField});
      await redis.set(key, JSON.stringify(items));
    }`;
  }
}

function generateCollectionUpdate(
  opName: string,
  op: CollectionOpConfig,
  entity: ResolvedEntityConfig,
  backend: Backend,
): string {
  const idField = op.identifyBy ?? 'id';

  switch (backend) {
    case 'memory':
      return `    async ${opName}Update(${op.parentKey}, ${idField}, updates) {
      if (!collectionStores['${opName}']) throw new Error('Item not found');
      const items = collectionStores['${opName}'].get(${op.parentKey}) ?? [];
      const item = items.find(i => i['${idField}'] === ${idField});
      if (!item) throw new Error('Item not found');
      Object.assign(item, updates);
      return { ...item };
    }`;
    case 'sqlite':
    case 'postgres':
    case 'mongo':
    case 'redis':
      // Simplified — update specific item in collection
      return `    async ${opName}Update(${op.parentKey}, ${idField}, updates) {
      const items = await this.${opName}List(${op.parentKey});
      const idx = items.findIndex(i => i['${idField}'] === ${idField});
      if (idx === -1) throw new Error('Item not found');
      Object.assign(items[idx], updates);
      await this.${opName}Set(${op.parentKey}, items);
      return { ...items[idx] };
    }`;
  }
}

function generateCollectionSet(
  opName: string,
  op: CollectionOpConfig,
  entity: ResolvedEntityConfig,
  backend: Backend,
): string {
  switch (backend) {
    case 'memory':
      return `    async ${opName}Set(${op.parentKey}, items) {
      if (!collectionStores['${opName}']) collectionStores['${opName}'] = new Map();
      collectionStores['${opName}'].set(${op.parentKey}, [...items]);
    }`;
    case 'sqlite':
      return `    async ${opName}Set(${op.parentKey}, items) {
      ensureCollectionTable_${opName}();
      db.run(\`DELETE FROM \${table}_${opName} WHERE ${toSnakeCase(op.parentKey)} = ?\`, [${op.parentKey}]);
      for (const item of items) {
        await this.${opName}Add(${op.parentKey}, item);
      }
    }`;
    case 'postgres':
      return `    async ${opName}Set(${op.parentKey}, items) {
      await ensureCollectionTable_${opName}();
      await pool.query(\`DELETE FROM \${table}_${opName} WHERE ${toSnakeCase(op.parentKey)} = $1\`, [${op.parentKey}]);
      for (const item of items) {
        await this.${opName}Add(${op.parentKey}, item);
      }
    }`;
    case 'mongo':
      return `    async ${opName}Set(${op.parentKey}, items) {
      const Model = getModel();
      await Model.updateOne({ _id: ${op.parentKey} }, { $set: { ${opName}: items } });
    }`;
    case 'redis':
      return `    async ${opName}Set(${op.parentKey}, items) {
      const key = \`\${prefix}collection:${opName}:\${${op.parentKey}}\`;
      await redis.set(key, JSON.stringify(items));
    }`;
  }
}
