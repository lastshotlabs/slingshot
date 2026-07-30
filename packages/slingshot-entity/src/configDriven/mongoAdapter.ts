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
  EntityConcurrencyConflictError,
  HttpError,
  evaluateFilter,
} from '@lastshotlabs/slingshot-core';
import { resolveExpectedVersion } from '../concurrency/writeGuards';
import {
  applyDefaults,
  applyOnUpdate,
  buildCursorForRecord,
  coerceToDate,
  compareForSort,
  decodeCursor,
  fromMongoDoc,
  storageName,
  toMongoDoc,
} from './fieldUtils';
import { resolveListFilter } from './listFilter';
import { buildMongoOperations } from './mongoOperationWiring';
import type { MongoFindQuery } from './operationExecutors/dbInterfaces';

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
  init?(): Promise<unknown>;
  create(document: Record<string, unknown>): Promise<unknown>;
  findOne(filter: Record<string, unknown>, projection?: string): MongooseQuery;
  findOneAndUpdate(
    filter: Record<string, unknown>,
    update: Record<string, unknown>,
    opts?: Record<string, unknown>,
  ): MongooseQuery;
  findOneAndDelete(filter: Record<string, unknown>): MongooseQuery;
  find(filter: Record<string, unknown>): MongooseFindQuery;
  updateOne(
    filter: Record<string, unknown>,
    update: Record<string, unknown>,
    opts?: Record<string, unknown>,
  ): Promise<{
    modifiedCount: number;
    matchedCount: number;
    upsertedCount?: number;
    upsertedId?: unknown;
  }>;
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

function isMongoDuplicateError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const candidate = error as { code?: unknown; message?: unknown };
  return (
    candidate.code === 11000 ||
    (typeof candidate.message === 'string' && /duplicate key error/i.test(candidate.message))
  );
}

