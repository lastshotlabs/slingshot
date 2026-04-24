/**
 * Config-driven MongoDB adapter generator.
 *
 * Lazily creates a Mongoose model from the entity config, including compound
 * indices, TTL expiration, soft-delete, cursor pagination, and tenant scoping.
 */
import type { Connection } from 'mongoose';
import type {
  EntityAdapter,
  FieldType,
  OperationConfig,
  ResolvedEntityConfig,
} from '@lastshotlabs/slingshot-core';
import {
  applyDefaults,
  applyOnUpdate,
  buildCursorForRecord,
  coerceToDate,
  decodeCursor,
  fromMongoDoc,
  storageName,
  toMongoDoc,
} from './fieldUtils';
import { resolveListFilter } from './listFilter';
import { buildMongoOperations } from './mongoOperationWiring';

// ---------------------------------------------------------------------------
// Mongoose type wrappers — keeps mongoose out of the import graph unless used
// ---------------------------------------------------------------------------

interface MongooseModule {
  Schema: {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    new (def: any, opts?: any): MongooseSchema;
    Types: { Mixed: unknown };
  };
}

interface MongooseSchema {
  index(fields: Record<string, unknown>, options?: Record<string, unknown>): void;
}

interface MongooseModel {
  findOne(filter: Record<string, unknown>, projection?: string): MongooseQuery;
  find(filter: Record<string, unknown>): MongooseFindQuery;
  updateOne(
    filter: Record<string, unknown>,
    update: Record<string, unknown>,
    opts?: Record<string, unknown>,
  ): Promise<{ modifiedCount: number; matchedCount: number }>;
  updateMany(
    filter: Record<string, unknown>,
    update: Record<string, unknown>,
  ): Promise<{ modifiedCount: number }>;
  deleteOne(filter: Record<string, unknown>): Promise<{ deletedCount: number }>;
  deleteMany(filter: Record<string, unknown>): Promise<{ deletedCount: number }>;
  countDocuments(filter: Record<string, unknown>): Promise<number>;
  aggregate(pipeline: Array<Record<string, unknown>>): Promise<Array<Record<string, unknown>>>;
}

interface MongooseQuery {
  lean(): Promise<Record<string, unknown> | null>;
}

interface MongooseFindQuery {
  sort(spec: Record<string, number>): MongooseFindQuery;
  skip(n: number): MongooseFindQuery;
  limit(n: number): MongooseFindQuery;
  lean(): Promise<Array<Record<string, unknown>>>;
}

// ---------------------------------------------------------------------------
// Field type → Mongoose type mapping
// ---------------------------------------------------------------------------

/**
 * Map a framework `FieldType` to the corresponding Mongoose schema type.
 *
 * - `string` / `enum` → `String`
 * - `number` / `integer` → `Number`
 * - `boolean` → `Boolean`
 * - `date` → `Date`
 * - `json` → `mg.Schema.Types.Mixed` (arbitrary sub-document)
 * - `string[]` → `[String]` (Mongoose array-of-strings shorthand)
 *
 * @param fieldType - The framework field type from the entity definition.
 * @param mg - The mongoose module, used to access `Schema.Types.Mixed`.
 * @returns The Mongoose schema type value suitable for use in a schema
 *   definition object.
 */
function mongooseType(fieldType: FieldType, mg: MongooseModule): unknown {
  switch (fieldType) {
    case 'string':
    case 'enum':
      return String;
    case 'number':
    case 'integer':
      return Number;
    case 'boolean':
      return Boolean;
    case 'date':
      return Date;
    case 'json':
      return mg.Schema.Types.Mixed;
    case 'string[]':
      return [String];
  }
}

// ---------------------------------------------------------------------------
// Adapter implementation
// ---------------------------------------------------------------------------

/**
 * Create a MongoDB-backed {@link EntityAdapter} for the given entity config.
 *
 * Lazily creates a Mongoose model from the entity config, including compound
 * indexes, TTL expiration, soft-delete, cursor pagination, and tenant scoping.
 * The PK field is mapped to the configured Mongo PK storage field
 * (`config._storageFields.mongoPkField`, default `'_id'`).
 *
 * @param conn - The Mongoose connection to the MongoDB database.
 * @param mongoosePkg - The Mongoose module, used to create schemas and models.
 * @param config - The resolved entity config with fields, indexes, and conventions.
 * @param operations - Optional named operation configs for the entity.
 * @returns An {@link EntityAdapter} with CRUD methods backed by MongoDB.
 *
 * @see {@link EntityStorageFieldMap} for customising the Mongo PK field name.
 */
