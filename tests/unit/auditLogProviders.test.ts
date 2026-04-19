/**
 * Tests for:
 *   - src/framework/auditLog/postgresProvider.ts (lines 12-14, 21-47, 51-144)
 *   - src/framework/auditLog/mongoProvider.ts (lines 10-76)
 */
import { describe, expect, spyOn, test } from 'bun:test';
import type { AuditLogEntry } from '@lastshotlabs/slingshot-core';
import { createPostgresAuditLogProvider } from '../../src/framework/auditLog/postgresProvider';
import { encodeCursor } from '../../src/framework/auditLog/cursor';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeEntry(overrides: Partial<AuditLogEntry> = {}): AuditLogEntry {
  return {
    id: crypto.randomUUID(),
    requestId: undefined,
    userId: null,
    sessionId: null,
    tenantId: null,
    method: 'POST',
    path: '/api/test',
    status: 200,
    ip: '127.0.0.1',
    userAgent: 'test-agent/1.0',
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// createPostgresAuditLogProvider tests
// ---------------------------------------------------------------------------

describe('createPostgresAuditLogProvider', () => {
  function makeMockPool(rowsForQuery?: Record<string, unknown>[]) {
    const queries: Array<{ sql: string; params?: unknown[] }> = [];
    const rows = rowsForQuery ?? [];

    const runQuery = async (sql: string, params?: unknown[]) => {
      queries.push({ sql, params });
      return { rows, rowCount: rows.length };
    };

    const pool = {
      queries,
      query: runQuery,
      connect: async () => ({
        query: runQuery,
        release: () => {},
      }),
    };
    return pool;
  }

  test('logEntry creates table on first call', async () => {
    const pool = makeMockPool();
    const provider = createPostgresAuditLogProvider(pool);

    await provider.logEntry(makeEntry());

    const createTableQuery = pool.queries.find(q => q.sql.includes('CREATE TABLE IF NOT EXISTS'));
    expect(createTableQuery).toBeDefined();
    expect(pool.queries.some(q => q.sql.trim() === 'BEGIN')).toBe(true);
    expect(pool.queries.some(q => q.sql.trim() === 'COMMIT')).toBe(true);
  });

  test('logEntry only initializes once (idempotent)', async () => {
    const pool = makeMockPool();
    const provider = createPostgresAuditLogProvider(pool);

    await provider.logEntry(makeEntry());
    const countBefore = pool.queries.length;
    await provider.logEntry(makeEntry());
    const countAfter = pool.queries.length;

    // Second call should not re-run CREATE TABLE + indexes
    const newQueries = countAfter - countBefore;
    // On the first call: 5 queries (CREATE TABLE + 3 INDEX + 1 INSERT)
    // On the second call: 1 query (INSERT only) + maybe TTL delete
    expect(newQueries).toBeLessThan(5);
  });

  test('logEntry inserts entry with correct parameters', async () => {
    const pool = makeMockPool();
    const provider = createPostgresAuditLogProvider(pool);

    const entry = makeEntry({
      id: 'entry-id-1',
      userId: 'user-1',
      sessionId: 'sess-1',
      tenantId: 'tenant-1',
      method: 'GET',
      path: '/api/items',
      status: 200,
      ip: '1.2.3.4',
      userAgent: 'Mozilla/5.0',
      action: 'list',
      resource: 'Item',
      resourceId: 'item-123',
      meta: { foo: 'bar' },
      createdAt: '2024-01-01T00:00:00.000Z',
    });

    await provider.logEntry(entry);

    const insertQuery = pool.queries.find(q => q.sql.includes('INSERT INTO slingshot_audit_logs'));
    expect(insertQuery).toBeDefined();
    const params = insertQuery?.params as unknown[];
    expect(params[0]).toBe('entry-id-1');
    expect(params[1]).toBe('user-1');
    expect(params[4]).toBe('GET');
    expect(params[5]).toBe('/api/items');
    expect(params[6]).toBe(200);
  });

  test('logEntry swallows write errors (does not throw)', async () => {
    const pool = {
      queries: [] as any[],
      query: async (sql: string) => {
        if (sql.includes('INSERT INTO')) throw new Error('DB constraint error');
        return { rows: [], rowCount: 0 };
      },
      connect: async () => ({
        query: async (sql: string) => {
          if (sql.includes('INSERT INTO')) throw new Error('DB constraint error');
          return { rows: [], rowCount: 0 };
        },
        release: () => {},
      }),
    };
    const consoleSpy = spyOn(console, 'error').mockImplementation(() => {});
    const provider = createPostgresAuditLogProvider(pool);

    await expect(provider.logEntry(makeEntry())).resolves.toBeUndefined();

    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining('[auditLog] failed to write entry:'),
      expect.any(Error),
    );
    consoleSpy.mockRestore();
  });

  test('logEntry runs TTL cleanup when ttlDays is set', async () => {
    const pool = makeMockPool();
    const provider = createPostgresAuditLogProvider(pool, 30);

    await provider.logEntry(makeEntry());

    const deleteQuery = pool.queries.find(q => q.sql.includes('DELETE FROM slingshot_audit_logs'));
    expect(deleteQuery).toBeDefined();
  });

  test('logEntry does not run TTL cleanup when ttlDays is not set', async () => {
    const pool = makeMockPool();
    const provider = createPostgresAuditLogProvider(pool); // no ttlDays

    await provider.logEntry(makeEntry());

    const deleteQuery = pool.queries.find(q => q.sql.includes('DELETE FROM slingshot_audit_logs'));
    expect(deleteQuery).toBeUndefined();
  });

  test('getLogs initializes table and returns mapped items', async () => {
    const fakeRow = {
      id: 'row-1',
      user_id: 'u1',
      session_id: 'sess-1',
      tenant_id: 'tenant-1',
      method: 'GET',
      path: '/api',
      status: 200,
      ip: '127.0.0.1',
      user_agent: 'agent',
      action: 'read',
      resource: 'Item',
      resource_id: 'item-1',
      meta: { x: 1 },
      created_at: new Date('2024-01-01T00:00:00Z'),
    };
    const pool = makeMockPool([fakeRow]);
    const provider = createPostgresAuditLogProvider(pool);

    const { items } = await provider.getLogs({});

    expect(items).toHaveLength(1);
    expect(items[0].id).toBe('row-1');
    expect(items[0].userId).toBe('u1');
    expect(items[0].method).toBe('GET');
    expect(items[0].action).toBe('read');
    expect(items[0].createdAt).toBe(new Date('2024-01-01T00:00:00Z').toISOString());
  });

  test('getLogs filters by userId', async () => {
    const pool = makeMockPool([]);
    const provider = createPostgresAuditLogProvider(pool);

    await provider.getLogs({ userId: 'alice' });

    const selectQuery = pool.queries.find(q => q.sql.includes('SELECT *'));
    expect(selectQuery?.sql).toContain('user_id');
    expect(selectQuery?.params).toContain('alice');
  });

  test('getLogs filters by tenantId', async () => {
    const pool = makeMockPool([]);
    const provider = createPostgresAuditLogProvider(pool);

    await provider.getLogs({ tenantId: 't1' });

    const selectQuery = pool.queries.find(q => q.sql.includes('SELECT *'));
    expect(selectQuery?.sql).toContain('tenant_id');
    expect(selectQuery?.params).toContain('t1');
  });

  test('getLogs applies after/before date filters', async () => {
    const pool = makeMockPool([]);
    const provider = createPostgresAuditLogProvider(pool);

    await provider.getLogs({
      after: new Date('2024-01-01'),
      before: new Date('2024-12-31'),
    });

    const selectQuery = pool.queries.find(q => q.sql.includes('SELECT *'));
    expect(selectQuery?.sql).toContain('created_at >=');
    expect(selectQuery?.sql).toContain('created_at <');
  });

  test('getLogs applies cursor for pagination', async () => {
    const pool = makeMockPool([]);
    const provider = createPostgresAuditLogProvider(pool);

    const cursor = encodeCursor('2024-01-01T00:00:00.000Z', 'entry-id');
    await provider.getLogs({ cursor });

    const selectQuery = pool.queries.find(q => q.sql.includes('SELECT *'));
    expect(selectQuery?.sql).toContain('created_at <');
  });

  test('getLogs throws 400 for invalid cursor', async () => {
    const pool = makeMockPool([]);
    const provider = createPostgresAuditLogProvider(pool);

    await expect(provider.getLogs({ cursor: 'invalid-base64' })).rejects.toMatchObject({
      status: 400,
    });
  });

  test('getLogs caps limit at 200', async () => {
    const pool = makeMockPool([]);
    const provider = createPostgresAuditLogProvider(pool);

    await provider.getLogs({ limit: 9999 });

    const selectQuery = pool.queries.find(q => q.sql.includes('SELECT *'));
    // limit+1 is the final param — should be 201, not 10000
    const params = selectQuery?.params as unknown[];
    const limitParam = params?.at(-1) as number;
    expect(limitParam).toBe(201); // 200 + 1
  });

  test('getLogs returns nextCursor when more rows exist', async () => {
    // Return limit+1 rows to trigger hasMore
    const fakeRows = Array.from({ length: 4 }, (_, i) => ({
      id: `id-${i}`,
      user_id: null,
      session_id: null,
      tenant_id: null,
      method: 'GET',
      path: '/api',
      status: 200,
      ip: null,
      user_agent: null,
      action: null,
      resource: null,
      resource_id: null,
      meta: null,
      created_at: new Date(`2024-01-0${i + 1}T00:00:00Z`),
    }));

    // Request limit=3, so 4 rows means hasMore=true
    const pool = {
      queries: [] as any[],
      query: async (sql: string, params?: unknown[]) => {
        pool.queries.push({ sql, params });
        if (sql.includes('SELECT *')) {
          return { rows: fakeRows, rowCount: 4 };
        }
        return { rows: [], rowCount: 0 };
      },
      connect: async () => ({
        query: async (sql: string, params?: unknown[]) => {
          pool.queries.push({ sql, params });
          if (sql.includes('SELECT *')) {
            return { rows: fakeRows, rowCount: 4 };
          }
          return { rows: [], rowCount: 0 };
        },
        release: () => {},
      }),
    };

    const provider = createPostgresAuditLogProvider(pool);
    const { items, nextCursor } = await provider.getLogs({ limit: 3 });

    expect(items).toHaveLength(3);
    expect(nextCursor).toBeDefined();
  });

  test('getLogs returns no nextCursor when on last page', async () => {
    const fakeRows = [
      {
        id: 'id-1',
        user_id: null,
        session_id: null,
        tenant_id: null,
        method: 'GET',
        path: '/api',
        status: 200,
        ip: null,
        user_agent: null,
        action: null,
        resource: null,
        resource_id: null,
        meta: null,
        created_at: new Date(),
      },
    ];

    const pool = makeMockPool(fakeRows);
    const provider = createPostgresAuditLogProvider(pool);
    const { items, nextCursor } = await provider.getLogs({ limit: 50 });

    expect(items).toHaveLength(1);
    expect(nextCursor).toBeUndefined();
  });

  test('toCreatedAtIso handles string created_at', async () => {
    const fakeRow = {
      id: 'id-1',
      user_id: null,
      session_id: null,
      tenant_id: null,
      method: 'GET',
      path: '/api',
      status: 200,
      ip: null,
      user_agent: null,
      action: null,
      resource: null,
      resource_id: null,
      meta: null,
      created_at: '2024-06-15T12:00:00Z', // string, not Date
    };
    const pool = makeMockPool([fakeRow]);
    const provider = createPostgresAuditLogProvider(pool);

    const { items } = await provider.getLogs({});
    expect(items[0].createdAt).toBe(new Date('2024-06-15T12:00:00Z').toISOString());
  });
});

// ---------------------------------------------------------------------------
// createMongoAuditLogProvider tests (exercising the REAL function via mock.module)
// ---------------------------------------------------------------------------

describe('createMongoAuditLogProvider', () => {
  /**
   * Factory that builds a mock AuditLog model, mocks `getAuditLogModel`, then
   * imports and invokes the real `createMongoAuditLogProvider` so that production
   * code lines 10-76 are exercised.
   */
  async function makeRealMongoProvider(opts: {
    docs?: Array<Record<string, unknown>>;
    ttlDays?: number;
    throwOnCreate?: boolean;
    captureFilter?: (filter: object) => void;
  } = {}) {
    const { docs = [], ttlDays, throwOnCreate = false, captureFilter } = opts;
    const created: object[] = [];
    const returnDocs = docs.slice();

    const sortChain: Record<string, (...args: unknown[]) => unknown> = {
      sort: () => sortChain,
      limit: (n: number) => ({
        lean: async () => returnDocs.slice(0, n),
      }),
    };

    const MockModel = {
      created,
      create: async (doc: object) => {
        if (throwOnCreate) throw new Error('Mongo write error');
        created.push(doc);
        return doc;
      },
      find: (filter: object) => {
        captureFilter?.(filter);
        return sortChain;
      },
    };

    // Use mock.module to intercept the model factory used by the real provider
    const { mock: bunMock } = await import('bun:test');
    bunMock.module('@framework/models/AuditLog', () => ({
      getAuditLogModel: () => MockModel,
    }));

    // Re-import after mock is installed to pick up the mocked dependency
    const { createMongoAuditLogProvider: create } = await import(
      '../../src/framework/auditLog/mongoProvider'
    );

    const fakeConn = {} as any;
    const provider = create(fakeConn, ttlDays);
    return { MockModel, provider };
  }

  test('logEntry creates a document via the model', async () => {
    const { MockModel, provider } = await makeRealMongoProvider();

    const entry = makeEntry({ id: 'entry-1', userId: 'user-1' });
    await provider.logEntry(entry);

    expect(MockModel.created).toHaveLength(1);
    const doc = MockModel.created[0] as any;
    expect(doc.id).toBe('entry-1');
    expect(doc.userId).toBe('user-1');
    expect(doc.createdAt).toBeInstanceOf(Date);
  });

  test('logEntry swallows errors', async () => {
    const consoleSpy = spyOn(console, 'error').mockImplementation(() => {});

    const { provider } = await makeRealMongoProvider({ throwOnCreate: true });
    await expect(provider.logEntry(makeEntry())).resolves.toBeUndefined();

    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining('[auditLog] failed to write entry:'),
      expect.any(Error),
    );
    consoleSpy.mockRestore();
  });

  test('logEntry includes expiresAt when ttlDays is set', async () => {
    const { MockModel, provider } = await makeRealMongoProvider({ ttlDays: 30 });

    await provider.logEntry(makeEntry());

    const doc = MockModel.created[0] as any;
    expect(doc.expiresAt).toBeInstanceOf(Date);
    // Verify expiry is roughly 30 days from now
    const expectedMs = 30 * 86_400_000;
    const diff = doc.expiresAt.getTime() - Date.now();
    expect(diff).toBeGreaterThan(expectedMs - 5000);
    expect(diff).toBeLessThan(expectedMs + 5000);
  });

  test('logEntry does not include expiresAt when ttlDays is not set', async () => {
    const { MockModel, provider } = await makeRealMongoProvider();

    await provider.logEntry(makeEntry());

    const doc = MockModel.created[0] as any;
    expect(doc.expiresAt).toBeUndefined();
  });

  test('getLogs returns items mapped from docs', async () => {
    const fakeDocs = [
      {
        id: 'doc-1',
        userId: 'u1',
        sessionId: 'sess-1',
        tenantId: 'tenant-1',
        method: 'POST',
        path: '/api/create',
        status: 201,
        ip: '1.2.3.4',
        userAgent: 'agent',
        action: 'create',
        resource: 'Item',
        resourceId: 'item-1',
        meta: { key: 'val' },
        createdAt: new Date('2024-01-01T00:00:00Z'),
      },
    ];

    const { provider } = await makeRealMongoProvider({ docs: fakeDocs });
    const { items } = await provider.getLogs({});

    expect(items).toHaveLength(1);
    expect(items[0].id).toBe('doc-1');
    expect(items[0].userId).toBe('u1');
    expect(items[0].sessionId).toBe('sess-1');
    expect(items[0].tenantId).toBe('tenant-1');
    expect(items[0].method).toBe('POST');
    expect(items[0].path).toBe('/api/create');
    expect(items[0].status).toBe(201);
    expect(items[0].ip).toBe('1.2.3.4');
    expect(items[0].userAgent).toBe('agent');
    expect(items[0].action).toBe('create');
    expect(items[0].resource).toBe('Item');
    expect(items[0].resourceId).toBe('item-1');
    expect(items[0].meta).toEqual({ key: 'val' });
    expect(items[0].createdAt).toBe(new Date('2024-01-01T00:00:00Z').toISOString());
  });

  test('getLogs returns empty list when no docs', async () => {
    const { provider } = await makeRealMongoProvider({ docs: [] });
    const { items, nextCursor } = await provider.getLogs({});

    expect(items).toHaveLength(0);
    expect(nextCursor).toBeUndefined();
  });

  test('getLogs filters by userId', async () => {
    let capturedFilter: object = {};
    const { provider } = await makeRealMongoProvider({
      captureFilter: (f) => { capturedFilter = f; },
    });

    await provider.getLogs({ userId: 'alice' });
    expect((capturedFilter as any).userId).toBe('alice');
  });

  test('getLogs filters by tenantId', async () => {
    let capturedFilter: object = {};
    const { provider } = await makeRealMongoProvider({
      captureFilter: (f) => { capturedFilter = f; },
    });

    await provider.getLogs({ tenantId: 't1' });
    expect((capturedFilter as any).tenantId).toBe('t1');
  });

  test('getLogs applies after/before as $and conditions', async () => {
    let capturedFilter: Record<string, unknown> = {};
    const { provider } = await makeRealMongoProvider({
      captureFilter: (f) => { capturedFilter = f as Record<string, unknown>; },
    });

    await provider.getLogs({
      after: new Date('2024-01-01').toISOString(),
      before: new Date('2024-12-31').toISOString(),
    });

    expect(capturedFilter.$and).toBeDefined();
    expect(Array.isArray(capturedFilter.$and)).toBe(true);
    const andConds = capturedFilter.$and as Record<string, unknown>[];
    expect(andConds).toHaveLength(2);
    // First condition: $gte for after
    expect(andConds[0]).toHaveProperty('createdAt');
    expect((andConds[0].createdAt as any).$gte).toBeInstanceOf(Date);
    // Second condition: $lt for before
    expect(andConds[1]).toHaveProperty('createdAt');
    expect((andConds[1].createdAt as any).$lt).toBeInstanceOf(Date);
  });

  test('getLogs applies only after filter when before is omitted', async () => {
    let capturedFilter: Record<string, unknown> = {};
    const { provider } = await makeRealMongoProvider({
      captureFilter: (f) => { capturedFilter = f as Record<string, unknown>; },
    });

    await provider.getLogs({ after: new Date('2024-01-01').toISOString() });

    const andConds = capturedFilter.$and as Record<string, unknown>[];
    expect(andConds).toHaveLength(1);
    expect((andConds[0].createdAt as any).$gte).toBeInstanceOf(Date);
  });

  test('getLogs applies cursor for pagination', async () => {
    let capturedFilter: Record<string, unknown> = {};
    const { provider } = await makeRealMongoProvider({
      captureFilter: (f) => { capturedFilter = f as Record<string, unknown>; },
    });

    const cursor = encodeCursor('2024-01-01T00:00:00.000Z', 'entry-id');
    await provider.getLogs({ cursor });

    expect(capturedFilter.$and).toBeDefined();
    const andConds = capturedFilter.$and as Record<string, unknown>[];
    expect(andConds).toHaveLength(1);
    // Cursor condition uses $or
    expect(andConds[0]).toHaveProperty('$or');
  });

  test('getLogs throws 400 for invalid cursor', async () => {
    const { provider } = await makeRealMongoProvider();

    await expect(provider.getLogs({ cursor: 'invalid!!' })).rejects.toMatchObject({ status: 400 });
  });

  test('getLogs returns nextCursor when hasMore', async () => {
    // 4 docs for limit=3 → hasMore=true
    const fakeDocs = Array.from({ length: 4 }, (_, i) => ({
      id: `id-${i}`,
      userId: null,
      sessionId: null,
      tenantId: null,
      method: 'GET',
      path: '/',
      status: 200,
      ip: null,
      userAgent: null,
      action: undefined,
      resource: undefined,
      resourceId: undefined,
      meta: undefined,
      createdAt: new Date(`2024-01-0${i + 1}T00:00:00Z`),
    }));

    const { provider } = await makeRealMongoProvider({ docs: fakeDocs });
    const { items, nextCursor } = await provider.getLogs({ limit: 3 });

    expect(items).toHaveLength(3);
    expect(nextCursor).toBeDefined();
  });

  test('getLogs returns no nextCursor when on last page', async () => {
    const fakeDocs = [
      {
        id: 'only-1',
        userId: null,
        sessionId: null,
        tenantId: null,
        method: 'GET',
        path: '/',
        status: 200,
        ip: null,
        userAgent: null,
        action: undefined,
        resource: undefined,
        resourceId: undefined,
        meta: undefined,
        createdAt: new Date('2024-06-01T00:00:00Z'),
      },
    ];
    const { provider } = await makeRealMongoProvider({ docs: fakeDocs });
    const { items, nextCursor } = await provider.getLogs({ limit: 50 });

    expect(items).toHaveLength(1);
    expect(nextCursor).toBeUndefined();
  });

  test('getLogs caps limit at 200', async () => {
    let capturedLimit = 0;
    const mockModelForLimit = {
      created: [] as object[],
      create: async (doc: object) => { mockModelForLimit.created.push(doc); return doc; },
      find: () => ({
        sort: () => ({
          limit: (n: number) => {
            capturedLimit = n;
            return { lean: async () => [] };
          },
        }),
      }),
    };

    const { mock: bunMock } = await import('bun:test');
    bunMock.module('@framework/models/AuditLog', () => ({
      getAuditLogModel: () => mockModelForLimit,
    }));
    const { createMongoAuditLogProvider: create } = await import(
      '../../src/framework/auditLog/mongoProvider'
    );
    const provider = create({} as any);
    await provider.getLogs({ limit: 9999 });

    // limit + 1 = 201
    expect(capturedLimit).toBe(201);
  });

  test('getLogs maps null fields correctly', async () => {
    const fakeDocs = [
      {
        id: 'null-doc',
        userId: null,
        sessionId: null,
        tenantId: null,
        method: 'GET',
        path: '/test',
        status: 200,
        ip: null,
        userAgent: null,
        action: undefined,
        resource: undefined,
        resourceId: undefined,
        meta: undefined,
        createdAt: new Date('2024-01-01T00:00:00Z'),
      },
    ];

    const { provider } = await makeRealMongoProvider({ docs: fakeDocs });
    const { items } = await provider.getLogs({});

    expect(items[0].userId).toBeNull();
    expect(items[0].sessionId).toBeNull();
    expect(items[0].tenantId).toBeNull();
    expect(items[0].ip).toBeNull();
    expect(items[0].userAgent).toBeNull();
    expect(items[0].action).toBeUndefined();
    expect(items[0].resource).toBeUndefined();
    expect(items[0].resourceId).toBeUndefined();
    expect(items[0].meta).toBeUndefined();
  });

  test('getLogs combines cursor with before filter', async () => {
    let capturedFilter: Record<string, unknown> = {};
    const { provider } = await makeRealMongoProvider({
      captureFilter: (f) => { capturedFilter = f as Record<string, unknown>; },
    });

    const cursor = encodeCursor('2024-06-01T00:00:00.000Z', 'some-id');
    await provider.getLogs({
      cursor,
      before: new Date('2024-12-31').toISOString(),
    });

    const andConds = capturedFilter.$and as Record<string, unknown>[];
    // Should have both before and cursor conditions
    expect(andConds).toHaveLength(2);
  });

  test('getLogs uses default limit of 50 when not provided', async () => {
    let capturedLimit = 0;
    const mockModelForLimit = {
      created: [] as object[],
      create: async (doc: object) => { mockModelForLimit.created.push(doc); return doc; },
      find: () => ({
        sort: () => ({
          limit: (n: number) => {
            capturedLimit = n;
            return { lean: async () => [] };
          },
        }),
      }),
    };

    const { mock: bunMock } = await import('bun:test');
    bunMock.module('@framework/models/AuditLog', () => ({
      getAuditLogModel: () => mockModelForLimit,
    }));
    const { createMongoAuditLogProvider: create } = await import(
      '../../src/framework/auditLog/mongoProvider'
    );
    const provider = create({} as any);
    await provider.getLogs({});

    // default limit (50) + 1 = 51
    expect(capturedLimit).toBe(51);
  });
});

// ---------------------------------------------------------------------------
// createMemoryAuditLogProvider — catch block (line 24)
// ---------------------------------------------------------------------------

describe('createMemoryAuditLogProvider — logEntry catch block', () => {
  test('logs error and resolves when push throws', async () => {
    const consoleSpy = spyOn(console, 'error').mockImplementation(() => {});
    const warnSpy = spyOn(console, 'warn').mockImplementation(() => {});
    const { createMemoryAuditLogProvider } = await import(
      '../../src/framework/auditLog/memoryProvider'
    );
    const provider = createMemoryAuditLogProvider();

    // Monkey-patch Array.prototype.push temporarily to make it throw
    const origPush = Array.prototype.push;
    let shouldThrow = false;
    Array.prototype.push = function (...args) {
      if (shouldThrow) {
        throw new Error('push failed');
      }
      return origPush.apply(this, args);
    };

    shouldThrow = true;
    await expect(provider.logEntry(makeEntry())).resolves.toBeUndefined();
    shouldThrow = false;
    Array.prototype.push = origPush;

    expect(consoleSpy).toHaveBeenCalledWith(
      '[auditLog] failed to write entry:',
      expect.any(Error),
    );
    consoleSpy.mockRestore();
    warnSpy.mockRestore();
  });
});
