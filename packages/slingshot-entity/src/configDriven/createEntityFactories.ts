/**
 * Config-driven adapter factory generator.
 *
 * Pure runtime builder for entity repo factories. This package-side version
 * intentionally stays free of app/framework wiring so workspace packages can
 * depend on it without pulling in `src/framework`.
 */
import type {
  EntityAdapter,
  FieldDef,
  InferCreateInput,
  InferEntity,
  InferOperationMethods,
  InferUpdateInput,
  OperationConfig,
  ResolvedEntityConfig,
  RuntimeSqliteDatabase,
  SearchClientLike,
  SearchOpConfig,
  StoreInfra,
  TestableRepoFactories,
} from '@lastshotlabs/slingshot-core';
import type { ResolvedOperations } from '../types';
import { createMemoryEntityAdapter } from './memoryAdapter';
import { createMongoEntityAdapter } from './mongoAdapter';
import type { SqliteDb } from './operationExecutors/dbInterfaces';
import { searchViaProvider } from './operationExecutors/searchProvider';
import { createPostgresEntityAdapter } from './postgresAdapter';
import { createRedisEntityAdapter } from './redisAdapter';
import { createSqliteEntityAdapter } from './sqliteAdapter';

const REGISTER_ENTITY = Symbol.for('slingshot.registerEntity');
const RESOLVE_SEARCH_SYNC = Symbol.for('slingshot.resolveSearchSync');
const RESOLVE_SEARCH_CLIENT = Symbol.for('slingshot.resolveSearchClient');

type OperationsInput<Ops extends Record<string, OperationConfig>> = Ops | ResolvedOperations<Ops>;

function isResolvedOperations<Ops extends Record<string, OperationConfig>>(
  operations: OperationsInput<Ops>,
): operations is ResolvedOperations<Ops> {
  return (
    'entityConfig' in operations &&
    'operations' in operations &&
    typeof operations.operations === 'object' &&
    operations.operations !== null
  );
}

/** Typed wrapper for Reflect.get that returns unknown instead of any. */
function reflectGet(target: object, key: string | symbol): unknown {
  const result: unknown = Reflect.get(target, key) as unknown;
  return result;
}

/**
 * Adapt Bun's `RuntimeSqliteDatabase` shape to the entity runtime's local
 * `SqliteDb` interface.
 */
function adaptRuntimeSqliteToEntityDb(db: RuntimeSqliteDatabase): SqliteDb {
  return {
    run(sql: string, params?: unknown[]): { changes: number } {
      if (params !== undefined) {
        db.run(sql, ...params);
      } else {
        db.run(sql);
      }
      const row = db.query<{ changes: number }>('SELECT changes() AS changes').get();
      return { changes: row?.changes ?? 0 };
    },
    query<T>(sql: string): { get(...args: unknown[]): T | null; all(...args: unknown[]): T[] } {
      return db.query<T>(sql);
    },
  };
}

interface ResolvedWriteThroughSearchSync {
  readonly syncMode: 'write-through';
  ensureReady(): Promise<void>;
  indexDocument(document: Record<string, unknown>): Promise<void>;
  deleteDocument(documentId: string): Promise<void>;
}

interface ResolvedEventBusSearchSync {
  readonly syncMode: 'event-bus';
  readonly storageName: string;
  readonly eventBus: {
    emit(event: string, payload: unknown): void;
  };
  ensureReady(): Promise<void>;
}

interface ResolvedManualSearchSync {
  readonly syncMode: 'manual';
  ensureReady(): Promise<void>;
}

type ResolvedSearchSync =
  | ResolvedWriteThroughSearchSync
  | ResolvedEventBusSearchSync
  | ResolvedManualSearchSync;