export function createMongoEntityAdapter<Entity, CreateInput, UpdateInput>(
  conn: Connection,
  mongoosePkg: MongooseModule,
  config: ResolvedEntityConfig,
  operations?: Record<string, OperationConfig>,
): EntityAdapter<Entity, CreateInput, UpdateInput> & Record<string, unknown> {
  const collectionName = storageName(config, 'mongo');
  const pkField = config._pkField;
  const mongoPkField = config._storageFields.mongoPkField;
  const ttlSeconds = config.ttl?.defaultSeconds;
  const customAutoDefault = config._conventions?.autoDefault;
  const customOnUpdate = config._conventions?.onUpdate;

  const defaultLimit = config.pagination?.defaultLimit ?? 50;
  const maxLimit = config.pagination?.maxLimit ?? 200;
  const cursorFields = config.pagination?.cursor.fields ?? [pkField];
  const defaultSortDir = config.defaultSort?.direction ?? 'asc';

  // Derive PascalCase model name from collection
  const modelName = collectionName
    .split(/[_\s-]/)
    .map(s => s.charAt(0).toUpperCase() + s.slice(1))
    .join('');

  let cachedModel: MongooseModel | null = null;

  /**
   * Return the Mongoose model for this entity, creating it on first call.
   *
   * Checks the connection's model cache (`conn.models`) before registering a
   * new schema, so re-using an existing connection across multiple
   * `createMongoEntityAdapter` calls for the same entity does not throw
   * "Cannot overwrite model once compiled". The model is also cached in the
   * closure variable `cachedModel` to avoid the `conn.models` lookup on
   * subsequent calls.
   *
   * @returns The Mongoose model for the entity's collection.
   */
  function getModel(): MongooseModel {
    if (cachedModel) return cachedModel;
    if ((conn.models as Record<string, unknown>)[modelName]) {
      cachedModel = (conn.models as Record<string, unknown>)[modelName] as MongooseModel;
      return cachedModel;
    }

    // Build Mongoose schema definition
    const schemaDef: Record<string, unknown> = {};

    for (const [name, def] of Object.entries(config.fields)) {
      const mType = mongooseType(def.type, mongoosePkg);

      if (def.primary) {
        schemaDef[mongoPkField] = { type: mType, required: true };
        continue;
      }

      const fieldSchema: Record<string, unknown> = { type: mType };
      if (!def.optional) fieldSchema['required'] = true;
      if (
        def.default !== undefined &&
        def.default !== 'uuid' &&
        def.default !== 'now' &&
        def.default !== 'cuid'
      ) {
        fieldSchema['default'] = def.default;
      }
      if (def.enumValues) {
        fieldSchema['enum'] = [...def.enumValues];
      }
      schemaDef[name] = fieldSchema;
    }

    // TTL tracking field
    if (ttlSeconds) {
      schemaDef['_expiresAt'] = { type: Date, required: true };
    }

    const schema = new mongoosePkg.Schema(schemaDef, { collection: collectionName });

    // Compound indexes
    if (config.indexes) {
      for (const idx of config.indexes) {
        const spec: Record<string, number> = {};
        for (const f of idx.fields) {
          spec[f] = idx.direction === 'desc' ? -1 : 1;
        }
        schema.index(spec, idx.unique ? { unique: true } : {});
      }
    }

    // Unique constraints
    if (config.uniques) {
      for (const uq of config.uniques) {
        const spec: Record<string, number> = {};
        for (const f of uq.fields) spec[f] = 1;
        schema.index(spec, { unique: true });
      }
    }

    // TTL index
    if (ttlSeconds) {
      schema.index({ _expiresAt: 1 }, { expireAfterSeconds: 0 });
    }

    // Opaque mongoose boundary — our minimal MongooseSchema wrapper satisfies mongoose.Schema at runtime
    cachedModel = conn.model(
      modelName,
      schema as unknown as Parameters<typeof conn.model>[1],
    ) as unknown as MongooseModel;
    return cachedModel;
  }

  /**
   * Build a MongoDB query fragment that excludes soft-deleted documents.
   *
   * - **Value-based soft-delete**: adds `{ [field]: { $ne: value } }` to exclude
   *   documents whose field equals the deleted-sentinel value.
   * - **Null-check soft-delete**: adds `{ [field]: null }` to exclude documents
   *   whose field is non-null (i.e. a `deletedAt` timestamp is present).
   * - **No soft-delete config**: returns an empty object (no filter added).
   *
   * @returns A query fragment object, or `{}` when soft-delete is not configured.
   */
  function notDeletedFilter(): Record<string, unknown> {
    if (!config.softDelete) return {};
    if ('value' in config.softDelete) {
      return { [config.softDelete.field]: { $ne: config.softDelete.value } };
    }
    return { [config.softDelete.field]: null };
  }

  /**
   * Build a MongoDB query fragment that excludes TTL-expired documents.
   *
   * Adds `{ _expiresAt: { $gt: new Date() } }` when the entity has TTL
   * configuration. MongoDB's own TTL index will eventually remove expired
   * documents, but this filter prevents them from being returned during the
   * window between expiry and the next TTL sweep.
   *
   * @returns A query fragment object, or `{}` when TTL is not configured.
   */
  function notExpiredFilter(): Record<string, unknown> {
    if (!ttlSeconds) return {};
    return { _expiresAt: { $gt: new Date() } };
  }

  /**
   * Merge the soft-delete and TTL exclusion filters into a single base query
   * fragment suitable for combining with other query conditions.
   *
   * @returns A MongoDB query filter object that excludes soft-deleted and
   *   TTL-expired documents.
   */
  function baseFilter(): Record<string, unknown> {
    return { ...notDeletedFilter(), ...notExpiredFilter() };
  }

  function filterQuery(filter: Record<string, unknown> | undefined): Record<string, unknown> {
    const query: Record<string, unknown> = {};
    if (!filter) return query;

    for (const [key, val] of Object.entries(filter)) {
      if (val === undefined) continue;
      if (key === 'limit' || key === 'cursor' || key === 'sortDir') continue;
      if (!(key in config.fields)) continue;

      const targetKey = config.fields[key].primary ? mongoPkField : key;
      if (config.fields[key].type === 'date' && typeof val === 'string') {
        query[targetKey] = new Date(val);
      } else {
        query[targetKey] = val;
      }
    }

    return query;
  }

  return {
    async create(input) {
      const Model = getModel();
      const record = applyDefaults(
        input as Record<string, unknown>,
        config.fields,
        customAutoDefault,
      );
      const doc = toMongoDoc(record, config);

      if (ttlSeconds) {
        doc['_expiresAt'] = new Date(Date.now() + ttlSeconds * 1000);
      }

      await Model.updateOne({ _id: doc._id }, { $set: doc }, { upsert: true });
      const created: Entity = { ...record } as unknown as Entity;
      return created;
    },

    async getById(id, filter) {
      const Model = getModel();
      const doc = await Model.findOne({ _id: id, ...baseFilter(), ...filterQuery(filter) }).lean();
      if (!doc) return null;
      return fromMongoDoc(doc, config) as Entity;
    },

    async update(id, input, filter) {
      const Model = getModel();
      const query = { _id: id, ...baseFilter(), ...filterQuery(filter) };

      const updatePayload = applyOnUpdate(
        input as Record<string, unknown>,
        config.fields,
        customOnUpdate,
      );
      const $set: Record<string, unknown> = {};
      for (const [name, val] of Object.entries(updatePayload)) {
        if (val !== undefined && !config.fields[name].primary) {
          const def = config.fields[name];
          if (def.type === 'date' && !(val instanceof Date)) {
            $set[name] = coerceToDate(val);
          } else {
            $set[name] = val;
          }
        }
      }

      if (ttlSeconds) {
        $set['_expiresAt'] = new Date(Date.now() + ttlSeconds * 1000);
      }

      if (Object.keys($set).length === 0) {
        const current = await Model.findOne(query).lean();
        if (!current) return null;
        return fromMongoDoc(current, config) as Entity;
      }

      const result = await Model.updateOne(query, { $set });
      if ((result.modifiedCount || result.matchedCount || 0) === 0) {
        return null;
      }

      const updated = await Model.findOne(query).lean();
      if (!updated) return null;
      return fromMongoDoc(updated, config) as Entity;
    },

    async delete(id, filter) {
      const Model = getModel();
      const query = { _id: id, ...baseFilter(), ...filterQuery(filter) };

      if (config.softDelete) {
        const onUpdatePayload = applyOnUpdate({}, config.fields, customOnUpdate);
        const $set: Record<string, unknown> = {
          [config.softDelete.field]:
            'value' in config.softDelete ? config.softDelete.value : new Date(),
        };
        for (const [name, val] of Object.entries(onUpdatePayload)) {
          if (!config.fields[name].primary) {
            $set[name] = val;
          }
        }
        const result = await Model.updateOne(query, { $set });
        return (result.matchedCount || result.modifiedCount || 0) > 0;
      } else {
        const result = await Model.deleteOne(query);
        return (result.deletedCount || 0) > 0;
      }
    },

    async list(opts) {
      const Model = getModel();
      const sortDir = opts?.sortDir ?? defaultSortDir;
      const rawLimit = opts?.limit ?? defaultLimit;
      const limit = Math.min(rawLimit, maxLimit);
      const filter = resolveListFilter(opts as Record<string, unknown> | undefined);

      const query: Record<string, unknown> = { ...baseFilter() };

      // Apply filter parameters
      if (filter) {
        for (const [key, val] of Object.entries(filter)) {
          if (val === undefined) continue;
          if (!(key in config.fields)) continue;

          if (config.fields[key].primary) {
            query[mongoPkField] = val;
          } else {
            query[key] = val;
          }
        }
      }

      // Cursor condition
      if (opts?.cursor) {
        const cursorValues = decodeCursor(opts.cursor);
        const op = sortDir === 'desc' ? '$lt' : '$gt';

        if (cursorFields.length === 1) {
          const f = cursorFields[0];
          const mongoField = config.fields[f].primary ? mongoPkField : f;
          let cv = cursorValues[f];
          if (config.fields[f].type === 'date' && typeof cv === 'string') cv = new Date(cv);
          query[mongoField] = { [op]: cv };
        } else {
          // Multi-field cursor: use $or for tie-breaking
          const orClauses: Array<Record<string, unknown>> = [];
          for (let i = 0; i < cursorFields.length; i++) {
            const clause: Record<string, unknown> = {};
            for (let j = 0; j < i; j++) {
              const f = cursorFields[j];
              const mongoField = config.fields[f].primary ? mongoPkField : f;
              let cv = cursorValues[f];
              if (config.fields[f].type === 'date' && typeof cv === 'string') cv = new Date(cv);
              clause[mongoField] = cv;
            }
            const f = cursorFields[i];
            const mongoField = config.fields[f].primary ? mongoPkField : f;
            let cv = cursorValues[f];
            if (config.fields[f].type === 'date' && typeof cv === 'string') cv = new Date(cv);
            clause[mongoField] = { [op]: cv };
            orClauses.push(clause);
          }
          query['$or'] = orClauses;
        }
      }

      // Sort spec
      const sortSpec: Record<string, number> = {};
      for (const f of cursorFields) {
        const mongoField = config.fields[f].primary ? mongoPkField : f;
        sortSpec[mongoField] = sortDir === 'desc' ? -1 : 1;
      }

      const docs = await Model.find(query)
        .sort(sortSpec)
        .limit(limit + 1)
        .lean();

      const hasMore = docs.length > limit;
      const pageDocs = docs.slice(0, limit);
      const items = pageDocs.map(doc => fromMongoDoc(doc, config) as Entity);

      let nextCursor: string | undefined;
      if (hasMore && pageDocs.length > 0) {
        const lastDoc = fromMongoDoc(pageDocs[pageDocs.length - 1], config);
        nextCursor = buildCursorForRecord(lastDoc, cursorFields);
      }

      return { items, nextCursor, hasMore };
    },

    async clear() {
      try {
        await getModel().deleteMany({});
      } catch {
        /* best-effort */
      }
    },

    ...(operations
      ? buildMongoOperations(operations, config, () => {
          const model = getModel();
          // Adapt MongooseModel to the executor's MongoModelLike interface
          // MongooseFindQuery has lean() but also sort/skip/limit — executors only need lean()
          return {
            findOne: (filter: Record<string, unknown>) => model.findOne(filter),
            find: (filter: Record<string, unknown>) => ({ lean: () => model.find(filter).lean() }),
            updateOne: (
              f: Record<string, unknown>,
              u: Record<string, unknown>,
              o?: Record<string, unknown>,
            ) => model.updateOne(f, u, o),
            updateMany: (f: Record<string, unknown>, u: Record<string, unknown>) =>
              model.updateMany(f, u),
            deleteOne: (f: Record<string, unknown>) => model.deleteOne(f),
            deleteMany: (f: Record<string, unknown>) => model.deleteMany(f),
            aggregate: (p: Array<Record<string, unknown>>) => model.aggregate(p),
          };
        })
      : {}),
  };
}
