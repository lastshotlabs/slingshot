import { describe, expect, mock, test } from 'bun:test';
import {
  createDeleteStorageFileMiddleware,
  createOrphanedKeyRegistry,
} from '../../src/middleware/deleteStorageFile';
import type { Asset, AssetAdapter, OrphanedKeyRecord } from '../../src/types';

function makeEventEnvelope(event: string, payload: unknown) {
  return {
    key: event,
    payload,
    meta: {
      eventId: 'test-event-id',
      occurredAt: new Date().toISOString(),
      ownerPlugin: 'test',
      exposure: ['internal'],
      scope: null,
      requestTenantId: null,
    },
  } as never;
}

function makeEventDefinitions() {
  return {
    register: mock(() => {}),
    get: mock(() => undefined),
    has: mock(() => false),
    list: mock(() => []),
    freeze: mock(() => {}),
    frozen: false,
  };
}

function makeAsset(id = 'asset-1'): Asset {
  return {
    id,
    key: `uploads/${id}.txt`,
    ownerUserId: 'user-1',
    tenantId: null,
    mimeType: 'text/plain',
    size: 12,
    bucket: null,
    originalName: `${id}.txt`,
    createdAt: new Date().toISOString(),
  };
}

function makeContext(id: string | undefined, status = 204) {
  return {
    req: {
      param(name: string) {
        return name === 'id' ? id : undefined;
      },
    },
    res: { status },
  };
}

function makeAssetAdapter(asset: Asset | null): AssetAdapter {
  return {
    create: mock(async input => ({ ...makeAsset(String(input.id ?? 'asset-new')), ...input })),
    getById: mock(async () => asset),
    list: mock(async () => ({ items: asset ? [asset] : [], hasMore: false })),
    update: mock(async () => asset),
    delete: mock(async () => true),
    clear: mock(async () => {}),
    listByOwner: mock(async () => ({ items: asset ? [asset] : [], hasMore: false })),
    existsByKey: mock(async () => asset !== null),
    findByKey: mock(async () => asset),
  };
}

describe('deleteStorageFile middleware — onOrphanedKey callback', () => {
  test('calls onOrphanedKey with the orphaned record after retries exhausted', async () => {
    const asset = makeAsset();
    const storageDelete = mock(async () => {
      throw new Error('permanent storage outage');
    });
    const orphanedRecords: OrphanedKeyRecord[] = [];
    const onOrphanedKey = mock((record: OrphanedKeyRecord) => {
      orphanedRecords.push(record);
    });

    const middleware = createDeleteStorageFileMiddleware({
      storage: {
        async put() {
          return {};
        },
        async get() {
          return null;
        },
        delete: storageDelete,
      },
      assetAdapter: makeAssetAdapter(asset),
      retryAttempts: 2,
      onOrphanedKey,
    });

    await middleware(
      makeContext(asset.id) as never,
      mock(async () => {}),
    );

    expect(onOrphanedKey).toHaveBeenCalledTimes(1);
    const record = orphanedRecords[0];
    expect(record.key).toBe(asset.key);
    expect(record.assetId).toBe(asset.id);
    expect(record.retries).toBe(2);
    expect(record.lastError).toBe('permanent storage outage');
    expect(typeof record.recordedAt).toBe('number');
  });

  test('onOrphanedKey does not block when it throws', async () => {
    const asset = makeAsset();
    const storageDelete = mock(async () => {
      throw new Error('storage outage');
    });

    const middleware = createDeleteStorageFileMiddleware({
      storage: {
        async put() {
          return {};
        },
        async get() {
          return null;
        },
        delete: storageDelete,
      },
      assetAdapter: makeAssetAdapter(asset),
      retryAttempts: 1,
      onOrphanedKey: mock(() => {
        throw new Error('callback error');
      }),
      logger: {
        debug() {},
        info() {},
        warn() {},
        error() {},
        child() {
          return this;
        },
      },
    });

    // Should not throw — callback errors are caught and logged
    await expect(
      middleware(
        makeContext(asset.id) as never,
        mock(async () => {}),
      ),
    ).resolves.toBeUndefined();
  });

  test('onOrphanedKey is called after events and orphan registry', async () => {
    const asset = makeAsset();
    const storageDelete = mock(async () => {
      throw new Error('outage');
    });
    const callOrder: string[] = [];
    const events = {
      definitions: makeEventDefinitions(),
      publish: mock((event: string, payload: unknown) => {
        callOrder.push('event');
        return makeEventEnvelope(event, payload);
      }),
      on: mock(() => {}),
      off: mock(() => {}),
      emit: mock(() => {}),
      events: new Map(),
      get: mock(() => undefined),
      list: mock(() => []),
      register: mock(() => {}),
    };

    const orphanRegistry = createOrphanedKeyRegistry();
    const originalRecord = orphanRegistry.record.bind(orphanRegistry);
    orphanRegistry.record = mock((record: OrphanedKeyRecord) => {
      callOrder.push('registry');
      originalRecord(record);
    });

    const middleware = createDeleteStorageFileMiddleware({
      storage: {
        async put() {
          return {};
        },
        async get() {
          return null;
        },
        delete: storageDelete,
      },
      assetAdapter: makeAssetAdapter(asset),
      retryAttempts: 1,
      events,
      orphanRegistry,
      onOrphanedKey: mock(() => {
        callOrder.push('callback');
      }),
    });

    await middleware(
      makeContext(asset.id) as never,
      mock(async () => {}),
    );

    // The order should be: event, then registry, then callback
    expect(callOrder.indexOf('event')).toBeLessThan(callOrder.indexOf('callback'));
    expect(callOrder.indexOf('registry')).toBeLessThan(callOrder.indexOf('callback'));
  });
});