function isResolvedSearchSync(value: unknown): value is ResolvedSearchSync {
  if (typeof value !== 'object' || value === null) return false;

  const syncMode = reflectGet(value, 'syncMode');
  if (typeof reflectGet(value, 'ensureReady') !== 'function') return false;

  if (syncMode === 'manual') {
    return true;
  }

  if (syncMode === 'event-bus') {
    const storageName = reflectGet(value, 'storageName');
    const eventBus = reflectGet(value, 'eventBus');
    const emitFn =
      typeof eventBus === 'object' && eventBus !== null ? reflectGet(eventBus, 'emit') : undefined;
    return typeof storageName === 'string' && typeof emitFn === 'function';
  }

  if (syncMode === 'write-through') {
    return (
      typeof reflectGet(value, 'indexDocument') === 'function' &&
      typeof reflectGet(value, 'deleteDocument') === 'function'
    );
  }

  return false;
}

function maybeRegisterEntity<F extends Record<string, FieldDef>>(
  config: ResolvedEntityConfig<F>,
  infra?: StoreInfra,
): void {
  if (!infra) return;

  const registerEntity = reflectGet(infra, REGISTER_ENTITY);
  if (typeof registerEntity === 'function') {
    (registerEntity as (cfg: ResolvedEntityConfig<F>) => void).call(infra, config);
  }
}

function createSearchSyncResolver<F extends Record<string, FieldDef>>(
  config: ResolvedEntityConfig<F>,
  infra?: StoreInfra,
): (() => ResolvedSearchSync | undefined) | undefined {
  if (!infra || !config.search) return undefined;

  const resolveSearchSync = reflectGet(infra, RESOLVE_SEARCH_SYNC);
  if (typeof resolveSearchSync !== 'function') return undefined;

  return () => {
    const searchSync = (resolveSearchSync as (cfg: ResolvedEntityConfig<F>) => unknown).call(
      infra,
      config,
    );
    return isResolvedSearchSync(searchSync) ? searchSync : undefined;
  };
}

function wrapWithSearchSync<
  F extends Record<string, FieldDef>,
  AdapterT extends EntityAdapter<InferEntity<F>, InferCreateInput<F>, InferUpdateInput<F>>,
>(
  adapter: AdapterT,
  config: ResolvedEntityConfig<F>,
  resolveSearchSync: () => ResolvedSearchSync | undefined,
): AdapterT {
  function getDocumentId(entity: Record<string, unknown>): string {
    return String(entity[config._pkField]);
  }

  function emitEntityEvent(
    searchSync: ResolvedEventBusSearchSync,
    action: 'created' | 'updated' | 'deleted',
    id: string,
    document?: Record<string, unknown>,
  ): void {
    const event = `entity:${searchSync.storageName}.${action}`;
    searchSync.eventBus.emit(event, document === undefined ? { id } : { id, document });
  }

  async function syncAfterCreate(entity: Record<string, unknown>): Promise<void> {
    const searchSync = resolveSearchSync();
    if (!searchSync || searchSync.syncMode === 'manual') return;

    await searchSync.ensureReady();
    const id = getDocumentId(entity);

    if (searchSync.syncMode === 'write-through') {
      try {
        await searchSync.indexDocument(entity);
      } catch (error) {
        console.error(
          `[search-sync] write-through indexDocument failed for '${config._storageName}':`,
          error,
        );
      }
      return;
    }

    emitEntityEvent(searchSync, 'created', id, entity);
  }

  async function syncAfterUpdate(entity: Record<string, unknown>): Promise<void> {
    const searchSync = resolveSearchSync();
    if (!searchSync || searchSync.syncMode === 'manual') return;

    await searchSync.ensureReady();
    const id = getDocumentId(entity);

    if (searchSync.syncMode === 'write-through') {
      try {
        await searchSync.indexDocument(entity);
      } catch (error) {
        console.error(
          `[search-sync] write-through indexDocument failed for '${config._storageName}':`,
          error,
        );
      }
      return;
    }

    emitEntityEvent(searchSync, 'updated', id, entity);
  }

  async function syncAfterDelete(id: string): Promise<void> {
    const searchSync = resolveSearchSync();
    if (!searchSync || searchSync.syncMode === 'manual') return;

    await searchSync.ensureReady();

    if (searchSync.syncMode === 'write-through') {
      try {
        await searchSync.deleteDocument(id);
      } catch (error) {
        console.error(
          `[search-sync] write-through deleteDocument failed for '${config._storageName}':`,
          error,
        );
      }
      return;
    }

    emitEntityEvent(searchSync, 'deleted', id);
  }

  const wrapped: AdapterT = {
    ...adapter,
    async create(input) {
      const entity = await adapter.create(input);
      await syncAfterCreate(entity as Record<string, unknown>);
      return entity;
    },
    async update(id, input, filter) {
      const entity = await adapter.update(id, input, filter);
      if (!entity) return null;

      await syncAfterUpdate(entity as Record<string, unknown>);
      return entity;
    },
    async delete(id, filter) {
      const deleted = await adapter.delete(id, filter);
      if (!deleted) return false;

      await syncAfterDelete(String(id));
      return true;
    },
  };
  return wrapped;
}

