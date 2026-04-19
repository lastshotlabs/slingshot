import { Database } from 'bun:sqlite';
import { beforeEach, describe, expect, mock, spyOn, test } from 'bun:test';
import {
  type AuditLogEntry,
  type AuditLogProvider,
  DEFAULT_MAX_ENTRIES,
} from '@lastshotlabs/slingshot-core';
import { createAuditLogProvider, createAuditLogFactories, auditLogFactories } from '../../src/framework/auditLog';
import { decodeCursor } from '../../src/framework/auditLog/cursor';

function makeEntry(overrides?: Partial<AuditLogEntry>): AuditLogEntry {
  return {
    id: crypto.randomUUID(),
    userId: null,
    sessionId: null,
    tenantId: null,
    method: 'GET',
    path: '/test',
    status: 200,
    ip: '127.0.0.1',
    userAgent: 'test-agent',
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

describe('auditLog — memory store', () => {
  let provider: AuditLogProvider;

  beforeEach(() => {
    provider = createAuditLogProvider({ store: 'memory' });
  });

  test('entry is stored and retrieved', async () => {
    const entry = makeEntry({ userId: 'u1', path: '/hello' });
    await provider.logEntry(entry);

    const { items } = await provider.getLogs({});
    expect(items.length).toBe(1);
    expect(items[0].id).toBe(entry.id);
    expect(items[0].path).toBe('/hello');
  });

  test('fresh provider starts empty', async () => {
    const { items } = await provider.getLogs({});
    expect(items.length).toBe(0);
  });

  test('filter by userId', async () => {
    await provider.logEntry(makeEntry({ userId: 'alice' }));
    await provider.logEntry(makeEntry({ userId: 'bob' }));

    const { items } = await provider.getLogs({ userId: 'alice' });
    expect(items.length).toBe(1);
    expect(items[0].userId).toBe('alice');
  });

  test('filter by tenantId', async () => {
    await provider.logEntry(makeEntry({ tenantId: 't1' }));
    await provider.logEntry(makeEntry({ tenantId: 't2' }));
    await provider.logEntry(makeEntry({ tenantId: 't1' }));

    const { items } = await provider.getLogs({ tenantId: 't1' });
    expect(items.length).toBe(2);
    expect(items.every(e => e.tenantId === 't1')).toBe(true);
  });

  test('filter by after/before date range', async () => {
    const t0 = new Date('2024-01-01T00:00:00Z');
    const t1 = new Date('2024-06-01T00:00:00Z');
    const t2 = new Date('2024-12-01T00:00:00Z');

    await provider.logEntry(makeEntry({ createdAt: t0.toISOString() }));
    await provider.logEntry(makeEntry({ createdAt: t1.toISOString() }));
    await provider.logEntry(makeEntry({ createdAt: t2.toISOString() }));

    const { items } = await provider.getLogs({
      after: new Date('2024-03-01'),
      before: new Date('2024-09-01'),
    });
    expect(items.length).toBe(1);
  });

  test('cursor pagination returns pages without overlap', async () => {
    const base = new Date('2024-01-01T00:00:00.000Z').getTime();
    for (let i = 0; i < 10; i++) {
      await provider.logEntry(
        makeEntry({ userId: 'pager', createdAt: new Date(base + i * 1000).toISOString() }),
      );
    }
    await provider.logEntry(makeEntry({ userId: 'other' }));

    const page1 = await provider.getLogs({ userId: 'pager', limit: 3 });
    expect(page1.items).toHaveLength(3);
    expect(page1.nextCursor).toBeDefined();

    const page2 = await provider.getLogs({ userId: 'pager', limit: 3, cursor: page1.nextCursor });
    expect(page2.items).toHaveLength(3);
    expect(page2.nextCursor).toBeDefined();

    const page1Ids = new Set(page1.items.map(e => e.id));
    expect(page2.items.every(e => !page1Ids.has(e.id))).toBe(true);
  });

  test('last page has no nextCursor', async () => {
    const base = new Date('2024-01-01T00:00:00.000Z').getTime();
    for (let i = 0; i < 5; i++) {
      await provider.logEntry(makeEntry({ createdAt: new Date(base + i * 1000).toISOString() }));
    }
    const page1 = await provider.getLogs({ limit: 3 });
    expect(page1.nextCursor).toBeDefined();
    const page2 = await provider.getLogs({ limit: 3, cursor: page1.nextCursor });
    expect(page2.items).toHaveLength(2);
    expect(page2.nextCursor).toBeUndefined();
  });

  test('limit is capped at 200', async () => {
    for (let i = 0; i < 5; i++) {
      await provider.logEntry(makeEntry());
    }
    const { items } = await provider.getLogs({ limit: 9999 });
    expect(items).toHaveLength(5);
  });

  test('query warns when reading a truncated capped memory store', async () => {
    const warnSpy = spyOn(console, 'warn');

    try {
      const base = Date.now();
      for (let i = 0; i < DEFAULT_MAX_ENTRIES + 1; i++) {
        await provider.logEntry(
          makeEntry({
            id: `entry-${i}`,
            path: `/logs/${i}`,
            createdAt: new Date(base + i).toISOString(),
          }),
        );
      }

      const { items } = await provider.getLogs({ limit: 1_000 });
      expect(items.length).toBeGreaterThan(0);
      // entry-0 (first inserted, oldest timestamp) was evicted; the last inserted should be present
      expect(items.some(e => e.id === 'entry-0')).toBe(false);
      expect(items.some(e => e.id === `entry-${DEFAULT_MAX_ENTRIES}`)).toBe(true);

      const hasTruncationWarning = warnSpy.mock.calls
        .flat()
        .some((msg: unknown) => typeof msg === 'string' && msg.includes('truncated store'));
      expect(hasTruncationWarning).toBe(true);
    } finally {
      warnSpy.mockRestore();
    }
  });
});

// ---------------------------------------------------------------------------
// auditLog — createAuditLogProvider error paths (lines 40-47)
// ---------------------------------------------------------------------------

describe('createAuditLogProvider — error paths', () => {
  test('throws when store is sqlite but no db is provided', () => {
    expect(() => createAuditLogProvider({ store: 'sqlite' })).toThrow(
      /sqlite.*no db instance/i,
    );
  });

  test('throws when store is mongo but no connection is provided', () => {
    expect(() => createAuditLogProvider({ store: 'mongo' })).toThrow(
      /mongo.*no connection/i,
    );
  });

  test('throws a helpful message for postgres directing to createAuditLogFactories', () => {
    expect(() => createAuditLogProvider({ store: 'postgres' as any })).toThrow(
      /createAuditLogFactories/,
    );
  });
});

describe('auditLog — SQLite store', () => {
  let db: Database;
  let provider: AuditLogProvider;

  beforeEach(() => {
    db = new Database(':memory:');
    provider = createAuditLogProvider({ store: 'sqlite', db });
  });

  test('table created lazily on first write', async () => {
    await provider.logEntry(makeEntry());
    const result = db.query('SELECT COUNT(*) as n FROM audit_logs').get() as { n: number };
    expect(result.n).toBe(1);
  });

  test('CREATE TABLE IF NOT EXISTS is safe to call on multiple Database instances', async () => {
    const db2 = new Database(':memory:');
    const provider2 = createAuditLogProvider({ store: 'sqlite', db: db2 });
    await provider.logEntry(makeEntry());
    await provider2.logEntry(makeEntry());

    const r1 = db.query('SELECT COUNT(*) as n FROM audit_logs').get() as { n: number };
    const r2 = db2.query('SELECT COUNT(*) as n FROM audit_logs').get() as { n: number };
    expect(r1.n).toBe(1);
    expect(r2.n).toBe(1);
    db2.close();
  });

  test('meta JSON round-trips correctly', async () => {
    const meta = { foo: 'bar', nested: { num: 42 } };
    await provider.logEntry(makeEntry({ meta }));

    const { items } = await provider.getLogs({});
    expect(items[0].meta).toEqual(meta);
  });

  test('optional fields stored and retrieved', async () => {
    const entry = makeEntry({ action: 'create', resource: 'Post', resourceId: 'post-1' });
    await provider.logEntry(entry);

    const { items } = await provider.getLogs({});
    expect(items[0].action).toBe('create');
    expect(items[0].resource).toBe('Post');
    expect(items[0].resourceId).toBe('post-1');
  });

  test('filter by userId', async () => {
    await provider.logEntry(makeEntry({ userId: 'alice' }));
    await provider.logEntry(makeEntry({ userId: 'bob' }));

    const { items } = await provider.getLogs({ userId: 'alice' });
    expect(items.length).toBe(1);
    expect(items[0].userId).toBe('alice');
  });

  test('cursor pagination returns pages without overlap', async () => {
    const base = new Date('2024-01-01T00:00:00.000Z').getTime();
    for (let i = 0; i < 7; i++) {
      await provider.logEntry(
        makeEntry({ userId: 'u', createdAt: new Date(base + i * 1000).toISOString() }),
      );
    }
    await provider.logEntry(makeEntry({ userId: 'other' }));

    const page1 = await provider.getLogs({ userId: 'u', limit: 3 });
    expect(page1.items).toHaveLength(3);
    expect(page1.nextCursor).toBeDefined();

    const page2 = await provider.getLogs({ userId: 'u', limit: 3, cursor: page1.nextCursor });
    expect(page2.items).toHaveLength(3);

    const page1Ids = new Set(page1.items.map(e => e.id));
    expect(page2.items.every(e => !page1Ids.has(e.id))).toBe(true);
  });

  test('storage error does not throw (caught internally)', async () => {
    db.close();
    await expect(provider.logEntry(makeEntry())).resolves.toBeUndefined();
  });

  test('ttlDays prunes entries older than the cutoff on each write (lines 71-72)', async () => {
    const db2 = new Database(':memory:');
    const ttlProvider = createAuditLogProvider({ store: 'sqlite', db: db2, ttlDays: 1 });

    // Write an old entry (2 days ago)
    const old = makeEntry({
      id: 'old-entry',
      createdAt: new Date(Date.now() - 2 * 86_400_000).toISOString(),
    });
    await ttlProvider.logEntry(old);

    // Write a fresh entry — this triggers the TTL DELETE
    const fresh = makeEntry({ id: 'fresh-entry', createdAt: new Date().toISOString() });
    await ttlProvider.logEntry(fresh);

    const { items } = await ttlProvider.getLogs({ limit: 100 });
    const ids = items.map(e => e.id);
    expect(ids).not.toContain('old-entry');
    expect(ids).toContain('fresh-entry');

    db2.close();
  });

  test('filter by tenantId (lines 94-95)', async () => {
    await provider.logEntry(makeEntry({ tenantId: 'tenant-a' }));
    await provider.logEntry(makeEntry({ tenantId: 'tenant-b' }));

    const { items } = await provider.getLogs({ tenantId: 'tenant-a' });
    expect(items.length).toBe(1);
    expect(items[0].tenantId).toBe('tenant-a');
  });

  test('filter by after date (lines 98-99)', async () => {
    const t0 = new Date('2024-01-01T00:00:00Z');
    const t1 = new Date('2024-06-01T00:00:00Z');
    await provider.logEntry(makeEntry({ createdAt: t0.toISOString() }));
    await provider.logEntry(makeEntry({ createdAt: t1.toISOString() }));

    const { items } = await provider.getLogs({ after: new Date('2024-03-01') });
    expect(items.length).toBe(1);
    expect(items[0].createdAt).toBe(t1.toISOString());
  });

  test('filter by before date (lines 102-103)', async () => {
    const t0 = new Date('2024-01-01T00:00:00Z');
    const t1 = new Date('2024-06-01T00:00:00Z');
    await provider.logEntry(makeEntry({ createdAt: t0.toISOString() }));
    await provider.logEntry(makeEntry({ createdAt: t1.toISOString() }));

    const { items } = await provider.getLogs({ before: new Date('2024-03-01') });
    expect(items.length).toBe(1);
    expect(items[0].createdAt).toBe(t0.toISOString());
  });
});

// ---------------------------------------------------------------------------
// cursor.ts — decodeCursor invalid shape (lines 23-24)
// ---------------------------------------------------------------------------

describe('auditLog cursor — decodeCursor', () => {
  test('returns null for valid base64/JSON but wrong shape (missing t)', () => {
    // Encode a JSON object that lacks a proper "t" field — parses fine but shape fails
    const badCursor = btoa(JSON.stringify({ id: 'abc', notT: 'something' }));
    expect(decodeCursor(badCursor)).toBeNull();
  });

  test('returns null for valid base64/JSON but t is not a valid date string', () => {
    const badCursor = btoa(JSON.stringify({ t: 'not-a-date', id: 'abc' }));
    expect(decodeCursor(badCursor)).toBeNull();
  });

  test('returns null for valid base64/JSON but id is empty string', () => {
    const badCursor = btoa(JSON.stringify({ t: '2024-01-01T00:00:00.000Z', id: '' }));
    expect(decodeCursor(badCursor)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// createAuditLogFactories and auditLogFactories
// ---------------------------------------------------------------------------

describe('createAuditLogFactories', () => {
  test('returns factory map with all required keys', () => {
    const warnSpy = spyOn(console, 'warn').mockImplementation(() => {});
    const factories = createAuditLogFactories();
    expect(factories.memory).toBeTypeOf('function');
    expect(factories.sqlite).toBeTypeOf('function');
    expect(factories.redis).toBeTypeOf('function');
    expect(factories.mongo).toBeTypeOf('function');
    expect(factories.postgres).toBeTypeOf('function');
    warnSpy.mockRestore();
  });

  test('memory factory creates a working provider', async () => {
    const warnSpy = spyOn(console, 'warn').mockImplementation(() => {});
    const factories = createAuditLogFactories(7);
    const provider = factories.memory({} as any);
    await provider.logEntry(makeEntry());
    const { items } = await provider.getLogs({});
    expect(items).toHaveLength(1);
    warnSpy.mockRestore();
  });

  test('redis factory falls back to memory provider', async () => {
    const warnSpy = spyOn(console, 'warn').mockImplementation(() => {});
    const factories = createAuditLogFactories();
    const provider = factories.redis({} as any);
    await provider.logEntry(makeEntry());
    const { items } = await provider.getLogs({});
    expect(items).toHaveLength(1);
    warnSpy.mockRestore();
  });

  test('sqlite factory creates provider when db is available', () => {
    const warnSpy = spyOn(console, 'warn').mockImplementation(() => {});
    const factories = createAuditLogFactories();
    const sqlDb = new Database(':memory:');
    const provider = factories.sqlite({ getSqliteDb: () => sqlDb } as any);
    expect(provider.logEntry).toBeTypeOf('function');
    sqlDb.close();
    warnSpy.mockRestore();
  });

  test('mongo factory creates provider when conn is available', () => {
    const warnSpy = spyOn(console, 'warn').mockImplementation(() => {});
    const factories = createAuditLogFactories();
    // Minimal mock connection — createMongoAuditLogProvider only needs conn
    const mockConn: {
      models: Record<string, unknown>;
      model: (...args: unknown[]) => unknown;
    } = {
      models: {},
      model: () => ({
        create: async () => {},
        find: () => ({ sort: () => ({ limit: () => ({ lean: async () => [] }) }) }),
      }),
    };
    const provider = factories.mongo({ getMongo: () => ({ conn: mockConn }) } as any);
    expect(provider.logEntry).toBeTypeOf('function');
    warnSpy.mockRestore();
  });

  test('postgres factory creates provider when pool is available', () => {
    const warnSpy = spyOn(console, 'warn').mockImplementation(() => {});
    const factories = createAuditLogFactories();
    const mockPool = {
      query: async () => ({ rows: [], rowCount: 0 }),
    };
    const provider = factories.postgres({ getPostgres: () => ({ pool: mockPool }) } as any);
    expect(provider.logEntry).toBeTypeOf('function');
    warnSpy.mockRestore();
  });
});

describe('auditLogFactories (deprecated export)', () => {
  test('memory factory from deprecated export works', async () => {
    const warnSpy = spyOn(console, 'warn').mockImplementation(() => {});
    const provider = auditLogFactories.memory({} as any);
    await provider.logEntry(makeEntry());
    const { items } = await provider.getLogs({});
    expect(items).toHaveLength(1);
    warnSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// getAuditLogModel — Mongoose model registration (src/framework/models/AuditLog.ts)
// ---------------------------------------------------------------------------

describe('getAuditLogModel', () => {
  test('creates AuditLog model on first call and returns cached on second', async () => {
    // Mock schema with index method
    const mockSchema = {
      index: mock(() => {}),
    };
    const mockModel = { modelName: 'AuditLog' };

    // Mock connection
    const mockConn = {
      models: {} as Record<string, unknown>,
      model: mock(() => {
        mockConn.models['AuditLog'] = mockModel;
        return mockModel;
      }),
    };

    // Create a Schema constructor
    function MockSchema() {
      return mockSchema;
    }
    MockSchema.Types = { Mixed: 'Mixed' };

    // Mock the mongoose module
    mock.module('@lib/mongo', () => ({
      getMongooseModule: () => ({ Schema: MockSchema }),
    }));

    // Dynamic import to pick up the mock
    const { getAuditLogModel } = await import('../../src/framework/models/AuditLog');

    // First call: creates model
    const model1 = getAuditLogModel(mockConn as any);
    expect(model1).toBe(mockModel);
    expect(mockConn.model).toHaveBeenCalledTimes(1);
    expect(mockSchema.index).toHaveBeenCalledTimes(3); // userId, tenantId, path indexes

    // Second call: returns cached model
    const model2 = getAuditLogModel(mockConn as any);
    expect(model2).toBe(mockModel);
    // model() should NOT have been called again
    expect(mockConn.model).toHaveBeenCalledTimes(1);
  });
});