describe('deleteStorageFile middleware — events publishing', () => {
  test('publishes asset:storageDeleteFailed event after retries exhausted', async () => {
    const asset = makeAsset('asset-events-1');
    const storageDelete = mock(async () => {
      throw new Error('s3 outage');
    });

    const publishedEvents: Array<{ event: string; payload: unknown }> = [];
    const events = {
      definitions: makeEventDefinitions(),
      publish: mock((event: string, payload: unknown) => {
        publishedEvents.push({ event, payload });
        return makeEventEnvelope(event, payload);
      }),
      on: mock(() => {}),
      off: mock(() => {}),
      emit: mock(() => {}),
      events: new Map(),
      get: mock(() => undefined),
      list: mock(() => []),
      register: mock(() => {}),
    };

    const middleware = createDeleteStorageFileMiddleware({
      storage: {
        async put() {
          return {};
        },
        async get() {
          return null;
        },
        delete: storageDelete,
      },
      assetAdapter: makeAssetAdapter(asset),
      retryAttempts: 1,
      events,
    });

    await middleware(
      makeContext(asset.id) as never,
      mock(async () => {}),
    );

    expect(events.publish).toHaveBeenCalledTimes(1);
    const call = publishedEvents[0];
    expect(call.event).toBe('asset:storageDeleteFailed');
    expect(call.payload).toMatchObject({
      key: asset.key,
      assetId: asset.id,
      retries: 1,
      lastError: 's3 outage',
    });
  });

  test('events publish failure is caught and logged', async () => {
    const asset = makeAsset();
    const storageDelete = mock(async () => {
      throw new Error('outage');
    });

    const errorCalls: string[] = [];
    const logger = {
      debug() {},
      info() {},
      warn() {},
      error(msg: string) {
        errorCalls.push(msg);
      },
      child() {
        return this;
      },
    };

    const events = {
      definitions: makeEventDefinitions(),
      publish: mock(() => {
        throw new Error('publish failed');
      }),
      on: mock(() => {}),
      off: mock(() => {}),
      emit: mock(() => {}),
      events: new Map(),
      get: mock(() => undefined),
      list: mock(() => []),
      register: mock(() => {}),
    };

    const middleware = createDeleteStorageFileMiddleware({
      storage: {
        async put() {
          return {};
        },
        async get() {
          return null;
        },
        delete: storageDelete,
      },
      assetAdapter: makeAssetAdapter(asset),
      retryAttempts: 1,
      events,
      logger,
    });

    await expect(
      middleware(
        makeContext(asset.id) as never,
        mock(async () => {}),
      ),
    ).resolves.toBeUndefined();

    expect(errorCalls.some(m => m.includes('asset:storageDeleteFailed event publish failed'))).toBe(
      true,
    );
  });

  test('skips events publishing when no events are wired', async () => {
    const asset = makeAsset();
    const storageDelete = mock(async () => {
      throw new Error('outage');
    });

    const middleware = createDeleteStorageFileMiddleware({
      storage: {
        async put() {
          return {};
        },
        async get() {
          return null;
        },
        delete: storageDelete,
      },
      assetAdapter: makeAssetAdapter(asset),
      retryAttempts: 1,
    });

    // Should not throw even without events
    await expect(
      middleware(
        makeContext(asset.id) as never,
        mock(async () => {}),
      ),
    ).resolves.toBeUndefined();
  });
});