function deriveSearchOpsFromConfig<F extends Record<string, FieldDef>>(
  config: ResolvedEntityConfig<F>,
): Record<string, SearchOpConfig> | undefined {
  if (!config.search) return undefined;

  const searchableFields = Object.entries(config.search.fields)
    .filter(([, fieldConfig]) => fieldConfig.searchable !== false)
    .map(([fieldName]) => fieldName);
  const fields = searchableFields.length > 0 ? searchableFields : Object.keys(config.search.fields);

  return {
    search: {
      kind: 'search',
      fields,
      useSearchProvider: true,
    },
  };
}

function wrapWithSearchProviderDelegation<
  F extends Record<string, FieldDef>,
  AdapterT extends EntityAdapter<InferEntity<F>, InferCreateInput<F>, InferUpdateInput<F>>,
>(
  adapter: AdapterT,
  config: ResolvedEntityConfig<F>,
  operations: Record<string, OperationConfig>,
  infra: StoreInfra,
): AdapterT {
  if (!config.search) return adapter;

  const resolveSearchClient = reflectGet(infra, RESOLVE_SEARCH_CLIENT);
  if (typeof resolveSearchClient !== 'function') return adapter;

  const searchOps = Object.entries(operations).filter(
    (entry): entry is [string, SearchOpConfig] =>
      entry[1].kind === 'search' && entry[1].useSearchProvider !== false,
  );
  if (searchOps.length === 0) return adapter;

  let cachedClient: SearchClientLike | null | undefined;
  let ensuredReady = false;

  function getSearchClient(): SearchClientLike | null {
    if (cachedClient === undefined) {
      cachedClient = (
        resolveSearchClient as (cfg: ResolvedEntityConfig<F>) => SearchClientLike | null
      ).call(infra, config);
    }
    return cachedClient ?? null;
  }

  async function ensureReady(): Promise<void> {
    if (ensuredReady) return;

    cachedClient = undefined;
    const resolveSync = reflectGet(infra, RESOLVE_SEARCH_SYNC);
    if (typeof resolveSync === 'function') {
      const sync = (resolveSync as (cfg: ResolvedEntityConfig<F>) => unknown).call(infra, config);
      if (isResolvedSearchSync(sync)) {
        await sync.ensureReady();
      }
    }

    ensuredReady = true;
    cachedClient = undefined;
  }

  const overrides: Record<string, unknown> = {};
  for (const [opName, op] of searchOps) {
    const dbNativeMethod = reflectGet(adapter as object, opName);
    const hasDbFallback = typeof dbNativeMethod === 'function';

    const providerMethod = searchViaProvider(op, () => getSearchClient(), ensureReady);
    overrides[opName] = async (
      query: string,
      filterParams?: Record<string, unknown>,
      limit?: number,
      cursor?: string,
    ) => {
      try {
        await ensureReady();
        const client = getSearchClient();
        if (client?.search) {
          return await providerMethod(query, filterParams, limit, cursor);
        }
      } catch (err) {
        // Provider lookup or execution failed — fall back to DB-native search if available.
        if (!hasDbFallback) throw err;
      }

      if (!hasDbFallback) {
        throw new Error(
          `[op.search] Search provider is not available and no DB-native fallback exists for '${opName}'`,
        );
      }

      return (
        dbNativeMethod as (
          q: string,
          fp?: Record<string, unknown>,
          l?: number,
          c?: string,
        ) => unknown
      ).call(adapter, query, filterParams, limit, cursor);
    };
  }

  const result: AdapterT = { ...adapter, ...overrides };
  return result;
}

