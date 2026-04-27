import { describe, expect, test } from 'bun:test';
import {
  RESOLVE_COMPOSITE_FACTORIES,
  RESOLVE_ENTITY_FACTORIES,
  RESOLVE_REINDEX_SOURCE,
  createEntityRegistry,
  createInProcessAdapter,
  defineEntity,
  field,
} from '@lastshotlabs/slingshot-core';
import { createContextStoreInfra } from '../../src/framework/persistence/createContextStoreInfra';
import {
  REGISTER_ENTITY,
  RESOLVE_SEARCH_CLIENT,
  RESOLVE_SEARCH_SYNC,
} from '../../src/framework/persistence/internalRepoResolution';

function createMinimalInfra(overrides: Record<string, unknown> = {}) {
  return {
    redis: null,
    mongo: null,
    sqliteDb: null,
    postgres: null,
    ...overrides,
  } as any;
}

const TestEntity = defineEntity('TestEntity', {
  namespace: 'test',
  fields: {
    id: field.string({ primary: true }),
    name: field.string(),
  },
});

const SearchableEntity = defineEntity('SearchableEntity', {
  namespace: 'test',
  fields: {
    id: field.string({ primary: true }),
    body: field.string(),
  },
  search: {
    fields: { body: { searchable: true } },
  },
});

