import { beforeEach, describe, expect, test } from 'bun:test';
import type { StoredMessage, WsMessageRepository } from '@lastshotlabs/slingshot-core';

// ---------------------------------------------------------------------------
// Mock pg.Pool
// ---------------------------------------------------------------------------

interface QueryCall {
  sql: string;
  params: unknown[] | undefined;
}

function createMockPool() {
  const calls: QueryCall[] = [];
  const resultQueue: Array<{ rows: Record<string, unknown>[] }> = [];
  let defaultResult: { rows: Record<string, unknown>[] } = { rows: [] };

  const pool = {
    query: async (sql: string, params?: unknown[]) => {
      calls.push({ sql: sql.replace(/\s+/g, ' ').trim(), params });
      if (resultQueue.length > 0) {
        return resultQueue.shift()!;
      }
      return defaultResult;
    },
  };

  return {
    pool: pool as unknown as import('pg').Pool,
    calls,
    setDefaultResult(rows: Record<string, unknown>[]) {
      defaultResult = { rows };
    },
    enqueueResult(rows: Record<string, unknown>[]) {
      resultQueue.push({ rows });
    },
    reset() {
      calls.length = 0;
      resultQueue.length = 0;
      defaultResult = { rows: [] };
    },
  };
}

const ENDPOINT = '/ws';

function makeMessage(
  room: string,
  data: { senderId?: string | null; payload: unknown },
): StoredMessage {
  return {
    id: crypto.randomUUID(),
    endpoint: ENDPOINT,
    room,
    senderId: data.senderId ?? null,
    payload: data.payload,
    createdAt: Date.now(),
  };
}