/**
 * Create `TestableRepoFactories` for a resolved entity config without
 * operations.
 */
export function createEntityFactories<F extends Record<string, FieldDef>>(
  config: ResolvedEntityConfig<F>,
  operations?: undefined,
): TestableRepoFactories<EntityAdapter<InferEntity<F>, InferCreateInput<F>, InferUpdateInput<F>>>;

/**
 * Create `TestableRepoFactories` for a resolved entity config with typed
 * operations.
 */
export function createEntityFactories<
  F extends Record<string, FieldDef>,
  Ops extends Record<string, OperationConfig>,
>(
  config: ResolvedEntityConfig<F>,
  operations: OperationsInput<Ops>,
): TestableRepoFactories<
  EntityAdapter<InferEntity<F>, InferCreateInput<F>, InferUpdateInput<F>> &
    InferOperationMethods<Ops, InferEntity<F>>
>;

export function createEntityFactories<
  F extends Record<string, FieldDef>,
  Ops extends Record<string, OperationConfig>,
>(
  config: ResolvedEntityConfig<F>,
  operations?: OperationsInput<Ops>,
): TestableRepoFactories<EntityAdapter<InferEntity<F>, InferCreateInput<F>, InferUpdateInput<F>>> {
  type E = InferEntity<F> & Record<string, unknown>;
  type CI = InferCreateInput<F>;
  type UI = InferUpdateInput<F>;
  const normalizedOperations = resolveOperations(operations);

  function maybeWrap<
    AdapterT extends EntityAdapter<InferEntity<F>, InferCreateInput<F>, InferUpdateInput<F>>,
  >(adapter: AdapterT, infra?: StoreInfra): AdapterT {
    maybeRegisterEntity(config, infra);

    const resolveSearchSync = createSearchSyncResolver(config, infra);
    let wrapped = resolveSearchSync
      ? wrapWithSearchSync(adapter, config, resolveSearchSync)
      : adapter;

    if (infra && (normalizedOperations || config.search)) {
      const searchOps = normalizedOperations ?? deriveSearchOpsFromConfig(config);
      if (searchOps) {
        wrapped = wrapWithSearchProviderDelegation(wrapped, config, searchOps, infra);
      }
    }

    return wrapped;
  }

  return {
    memory: (infra?: StoreInfra) =>
      maybeWrap(createMemoryEntityAdapter<E, CI, UI>(config, normalizedOperations), infra),

    redis: (infra: StoreInfra) =>
      maybeWrap(
        createRedisEntityAdapter<E, CI, UI>(
          infra.getRedis(),
          infra.appName,
          config,
          normalizedOperations,
        ),
        infra,
      ),

    sqlite: (infra: StoreInfra) =>
      maybeWrap(
        createSqliteEntityAdapter<E, CI, UI>(
          adaptRuntimeSqliteToEntityDb(infra.getSqliteDb()),
          config,
          normalizedOperations,
        ),
        infra,
      ),

    mongo: (infra: StoreInfra) =>
      maybeWrap(
        createMongoEntityAdapter<E, CI, UI>(
          (() => {
            const { conn } = infra.getMongo();
            return conn;
          })(),
          (() => {
            const { mg } = infra.getMongo();
            return mg;
          })(),
          config,
          normalizedOperations,
        ),
        infra,
      ),

    postgres: (infra: StoreInfra) =>
      maybeWrap(
        createPostgresEntityAdapter<E, CI, UI>(
          infra.getPostgres().pool,
          config,
          normalizedOperations,
        ),
        infra,
      ),
  };
}

function resolveOperations<Ops extends Record<string, OperationConfig>>(
  operations: OperationsInput<Ops> | undefined,
): Ops | undefined {
  if (!operations) return undefined;
  return isResolvedOperations(operations) ? operations.operations : operations;
}