describe('createContextStoreInfra', () => {
  test('returns an object with appName', () => {
    const entityRegistry = createEntityRegistry();
    const infra = createContextStoreInfra({
      appName: 'my-app',
      infra: createMinimalInfra(),
      bus: createInProcessAdapter(),
      pluginState: new Map(),
      entityRegistry,
    });

    expect(infra.appName).toBe('my-app');
  });

  test('getRedis throws when redis is not configured', () => {
    const entityRegistry = createEntityRegistry();
    const infra = createContextStoreInfra({
      appName: 'test',
      infra: createMinimalInfra({ redis: null }),
      bus: createInProcessAdapter(),
      pluginState: new Map(),
      entityRegistry,
    });

    expect(() => infra.getRedis()).toThrow('Redis is not configured');
  });

  test('getRedis returns redis when configured', () => {
    const mockRedis = { ping: () => 'PONG' };
    const entityRegistry = createEntityRegistry();
    const infra = createContextStoreInfra({
      appName: 'test',
      infra: createMinimalInfra({ redis: mockRedis }),
      bus: createInProcessAdapter(),
      pluginState: new Map(),
      entityRegistry,
    });

    expect(infra.getRedis()).toBe(mockRedis as unknown as ReturnType<typeof infra.getRedis>);
  });

  test('getMongo throws when mongo is not configured', () => {
    const entityRegistry = createEntityRegistry();
    const infra = createContextStoreInfra({
      appName: 'test',
      infra: createMinimalInfra({ mongo: null }),
      bus: createInProcessAdapter(),
      pluginState: new Map(),
      entityRegistry,
    });

    expect(() => infra.getMongo()).toThrow('Mongo app connection is not configured');
  });

  test('getMongo returns connection when configured', () => {
    const mockMongo = { auth: null, app: { db: {} }, mongoose: {} };
    const entityRegistry = createEntityRegistry();
    const infra = createContextStoreInfra({
      appName: 'test',
      infra: createMinimalInfra({ mongo: mockMongo }),
      bus: createInProcessAdapter(),
      pluginState: new Map(),
      entityRegistry,
    });

    const result = infra.getMongo();
    expect(result.conn).toBe(mockMongo.app as ReturnType<typeof infra.getMongo>['conn']);
    expect(result.mg).toBe(mockMongo.mongoose as ReturnType<typeof infra.getMongo>['mg']);
  });

  test('getSqliteDb throws when sqlite is not configured', () => {
    const entityRegistry = createEntityRegistry();
    const infra = createContextStoreInfra({
      appName: 'test',
      infra: createMinimalInfra({ sqliteDb: null }),
      bus: createInProcessAdapter(),
      pluginState: new Map(),
      entityRegistry,
    });

    expect(() => infra.getSqliteDb()).toThrow('SQLite is not configured');
  });

  test('getSqliteDb returns db when configured', () => {
    const mockDb = { query: () => {} };
    const entityRegistry = createEntityRegistry();
    const infra = createContextStoreInfra({
      appName: 'test',
      infra: createMinimalInfra({ sqliteDb: mockDb }),
      bus: createInProcessAdapter(),
      pluginState: new Map(),
      entityRegistry,
    });

    expect(infra.getSqliteDb()).toBe(mockDb as unknown as ReturnType<typeof infra.getSqliteDb>);
  });

  test('getPostgres throws when postgres is not configured', () => {
    const entityRegistry = createEntityRegistry();
    const infra = createContextStoreInfra({
      appName: 'test',
      infra: createMinimalInfra({ postgres: null }),
      bus: createInProcessAdapter(),
      pluginState: new Map(),
      entityRegistry,
    });

    expect(() => infra.getPostgres()).toThrow('Postgres is not configured');
  });

  test('getPostgres returns pool when configured', () => {
    const mockPg = { pool: { query: () => {} }, db: null };
    const entityRegistry = createEntityRegistry();
    const infra = createContextStoreInfra({
      appName: 'test',
      infra: createMinimalInfra({ postgres: mockPg }),
      bus: createInProcessAdapter(),
      pluginState: new Map(),
      entityRegistry,
    });

    expect(infra.getPostgres()).toBe(mockPg as unknown as ReturnType<typeof infra.getPostgres>);
  });

  test('REGISTER_ENTITY registers an entity config in the registry', () => {
    const entityRegistry = createEntityRegistry();
    const infra = createContextStoreInfra({
      appName: 'test',
      infra: createMinimalInfra(),
      bus: createInProcessAdapter(),
      pluginState: new Map(),
      entityRegistry,
    });

    const registerFn = infra[REGISTER_ENTITY] as (config: any) => void;
    registerFn(TestEntity);

    const allEntities = entityRegistry.getAll();
    expect(allEntities.some((e: any) => e._storageName === TestEntity._storageName)).toBe(true);
  });

  test('REGISTER_ENTITY is idempotent (skips duplicate registration)', () => {
    const entityRegistry = createEntityRegistry();
    const infra = createContextStoreInfra({
      appName: 'test',
      infra: createMinimalInfra(),
      bus: createInProcessAdapter(),
      pluginState: new Map(),
      entityRegistry,
    });

    const registerFn = infra[REGISTER_ENTITY] as (config: any) => void;
    registerFn(TestEntity);
    registerFn(TestEntity); // second call should be a no-op

    const allEntities = entityRegistry.getAll();
    const matches = allEntities.filter((e: any) => e._storageName === TestEntity._storageName);
    expect(matches.length).toBe(1);
  });

  test('RESOLVE_SEARCH_CLIENT returns null when entity has no search config', () => {
    const entityRegistry = createEntityRegistry();
    const infra = createContextStoreInfra({
      appName: 'test',
      infra: createMinimalInfra(),
      bus: createInProcessAdapter(),
      pluginState: new Map(),
      entityRegistry,
    });

    const resolveFn = infra[RESOLVE_SEARCH_CLIENT] as (config: any) => any;
    const result = resolveFn(TestEntity);
    expect(result).toBeNull();
  });

  test('RESOLVE_SEARCH_CLIENT returns null when search plugin is not installed', () => {
    const entityRegistry = createEntityRegistry();
    const infra = createContextStoreInfra({
      appName: 'test',
      infra: createMinimalInfra(),
      bus: createInProcessAdapter(),
      pluginState: new Map(),
      entityRegistry,
    });

    const resolveFn = infra[RESOLVE_SEARCH_CLIENT] as (config: any) => any;
    const result = resolveFn(SearchableEntity);
    expect(result).toBeNull();
  });

  test('RESOLVE_SEARCH_SYNC returns undefined when entity has no search config', () => {
    const entityRegistry = createEntityRegistry();
    const infra = createContextStoreInfra({
      appName: 'test',
      infra: createMinimalInfra(),
      bus: createInProcessAdapter(),
      pluginState: new Map(),
      entityRegistry,
    });

    const resolveFn = infra[RESOLVE_SEARCH_SYNC] as (config: any) => any;
    const result = resolveFn(TestEntity);
    expect(result).toBeUndefined();
  });

  test('RESOLVE_SEARCH_SYNC returns undefined when search plugin is not installed', () => {
    const entityRegistry = createEntityRegistry();
    const infra = createContextStoreInfra({
      appName: 'test',
      infra: createMinimalInfra(),
      bus: createInProcessAdapter(),
      pluginState: new Map(),
      entityRegistry,
    });

    const resolveFn = infra[RESOLVE_SEARCH_SYNC] as (config: any) => any;
    const result = resolveFn(SearchableEntity);
    expect(result).toBeUndefined();
  });

  test('object is non-extensible (preventExtensions)', () => {
    const entityRegistry = createEntityRegistry();
    const infra = createContextStoreInfra({
      appName: 'test',
      infra: createMinimalInfra(),
      bus: createInProcessAdapter(),
      pluginState: new Map(),
      entityRegistry,
    });

    expect(Object.isExtensible(infra)).toBe(false);
  });

  test('appName property is read-only', () => {
    const entityRegistry = createEntityRegistry();
    const infra = createContextStoreInfra({
      appName: 'test',
      infra: createMinimalInfra(),
      bus: createInProcessAdapter(),
      pluginState: new Map(),
      entityRegistry,
    });

    expect(() => {
      (infra as any).appName = 'changed';
    }).toThrow();
    expect(infra.appName).toBe('test');
  });
});

