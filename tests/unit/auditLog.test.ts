import { Database } from 'bun:sqlite';
import { beforeEach, describe, expect, spyOn, test } from 'bun:test';
import {
  type AuditLogEntry,
  type AuditLogProvider,
  DEFAULT_MAX_ENTRIES,
} from '@lastshotlabs/slingshot-core';
import { createAuditLogProvider } from '../../src/framework/auditLog';

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
});