/** Creates a MongoDB-backed {@link EntityAdapter} for the given entity config. */
export function createMongoEntityAdapter<Entity, CreateInput, UpdateInput>(
  conn: Connection,
  mongoosePkg: MongooseModule,
  config: ResolvedEntityConfig,
  operations?: Record<string, OperationConfig>,
): EntityAdapter<Entity, CreateInput, UpdateInput> & Record<string, unknown> {
  const collectionName = storageName(config, 'mongo');
  const pkField = config._pkField;
  const mongoPkField = config._storageFields.mongoPkField;
  const mongoTtlField = config._storageFields.mongoTtlField;
  const ttlSeconds = config.ttl?.defaultSeconds;
  const customAutoDefault = config._conventions?.autoDefault;
  const customOnUpdate = config._conventions?.onUpdate;

  const defaultLimit = config.pagination?.defaultLimit ?? 50;
  const maxLimit = config.pagination?.maxLimit ?? 200;
  const cursorFields = [
    ...new Set([
      ...(config.defaultSort ? [config.defaultSort.field] : []),
      ...(config.pagination?.cursor.fields ?? [pkField]),
      pkField,
    ]),
  ];
  const defaultSortDir = config.defaultSort?.direction ?? 'asc';

  // Derive PascalCase model name from collection
  const modelName = collectionName
    .split(/[_\s-]/)
    .map(s => s.charAt(0).toUpperCase() + s.slice(1))
    .join('');

  let cachedModel: MongooseModel | null = null;
  const collectionModels = new Map<string, MongooseModel>();
  const modelInitialization = new WeakMap<MongooseModel, Promise<void>>();

  function beginModelInitialization(model: MongooseModel): void {
    if (modelInitialization.has(model)) return;
    const ready =
      typeof model.init === 'function' ? model.init().then(() => undefined) : Promise.resolve();
    modelInitialization.set(model, ready);
  }

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
      beginModelInitialization(cachedModel);
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
      schemaDef[mongoTtlField] = { type: Date, required: true };
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

    // MongoDB permits one text index per collection. Merge every configured
    // search operation into that index so `$text` works from the first query.
    if (operations) {
      const textIndex: Record<string, unknown> = {};
      for (const operation of Object.values(operations)) {
        if (operation.kind !== 'search') continue;
        for (const field of operation.fields) textIndex[field] = 'text';
      }
      if (Object.keys(textIndex).length > 0) schema.index(textIndex);
    }

    // TTL index
    if (ttlSeconds) {
      schema.index({ [mongoTtlField]: 1 }, { expireAfterSeconds: 0 });
    }

    // Opaque mongoose boundary — our minimal MongooseSchema wrapper satisfies mongoose.Schema at runtime
    cachedModel = conn.model(
      modelName,
      schema as unknown as Parameters<typeof conn.model>[1],
    ) as unknown as MongooseModel;
    beginModelInitialization(cachedModel);
    return cachedModel;
  }

  async function getReadyModel(): Promise<MongooseModel> {
    const model = getModel();
    await modelInitialization.get(model);
    return model;
  }

  function getCollectionModel(operationName: string): MongooseModel {
    const cached = collectionModels.get(operationName);
    if (cached) return cached;
    const operation = operations?.[operationName];
    if (!operation || operation.kind !== 'collection') {
      throw new Error(`[${config.name}] Unknown collection operation '${operationName}'`);
    }

    const itemSchema: Record<string, unknown> = {};
    for (const [fieldName, fieldDef] of Object.entries(operation.itemFields)) {
      const fieldSchema: Record<string, unknown> = {
        type: mongooseType(fieldDef.type, mongoosePkg),
      };
      if (!fieldDef.optional) fieldSchema['required'] = true;
      if (fieldDef.enumValues) fieldSchema['enum'] = [...fieldDef.enumValues];
      itemSchema[fieldName] = fieldSchema;
    }

    const collectionSchema = new mongoosePkg.Schema(
      {
        [mongoPkField]: {
          type: mongooseType(config.fields[pkField].type, mongoosePkg),
          required: true,
        },
        [operationName]: { type: [itemSchema], default: [] },
      },
      { collection: `${collectionName}__${operationName}` },
    );
    const operationModelName = operationName
      .split(/[_\s-]/)
      .map(value => value.charAt(0).toUpperCase() + value.slice(1))
      .join('');
    const collectionModelName = `${modelName}${operationModelName}Collection`;
    const existing = (conn.models as Record<string, unknown>)[collectionModelName] as
      | MongooseModel
      | undefined;
    const model =
      existing ??
      (conn.model(
        collectionModelName,
        collectionSchema as unknown as Parameters<typeof conn.model>[1],
      ) as unknown as MongooseModel);
    collectionModels.set(operationName, model);
    beginModelInitialization(model);
    return model;
  }

  function readyOperationModel(getRawModel: () => MongooseModel) {
    const ready = async (): Promise<MongooseModel> => {
      const model = getRawModel();
      beginModelInitialization(model);
      await modelInitialization.get(model);
      return model;
    };
    const wrapFind = (filter: Record<string, unknown>, limit?: number): MongoFindQuery => ({
      limit: (n: number) => wrapFind(filter, n),
      lean: async () => {
        const query = (await ready()).find(filter);
        return (limit === undefined ? query : query.limit(limit)).lean();
      },
    });
    return {
      findOne: (filter: Record<string, unknown>) => ({
        lean: async () => (await ready()).findOne(filter).lean(),
      }),
      findOneAndUpdate: (
        filter: Record<string, unknown>,
        update: Record<string, unknown>,
        opts?: Record<string, unknown>,
      ) => ({
        lean: async () => (await ready()).findOneAndUpdate(filter, update, opts).lean(),
      }),
      findOneAndDelete: (filter: Record<string, unknown>) => ({
        lean: async () => (await ready()).findOneAndDelete(filter).lean(),
      }),
      find: (filter: Record<string, unknown>) => wrapFind(filter),
      updateOne: async (
        filter: Record<string, unknown>,
        update: Record<string, unknown>,
        opts?: Record<string, unknown>,
      ) => (await ready()).updateOne(filter, update, opts),
      updateMany: async (filter: Record<string, unknown>, update: Record<string, unknown>) =>
        (await ready()).updateMany(filter, update),
      deleteOne: async (filter: Record<string, unknown>) => (await ready()).deleteOne(filter),
      deleteMany: async (filter: Record<string, unknown>) => (await ready()).deleteMany(filter),
      aggregate: async (pipeline: Array<Record<string, unknown>>) =>
        (await ready()).aggregate(pipeline),
    };
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
   * Adds `{ [mongoTtlField]: { $gt: new Date() } }` when the entity has TTL
   * configuration. MongoDB's own TTL index will eventually remove expired
   * documents, but this filter prevents them from being returned during the
   * window between expiry and the next TTL sweep.
   *
   * @returns A query fragment object, or `{}` when TTL is not configured.
   */
  function notExpiredFilter(): Record<string, unknown> {
    if (!ttlSeconds) return {};
    return { [mongoTtlField]: { $gt: new Date() } };
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
      const Model = await getReadyModel();
      const record = applyDefaults(
        input as Record<string, unknown>,
        config.fields,
        customAutoDefault,
      );
      const doc = toMongoDoc(record, config);

      if (ttlSeconds) {
        doc[mongoTtlField] = new Date(Date.now() + ttlSeconds * 1000);
      }

      try {
        await Model.create(doc);
      } catch (error) {
        if (isMongoDuplicateError(error)) {
          throw new HttpError(409, 'Unique constraint violated', 'UNIQUE_VIOLATION');
        }
        throw error;
      }
      const created: Entity = { ...record } as unknown as Entity;
      return created;
    },

    async getById(id, filter) {
      const Model = await getReadyModel();
      const doc = await Model.findOne({
        [mongoPkField]: id,
        ...baseFilter(),
        ...filterQuery(filter),
      }).lean();
      if (!doc) return null;
      return fromMongoDoc(doc, config) as Entity;
    },

    async update(id, input, filter, options) {
      const Model = await getReadyModel();
      const concurrency = config._concurrency;
      const expectedVersion = resolveExpectedVersion(config, 'update', options);
      const scopedQuery = { [mongoPkField]: id, ...baseFilter(), ...filterQuery(filter) };
      const query = { ...scopedQuery };
      if (expectedVersion !== undefined && concurrency) {
        query[concurrency.field] = expectedVersion;
      }

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
        $set[mongoTtlField] = new Date(Date.now() + ttlSeconds * 1000);
      }

      if (Object.keys($set).length === 0 && !concurrency) {
        const current = await Model.findOne(query).lean();
        if (!current) return null;
        return fromMongoDoc(current, config) as Entity;
      }

      let updated: Record<string, unknown> | null;
      try {
        const update: Record<string, unknown> = { $set };
        if (concurrency) {
          update.$inc = { [concurrency.field]: 1 };
        }
        updated = await Model.findOneAndUpdate(query, update, { returnDocument: 'after' }).lean();
      } catch (error) {
        if (isMongoDuplicateError(error)) {
          throw new HttpError(409, 'Unique constraint violated', 'UNIQUE_VIOLATION');
        }
        throw error;
      }
      if (!updated) {
        if (expectedVersion !== undefined) {
          const exists = await Model.findOne(scopedQuery).lean();
          if (exists) {
            throw new EntityConcurrencyConflictError(config.name, id, expectedVersion);
          }
        }
        return null;
      }
      return fromMongoDoc(updated, config) as Entity;
    },

    async delete(id, filter, options) {
      const Model = await getReadyModel();
      const concurrency = config._concurrency;
      const expectedVersion = resolveExpectedVersion(config, 'delete', options);
      const scopedQuery = { [mongoPkField]: id, ...baseFilter(), ...filterQuery(filter) };
      const query = { ...scopedQuery };
      if (expectedVersion !== undefined && concurrency) {
        query[concurrency.field] = expectedVersion;
      }

      let deleted: boolean;
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
        const update: Record<string, unknown> = { $set };
        if (concurrency) {
          update.$inc = { [concurrency.field]: 1 };
        }
        deleted =
          (await Model.findOneAndUpdate(query, update, { returnDocument: 'after' }).lean()) !==
          null;
      } else {
        deleted = (await Model.findOneAndDelete(query).lean()) !== null;
      }
      if (!deleted && expectedVersion !== undefined) {
        const exists = await Model.findOne(scopedQuery).lean();
        if (exists) {
          throw new EntityConcurrencyConflictError(config.name, id, expectedVersion);
        }
      }
      return deleted;
    },

    async list(opts) {
      const Model = await getReadyModel();
      const sortDir = opts?.sortDir ?? defaultSortDir;
      const rawLimit = opts?.limit ?? defaultLimit;
      if (!Number.isSafeInteger(rawLimit) || rawLimit < 1 || rawLimit > maxLimit) {
        throw new RangeError(
          `list limit must be an integer between 1 and ${maxLimit}; received ${String(rawLimit)}`,
        );
      }
      const limit = rawLimit;
      const filter = resolveListFilter(opts as Record<string, unknown> | undefined);

      const docs = await Model.find(baseFilter()).sort({}).lean();
      const visible = docs
        .map(doc => fromMongoDoc(doc, config))
        .filter(record => !filter || evaluateFilter(record, filter));
      visible.sort((a, b) => compareForSort(a, b, cursorFields, sortDir));

      let startIndex = 0;
      if (opts?.cursor) {
        const cursorValues = decodeCursor(opts.cursor);
        const cursorIndex = visible.findIndex(record =>
          cursorFields.every(field => {
            const recordValue = record[field];
            const cursorValue =
              config.fields[field].type === 'date'
                ? coerceToDate(cursorValues[field])
                : cursorValues[field];
            return recordValue instanceof Date && cursorValue instanceof Date
              ? recordValue.getTime() === cursorValue.getTime()
              : recordValue === cursorValue;
          }),
        );
        startIndex = cursorIndex >= 0 ? cursorIndex + 1 : 0;
      }

      const pageRecords = visible.slice(startIndex, startIndex + limit + 1);
      const hasMore = pageRecords.length > limit;
      const items = pageRecords.slice(0, limit) as Entity[];

      let nextCursor: string | undefined;
      if (hasMore && items.length > 0) {
        nextCursor = buildCursorForRecord(pageRecords[limit - 1], cursorFields);
      }

      return { items, nextCursor, hasMore };
    },

    async clear() {
      await (await getReadyModel()).deleteMany({});
    },

    ...(operations
      ? buildMongoOperations(
          operations,
          config,
          () => readyOperationModel(getModel),
          operationName => readyOperationModel(() => getCollectionModel(operationName)),
        )
      : {}),
  };
}