describe('resolveSearchSync helper (via RESOLVE_SEARCH_SYNC)', () => {
  test('returns manual sync descriptor when syncMode is manual', () => {
    const entityRegistry = createEntityRegistry();
    const manualEntity = defineEntity('ManualSearchEntity', {
      namespace: 'test',
      fields: {
        id: field.string({ primary: true }),
        body: field.string(),
      },
      search: {
        syncMode: 'manual',
        fields: { body: { searchable: true } },
      },
    });

    const infra = createContextStoreInfra({
      appName: 'test',
      infra: createMinimalInfra(),
      bus: createInProcessAdapter(),
      pluginState: new Map(),
      entityRegistry,
    });

    const resolveFn = infra[RESOLVE_SEARCH_SYNC] as (config: any) => any;
    const result = resolveFn(manualEntity);
    expect(result).toBeDefined();
    expect(result.syncMode).toBe('manual');
    expect(typeof result.ensureReady).toBe('function');
  });

  test('returns undefined for event-bus sync when search plugin is not installed', () => {
    const entityRegistry = createEntityRegistry();
    const eventBusEntity = defineEntity('EventBusSearchEntity', {
      namespace: 'test',
      fields: {
        id: field.string({ primary: true }),
        body: field.string(),
      },
      search: {
        syncMode: 'event-bus',
        fields: { body: { searchable: true } },
      },
    });

    const infra = createContextStoreInfra({
      appName: 'test',
      infra: createMinimalInfra(),
      bus: createInProcessAdapter(),
      pluginState: new Map(),
      entityRegistry,
    });

    const resolveFn = infra[RESOLVE_SEARCH_SYNC] as (config: any) => any;
    const result = resolveFn(eventBusEntity);
    expect(result).toBeUndefined();
  });

  test('returns write-through sync descriptor when search plugin is installed', () => {
    const entityRegistry = createEntityRegistry();
    const pluginState = new Map<string, unknown>();
    const mockSearchClient = {
      indexDocument: async () => {},
      removeDocument: async () => {},
      search: async () => ({ hits: [], total: 0 }),
    };
    pluginState.set('slingshot-search', {
      ensureConfigEntity: async () => {},
      getSearchClient: () => mockSearchClient,
    });

    const infra = createContextStoreInfra({
      appName: 'test',
      infra: createMinimalInfra(),
      bus: createInProcessAdapter(),
      pluginState,
      entityRegistry,
    });

    const resolveFn = infra[RESOLVE_SEARCH_SYNC] as (config: any) => any;
    const result = resolveFn(SearchableEntity);
    expect(result).toBeDefined();
    expect(result.syncMode).toBe('write-through');
    expect(typeof result.ensureReady).toBe('function');
    expect(typeof result.indexDocument).toBe('function');
    expect(typeof result.deleteDocument).toBe('function');
  });

  test('write-through indexDocument calls search client', async () => {
    const entityRegistry = createEntityRegistry();
    const pluginState = new Map<string, unknown>();
    const indexedDocs: unknown[] = [];
    const mockSearchClient = {
      indexDocument: async (doc: unknown) => {
        indexedDocs.push(doc);
      },
      removeDocument: async () => {},
      search: async () => ({ hits: [], total: 0 }),
    };
    pluginState.set('slingshot-search', {
      ensureConfigEntity: async () => {},
      getSearchClient: () => mockSearchClient,
    });

    const infra = createContextStoreInfra({
      appName: 'test',
      infra: createMinimalInfra(),
      bus: createInProcessAdapter(),
      pluginState,
      entityRegistry,
    });

    const resolveFn = infra[RESOLVE_SEARCH_SYNC] as (config: any) => any;
    const result = resolveFn(SearchableEntity);
    await result.indexDocument({ id: '1', body: 'test' });
    expect(indexedDocs).toHaveLength(1);
  });

  test('write-through deleteDocument calls search client', async () => {
    const entityRegistry = createEntityRegistry();
    const pluginState = new Map<string, unknown>();
    const removedIds: string[] = [];
    const mockSearchClient = {
      indexDocument: async () => {},
      removeDocument: async (id: string) => {
        removedIds.push(id);
      },
      search: async () => ({ hits: [], total: 0 }),
    };
    pluginState.set('slingshot-search', {
      ensureConfigEntity: async () => {},
      getSearchClient: () => mockSearchClient,
    });

    const infra = createContextStoreInfra({
      appName: 'test',
      infra: createMinimalInfra(),
      bus: createInProcessAdapter(),
      pluginState,
      entityRegistry,
    });

    const resolveFn = infra[RESOLVE_SEARCH_SYNC] as (config: any) => any;
    const result = resolveFn(SearchableEntity);
    await result.deleteDocument('doc-1');
    expect(removedIds).toEqual(['doc-1']);
  });

  test('returns event-bus sync descriptor when search plugin is installed', () => {
    const entityRegistry = createEntityRegistry();
    const pluginState = new Map<string, unknown>();
    pluginState.set('slingshot-search', {
      ensureConfigEntity: async () => {},
      getSearchClient: () => null,
    });

    const eventBusEntity2 = defineEntity('EventBusSearchEntity2', {
      namespace: 'test',
      fields: {
        id: field.string({ primary: true }),
        body: field.string(),
      },
      search: {
        syncMode: 'event-bus',
        fields: { body: { searchable: true } },
      },
    });

    const bus = createInProcessAdapter();
    const infra = createContextStoreInfra({
      appName: 'test',
      infra: createMinimalInfra(),
      bus,
      pluginState,
      entityRegistry,
    });

    const resolveFn = infra[RESOLVE_SEARCH_SYNC] as (config: any) => any;
    const result = resolveFn(eventBusEntity2);
    expect(result).toBeDefined();
    expect(result.syncMode).toBe('event-bus');
    expect(result.storageName).toBe(eventBusEntity2._storageName);
    expect(typeof result.ensureReady).toBe('function');
  });
});