describe('postgresWsMessages', () => {
  let mock: ReturnType<typeof createMockPool>;
  let repo: WsMessageRepository;

  beforeEach(async () => {
    mock = createMockPool();
    const { createPostgresWsMessageRepository } =
      await import('../../src/framework/persistence/postgresWsMessages');
    repo = await createPostgresWsMessageRepository(mock.pool);
    // Clear the init calls (CREATE TABLE + CREATE INDEX)
    mock.reset();
  });

  test('table creation on init', async () => {
    const fresh = createMockPool();
    const { createPostgresWsMessageRepository } =
      await import('../../src/framework/persistence/postgresWsMessages');
    await createPostgresWsMessageRepository(fresh.pool);

    const createTableCall = fresh.calls.find(c => c.sql.includes('CREATE TABLE IF NOT EXISTS'));
    expect(createTableCall).toBeDefined();
    expect(createTableCall!.sql).toContain('ws_messages');

    const createIndexCall = fresh.calls.find(c => c.sql.includes('CREATE INDEX IF NOT EXISTS'));
    expect(createIndexCall).toBeDefined();
    expect(createIndexCall!.sql).toContain('idx_ws_messages_scope');
  });

  test('persist stores message', async () => {
    const msg = makeMessage('chat', { senderId: 'user1', payload: { text: 'hello' } });
    await repo.persist(msg, { maxCount: 100, ttlSeconds: 86400 });

    // Should have INSERT + DELETE (maxCount enforcement)
    expect(mock.calls).toHaveLength(2);

    const insertCall = mock.calls[0];
    expect(insertCall.sql).toContain('INSERT INTO ws_messages');
    expect(insertCall.params).toEqual([
      msg.id,
      msg.endpoint,
      msg.room,
      msg.senderId,
      JSON.stringify(msg.payload),
      msg.createdAt,
    ]);
  });

  test('persist enforces maxCount', async () => {
    const msg = makeMessage('chat', { payload: 'hello' });
    await repo.persist(msg, { maxCount: 50, ttlSeconds: 86400 });

    const deleteCall = mock.calls[1];
    expect(deleteCall.sql).toContain('DELETE FROM ws_messages');
    expect(deleteCall.sql).toContain('NOT IN');
    expect(deleteCall.sql).toContain('LIMIT $3');
    expect(deleteCall.params).toEqual([msg.endpoint, msg.room, 50]);
  });

  test('getHistory returns messages oldest-first', async () => {
    mock.setDefaultResult([
      {
        id: '3',
        endpoint: ENDPOINT,
        room: 'chat',
        sender_id: null,
        payload: 'third',
        created_at: '3000',
      },
      {
        id: '2',
        endpoint: ENDPOINT,
        room: 'chat',
        sender_id: null,
        payload: 'second',
        created_at: '2000',
      },
      {
        id: '1',
        endpoint: ENDPOINT,
        room: 'chat',
        sender_id: null,
        payload: 'first',
        created_at: '1000',
      },
    ]);

    const history = await repo.getHistory(ENDPOINT, 'chat');

    // Should be reversed to oldest-first
    expect(history).toHaveLength(3);
    expect(history[0].payload).toBe('first');
    expect(history[1].payload).toBe('second');
    expect(history[2].payload).toBe('third');

    expect(mock.calls[0].sql).toContain('ORDER BY created_at DESC, id DESC');
  });

  test('getHistory with limit', async () => {
    mock.setDefaultResult([]);

    await repo.getHistory(ENDPOINT, 'chat', { limit: 10 });

    expect(mock.calls[0].sql).toContain('LIMIT $3');
    expect(mock.calls[0].params).toEqual([ENDPOINT, 'chat', 10]);
  });

  test('getHistory with before cursor', async () => {
    // First call: cursor lookup
    mock.enqueueResult([{ created_at: '5000' }]);
    // Second call: history query
    mock.enqueueResult([
      {
        id: '2',
        endpoint: ENDPOINT,
        room: 'chat',
        sender_id: null,
        payload: 'b',
        created_at: '2000',
      },
      {
        id: '1',
        endpoint: ENDPOINT,
        room: 'chat',
        sender_id: null,
        payload: 'a',
        created_at: '1000',
      },
    ]);

    const history = await repo.getHistory(ENDPOINT, 'chat', { before: 'cursor-id' });

    // Cursor lookup
    expect(mock.calls[0].sql).toContain('SELECT created_at FROM ws_messages WHERE id = $1');
    expect(mock.calls[0].params).toEqual(['cursor-id']);

    // History query with keyset pagination
    expect(mock.calls[1].sql).toContain('(created_at, id) < ($3, $4)');
    expect(mock.calls[1].sql).toContain('ORDER BY created_at DESC, id DESC');

    // Results reversed to oldest-first
    expect(history).toHaveLength(2);
    expect(history[0].payload).toBe('a');
    expect(history[1].payload).toBe('b');
  });

  test('getHistory with after cursor', async () => {
    // First call: cursor lookup
    mock.enqueueResult([{ created_at: '1000' }]);
    // Second call: history query (ASC order)
    mock.enqueueResult([
      {
        id: '2',
        endpoint: ENDPOINT,
        room: 'chat',
        sender_id: null,
        payload: 'b',
        created_at: '2000',
      },
      {
        id: '3',
        endpoint: ENDPOINT,
        room: 'chat',
        sender_id: null,
        payload: 'c',
        created_at: '3000',
      },
    ]);

    const history = await repo.getHistory(ENDPOINT, 'chat', { after: 'cursor-id' });

    // History query with ASC order
    expect(mock.calls[1].sql).toContain('(created_at, id) > ($3, $4)');
    expect(mock.calls[1].sql).toContain('ORDER BY created_at ASC, id ASC');

    // Already in oldest-first order — not reversed
    expect(history).toHaveLength(2);
    expect(history[0].payload).toBe('b');
    expect(history[1].payload).toBe('c');
  });

  test('getHistory for empty room', async () => {
    mock.setDefaultResult([]);
    const history = await repo.getHistory(ENDPOINT, 'empty-room');
    expect(history).toEqual([]);
  });

  test('clear deletes all', async () => {
    await repo.clear();

    expect(mock.calls).toHaveLength(1);
    expect(mock.calls[0].sql).toContain('DELETE FROM ws_messages');
  });

  test('clear swallows errors', async () => {
    const { createPostgresWsMessageRepository } =
      await import('../../src/framework/persistence/postgresWsMessages');
    // Need to create with a pool that succeeds on init but fails on clear
    const mockInit = createMockPool();
    const initRepo = await createPostgresWsMessageRepository(mockInit.pool);

    // Override the pool's query to throw
    mockInit.pool.query = (() => {
      throw new Error('connection lost');
    }) as typeof mockInit.pool.query;

    // Should not throw
    await expect(initRepo.clear()).resolves.toBeUndefined();
  });

  test('BIGINT created_at parsed as number', async () => {
    mock.setDefaultResult([
      {
        id: '1',
        endpoint: ENDPOINT,
        room: 'chat',
        sender_id: null,
        payload: null,
        created_at: '1713100000000',
      },
    ]);

    const history = await repo.getHistory(ENDPOINT, 'chat');
    expect(history[0].createdAt).toBe(1713100000000);
    expect(typeof history[0].createdAt).toBe('number');
  });

  test('before cursor returns empty when cursor not found', async () => {
    mock.enqueueResult([]); // cursor lookup returns nothing
    const history = await repo.getHistory(ENDPOINT, 'chat', { before: 'nonexistent' });
    expect(history).toEqual([]);
  });

  test('after cursor returns empty when cursor not found', async () => {
    mock.enqueueResult([]); // cursor lookup returns nothing
    const history = await repo.getHistory(ENDPOINT, 'chat', { after: 'nonexistent' });
    expect(history).toEqual([]);
  });
});