describe('deleteStorageFile middleware — orphan registry recording', () => {
  test('records orphaned key in the orphan registry after retries exhausted', async () => {
    const asset = makeAsset('asset-orphan-1');
    const storageDelete = mock(async () => {
      throw new Error('outage');
    });

    const orphanRegistry = createOrphanedKeyRegistry();

    const middleware = createDeleteStorageFileMiddleware({
      storage: {
        async put() {
          return {};
        },
        async get() {
          return null;
        },
        delete: storageDelete,
      },
      assetAdapter: makeAssetAdapter(asset),
      retryAttempts: 1,
      orphanRegistry,
    });

    expect(orphanRegistry.size()).toBe(0);

    await middleware(
      makeContext(asset.id) as never,
      mock(async () => {}),
    );

    expect(orphanRegistry.size()).toBe(1);
    const orphans = orphanRegistry.listOrphanedKeys();
    expect(orphans[0].key).toBe(asset.key);
    expect(orphans[0].retries).toBe(1);
    expect(orphans[0].lastError).toBe('outage');
  });

  test('orphan registry recording failure is caught and logged', async () => {
    const asset = makeAsset();
    const storageDelete = mock(async () => {
      throw new Error('outage');
    });

    const errorCalls: string[] = [];
    const logger = {
      debug() {},
      info() {},
      warn() {},
      error(msg: string) {
        errorCalls.push(msg);
      },
      child() {
        return this;
      },
    };

    const orphanRegistry = createOrphanedKeyRegistry();
    orphanRegistry.record = mock(() => {
      throw new Error('registry full');
    });

    const middleware = createDeleteStorageFileMiddleware({
      storage: {
        async put() {
          return {};
        },
        async get() {
          return null;
        },
        delete: storageDelete,
      },
      assetAdapter: makeAssetAdapter(asset),
      retryAttempts: 1,
      orphanRegistry,
      logger,
    });

    await middleware(
      makeContext(asset.id) as never,
      mock(async () => {}),
    );

    expect(errorCalls.some(m => m.includes('orphan registry record failed'))).toBe(true);
  });
});

describe('createOrphanedKeyRegistry', () => {
  test('size() starts at 0', () => {
    const registry = createOrphanedKeyRegistry();
    expect(registry.size()).toBe(0);
  });

  test('record appends and returns via listOrphanedKeys', () => {
    const registry = createOrphanedKeyRegistry();
    const record: OrphanedKeyRecord = {
      key: 'uploads/test.txt',
      assetId: 'asset-1',
      tenantId: null,
      retries: 3,
      lastError: 'timeout',
      recordedAt: Date.now(),
    };
    registry.record(record);
    expect(registry.size()).toBe(1);
    const list = registry.listOrphanedKeys();
    expect(list).toHaveLength(1);
    expect(list[0].key).toBe('uploads/test.txt');
  });

  test('listOrphanedKeys returns a copy (not a reference)', () => {
    const registry = createOrphanedKeyRegistry();
    registry.record({
      key: 'k1',
      assetId: null,
      tenantId: null,
      retries: 1,
      lastError: 'e',
      recordedAt: 100,
    });
    const copy = registry.listOrphanedKeys();
    const mutated = registry.listOrphanedKeys();
    expect(copy).toEqual(mutated);
    // Mutating the returned array should not affect the registry
    (copy as OrphanedKeyRecord[]).push({
      key: 'fake',
      assetId: null,
      tenantId: null,
      retries: 1,
      lastError: 'e',
      recordedAt: 200,
    });
    expect(registry.size()).toBe(1);
  });

  test('listOrphanedKeys filters by since date', () => {
    const registry = createOrphanedKeyRegistry();
    registry.record({
      key: 'old',
      assetId: null,
      tenantId: null,
      retries: 1,
      lastError: 'e',
      recordedAt: 100,
    });
    registry.record({
      key: 'new',
      assetId: null,
      tenantId: null,
      retries: 1,
      lastError: 'e',
      recordedAt: 200,
    });
    const recent = registry.listOrphanedKeys(new Date(150));
    expect(recent).toHaveLength(1);
    expect(recent[0].key).toBe('new');

    const all = registry.listOrphanedKeys(new Date(0));
    expect(all).toHaveLength(2);
  });

  test('clear removes all records', () => {
    const registry = createOrphanedKeyRegistry();
    registry.record({
      key: 'k1',
      assetId: null,
      tenantId: null,
      retries: 1,
      lastError: 'e',
      recordedAt: Date.now(),
    });
    expect(registry.size()).toBe(1);
    registry.clear();
    expect(registry.size()).toBe(0);
    expect(registry.listOrphanedKeys()).toHaveLength(0);
  });

  test('honors maxRecords cap by evicting oldest', () => {
    const registry = createOrphanedKeyRegistry(3);
    registry.record({
      key: 'a',
      assetId: null,
      tenantId: null,
      retries: 1,
      lastError: 'e',
      recordedAt: 100,
    });
    registry.record({
      key: 'b',
      assetId: null,
      tenantId: null,
      retries: 1,
      lastError: 'e',
      recordedAt: 200,
    });
    registry.record({
      key: 'c',
      assetId: null,
      tenantId: null,
      retries: 1,
      lastError: 'e',
      recordedAt: 300,
    });
    registry.record({
      key: 'd',
      assetId: null,
      tenantId: null,
      retries: 1,
      lastError: 'e',
      recordedAt: 400,
    });
    // 'a' should have been evicted
    expect(registry.size()).toBe(3);
    const keys = registry.listOrphanedKeys().map(r => r.key);
    expect(keys).not.toContain('a');
    expect(keys).toContain('b');
    expect(keys).toContain('c');
    expect(keys).toContain('d');
  });
});