describe('search integration (via symbols)', () => {
  test('RESOLVE_SEARCH_CLIENT returns search client when search plugin is installed', () => {
    const entityRegistry = createEntityRegistry();
    const pluginState = new Map<string, unknown>();
    const mockSearchClient = {
      indexDocument: async () => {},
      removeDocument: async () => {},
      search: async () => ({ hits: [], total: 0 }),
    };
    pluginState.set('slingshot-search', {
      ensureConfigEntity: async () => {},
      getSearchClient: () => mockSearchClient,
    });

    const infra = createContextStoreInfra({
      appName: 'test',
      infra: createMinimalInfra(),
      bus: createInProcessAdapter(),
      pluginState,
      entityRegistry,
    });

    const resolveFn = infra[RESOLVE_SEARCH_CLIENT] as (config: any) => any;
    const result = resolveFn(SearchableEntity);
    expect(result).toBe(mockSearchClient);
  });

  test('REGISTER_ENTITY with searchable entity calls ensureConfigEntity best-effort', async () => {
    const entityRegistry = createEntityRegistry();
    const pluginState = new Map<string, unknown>();
    let ensureCalled = false;
    pluginState.set('slingshot-search', {
      ensureConfigEntity: async () => {
        ensureCalled = true;
      },
      getSearchClient: () => null,
    });

    const infra = createContextStoreInfra({
      appName: 'test',
      infra: createMinimalInfra(),
      bus: createInProcessAdapter(),
      pluginState,
      entityRegistry,
    });

    const registerFn = infra[REGISTER_ENTITY] as (config: any) => void;
    registerFn(SearchableEntity);

    // ensureConfigEntityBestEffort is fire-and-forget, give it a tick
    await new Promise(r => setTimeout(r, 10));
    expect(ensureCalled).toBe(true);
  });

  test('REGISTER_ENTITY with searchable entity catches and logs ensureConfigEntity errors', async () => {
    const entityRegistry = createEntityRegistry();
    const pluginState = new Map<string, unknown>();
    pluginState.set('slingshot-search', {
      ensureConfigEntity: async () => {
        throw new Error('search init failed');
      },
      getSearchClient: () => null,
    });

    const infra = createContextStoreInfra({
      appName: 'test',
      infra: createMinimalInfra(),
      bus: createInProcessAdapter(),
      pluginState,
      entityRegistry,
    });

    const registerFn = infra[REGISTER_ENTITY] as (config: any) => void;
    // Should not throw — error is caught and logged
    registerFn(SearchableEntity);

    // Give the fire-and-forget promise time to resolve
    await new Promise(r => setTimeout(r, 10));
    // Entity should still be registered
    const allEntities = entityRegistry.getAll();
    expect(allEntities.some((e: any) => e._storageName === SearchableEntity._storageName)).toBe(
      true,
    );
  });

  test('RESOLVE_REINDEX_SOURCE default returns null', () => {
    const entityRegistry = createEntityRegistry();
    const infra = createContextStoreInfra({
      appName: 'test',
      infra: createMinimalInfra(),
      bus: createInProcessAdapter(),
      pluginState: new Map(),
      entityRegistry,
    });

    const resolveFn = Reflect.get(infra, RESOLVE_REINDEX_SOURCE) as (storageName: string) => null;
    expect(resolveFn('any-entity')).toBeNull();
  });

  test('RESOLVE_ENTITY_FACTORIES and RESOLVE_COMPOSITE_FACTORIES are set', () => {
    const entityRegistry = createEntityRegistry();
    const infra = createContextStoreInfra({
      appName: 'test',
      infra: createMinimalInfra(),
      bus: createInProcessAdapter(),
      pluginState: new Map(),
      entityRegistry,
    });

    expect(typeof Reflect.get(infra, RESOLVE_ENTITY_FACTORIES)).toBe('function');
    expect(typeof Reflect.get(infra, RESOLVE_COMPOSITE_FACTORIES)).toBe('function');
  });

  test('event-bus sync returns undefined when bus has no emit function (line 150 branch)', () => {
    const entityRegistry = createEntityRegistry();
    const pluginState = new Map<string, unknown>();
    pluginState.set('slingshot-search', {
      ensureConfigEntity: async () => {},
      getSearchClient: () => null,
    });

    const eventBusEntity3 = defineEntity('EventBusNoEmit', {
      namespace: 'test',
      fields: {
        id: field.string({ primary: true }),
        body: field.string(),
      },
      search: {
        syncMode: 'event-bus',
        fields: { body: { searchable: true } },
      },
    });

    // Bus without an emit function — triggers the typeof bus.emit !== 'function' branch
    const busWithoutEmit = {} as any;

    const infra = createContextStoreInfra({
      appName: 'test',
      infra: createMinimalInfra(),
      bus: busWithoutEmit,
      pluginState,
      entityRegistry,
    });

    const resolveFn = infra[RESOLVE_SEARCH_SYNC] as (config: any) => any;
    const result = resolveFn(eventBusEntity3);
    expect(result).toBeUndefined();
  });

  test('write-through indexDocument short-circuits when search client returns null (line 168)', async () => {
    const entityRegistry = createEntityRegistry();
    const pluginState = new Map<string, unknown>();
    pluginState.set('slingshot-search', {
      ensureConfigEntity: async () => {},
      getSearchClient: () => null, // returns null — no client available
    });

    const infra = createContextStoreInfra({
      appName: 'test',
      infra: createMinimalInfra(),
      bus: createInProcessAdapter(),
      pluginState,
      entityRegistry,
    });

    const resolveFn = infra[RESOLVE_SEARCH_SYNC] as (config: any) => any;
    const result = resolveFn(SearchableEntity);
    expect(result).toBeDefined();
    expect(result.syncMode).toBe('write-through');

    // indexDocument should not throw when client is null
    await result.indexDocument({ id: '1', body: 'test' });
  });

  test('write-through deleteDocument short-circuits when search client returns null (line 174)', async () => {
    const entityRegistry = createEntityRegistry();
    const pluginState = new Map<string, unknown>();
    pluginState.set('slingshot-search', {
      ensureConfigEntity: async () => {},
      getSearchClient: () => null, // returns null — no client available
    });

    const infra = createContextStoreInfra({
      appName: 'test',
      infra: createMinimalInfra(),
      bus: createInProcessAdapter(),
      pluginState,
      entityRegistry,
    });

    const resolveFn = infra[RESOLVE_SEARCH_SYNC] as (config: any) => any;
    const result = resolveFn(SearchableEntity);
    expect(result).toBeDefined();

    // deleteDocument should not throw when client is null
    await result.deleteDocument('doc-1');
  });

  test('event-bus ensureReady exercises ensureConfigEntityReady', async () => {
    const entityRegistry = createEntityRegistry();
    const pluginState = new Map<string, unknown>();
    let ensureCalled = false;
    pluginState.set('slingshot-search', {
      ensureConfigEntity: async () => {
        ensureCalled = true;
      },
      getSearchClient: () => null,
    });

    const eventBusEntity4 = defineEntity('EventBusEnsureReady', {
      namespace: 'test',
      fields: {
        id: field.string({ primary: true }),
        body: field.string(),
      },
      search: {
        syncMode: 'event-bus',
        fields: { body: { searchable: true } },
      },
    });

    const infra = createContextStoreInfra({
      appName: 'test',
      infra: createMinimalInfra(),
      bus: createInProcessAdapter(),
      pluginState,
      entityRegistry,
    });

    const resolveFn = infra[RESOLVE_SEARCH_SYNC] as (config: any) => any;
    const result = resolveFn(eventBusEntity4);
    expect(result).toBeDefined();
    expect(result.syncMode).toBe('event-bus');

    await result.ensureReady();
    expect(ensureCalled).toBe(true);
  });

  test('write-through indexDocument short-circuits when ensureConfigEntityReady returns null (line 167)', async () => {
    const entityRegistry = createEntityRegistry();
    const pluginState = new Map<string, unknown>();
    // Install search plugin initially so RESOLVE_SEARCH_SYNC returns write-through
    pluginState.set('slingshot-search', {
      ensureConfigEntity: async () => {},
      getSearchClient: () => ({ indexDocument: async () => {}, removeDocument: async () => {} }),
    });

    const infra = createContextStoreInfra({
      appName: 'test',
      infra: createMinimalInfra(),
      bus: createInProcessAdapter(),
      pluginState,
      entityRegistry,
    });

    const resolveFn = infra[RESOLVE_SEARCH_SYNC] as (config: any) => any;
    const result = resolveFn(SearchableEntity);
    expect(result).toBeDefined();

    // Now remove the search plugin so ensureConfigEntityReady returns null
    pluginState.delete('slingshot-search');

    // indexDocument should not throw — runtime is null, so client is undefined via ?.
    await result.indexDocument({ id: '1', body: 'test' });
  });

  test('write-through deleteDocument short-circuits when ensureConfigEntityReady returns null (line 173)', async () => {
    const entityRegistry = createEntityRegistry();
    const pluginState = new Map<string, unknown>();
    pluginState.set('slingshot-search', {
      ensureConfigEntity: async () => {},
      getSearchClient: () => ({ indexDocument: async () => {}, removeDocument: async () => {} }),
    });

    const infra = createContextStoreInfra({
      appName: 'test',
      infra: createMinimalInfra(),
      bus: createInProcessAdapter(),
      pluginState,
      entityRegistry,
    });

    const resolveFn = infra[RESOLVE_SEARCH_SYNC] as (config: any) => any;
    const result = resolveFn(SearchableEntity);
    expect(result).toBeDefined();

    // Remove search plugin so ensureConfigEntityReady returns null
    pluginState.delete('slingshot-search');

    // deleteDocument should not throw — runtime?.getSearchClient is undefined
    await result.deleteDocument('doc-1');
  });

  test('calling ensureReady on write-through sync descriptor exercises ensureConfigEntityReady', async () => {
    const entityRegistry = createEntityRegistry();
    const pluginState = new Map<string, unknown>();
    let ensureCalled = false;
    pluginState.set('slingshot-search', {
      ensureConfigEntity: async () => {
        ensureCalled = true;
      },
      getSearchClient: () => ({
        indexDocument: async () => {},
        removeDocument: async () => {},
      }),
    });

    const infra = createContextStoreInfra({
      appName: 'test',
      infra: createMinimalInfra(),
      bus: createInProcessAdapter(),
      pluginState,
      entityRegistry,
    });

    const resolveFn = infra[RESOLVE_SEARCH_SYNC] as (config: any) => any;
    const result = resolveFn(SearchableEntity);
    expect(result).toBeDefined();

    await result.ensureReady();
    expect(ensureCalled).toBe(true);
  });
});
