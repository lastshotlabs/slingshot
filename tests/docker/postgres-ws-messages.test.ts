import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { Pool } from 'pg';
import type { StoredMessage, WsMessageRepository } from '@lastshotlabs/slingshot-core';
import { createPostgresWsMessageRepository } from '../../src/framework/persistence/postgresWsMessages';

const CONNECTION =
  process.env.TEST_POSTGRES_URL ?? 'postgresql://postgres:postgres@localhost:5433/slingshot_test';
const ENDPOINT = '/ws';

function makeMessage(
  room: string,
  data: { id?: string; senderId?: string | null; payload: unknown; createdAt?: number },
): StoredMessage {
  return {
    id: data.id ?? crypto.randomUUID(),
    endpoint: ENDPOINT,
    room,
    senderId: data.senderId ?? null,
    payload: data.payload,
    createdAt: data.createdAt ?? Date.now(),
  };
}

describe('Postgres WS message repository (docker)', () => {
  let pool: Pool;
  let repo: WsMessageRepository;

  beforeAll(async () => {
    pool = new Pool({ connectionString: CONNECTION });
    repo = await createPostgresWsMessageRepository(pool);
  });

  afterAll(async () => {
    await pool.query('DROP TABLE IF EXISTS ws_messages');
    await pool.end();
  });

  beforeEach(async () => {
    await pool.query('DELETE FROM ws_messages');
  });

  const defaults = { maxCount: 100, ttlSeconds: 86400 };

  it('persist and retrieve', async () => {
    const msg = makeMessage('chat', { senderId: 'user1', payload: { text: 'hello' } });
    await repo.persist(msg, defaults);

    const history = await repo.getHistory(ENDPOINT, 'chat');
    expect(history).toHaveLength(1);
    expect(history[0].id).toBe(msg.id);
    expect(history[0].senderId).toBe('user1');
    expect(history[0].payload).toEqual({ text: 'hello' });
  });

  it('history ordering (oldest-first)', async () => {
    const now = Date.now();
    await repo.persist(makeMessage('chat', { payload: 'first', createdAt: now }), defaults);
    await repo.persist(makeMessage('chat', { payload: 'second', createdAt: now + 1 }), defaults);
    await repo.persist(makeMessage('chat', { payload: 'third', createdAt: now + 2 }), defaults);

    const history = await repo.getHistory(ENDPOINT, 'chat');
    expect(history).toHaveLength(3);
    expect(history[0].payload).toBe('first');
    expect(history[1].payload).toBe('second');
    expect(history[2].payload).toBe('third');
  });

  it('maxCount enforcement', async () => {
    const config = { maxCount: 3, ttlSeconds: 86400 };
    const now = Date.now();

    for (let i = 0; i < 5; i++) {
      await repo.persist(makeMessage('chat', { payload: `msg-${i}`, createdAt: now + i }), config);
    }

    const history = await repo.getHistory(ENDPOINT, 'chat');
    expect(history).toHaveLength(3);
    expect(history[0].payload).toBe('msg-2');
    expect(history[1].payload).toBe('msg-3');
    expect(history[2].payload).toBe('msg-4');
  });

  it('before cursor pagination', async () => {
    const now = Date.now();
    const messages: StoredMessage[] = [];
    for (let i = 0; i < 5; i++) {
      const msg = makeMessage('chat', { payload: `msg-${i}`, createdAt: now + i });
      messages.push(await repo.persist(msg, defaults));
    }

    // Get messages before the last one
    const history = await repo.getHistory(ENDPOINT, 'chat', { before: messages[4].id });
    expect(history).toHaveLength(4);
    expect(history[0].payload).toBe('msg-0');
    expect(history[3].payload).toBe('msg-3');
  });

  it('after cursor pagination', async () => {
    const now = Date.now();
    const messages: StoredMessage[] = [];
    for (let i = 0; i < 5; i++) {
      const msg = makeMessage('chat', { payload: `msg-${i}`, createdAt: now + i });
      messages.push(await repo.persist(msg, defaults));
    }

    // Get messages after the first one
    const history = await repo.getHistory(ENDPOINT, 'chat', { after: messages[0].id });
    expect(history).toHaveLength(4);
    expect(history[0].payload).toBe('msg-1');
    expect(history[3].payload).toBe('msg-4');
  });

  it('limit', async () => {
    const now = Date.now();
    for (let i = 0; i < 10; i++) {
      await repo.persist(
        makeMessage('chat', { payload: `msg-${i}`, createdAt: now + i }),
        defaults,
      );
    }

    const history = await repo.getHistory(ENDPOINT, 'chat', { limit: 3 });
    expect(history).toHaveLength(3);
    // Returns last 3 (oldest-first within the window)
    expect(history[0].payload).toBe('msg-7');
    expect(history[1].payload).toBe('msg-8');
    expect(history[2].payload).toBe('msg-9');
  });

  it('multiple rooms are independent', async () => {
    await repo.persist(makeMessage('room1', { payload: 'r1-msg' }), defaults);
    await repo.persist(makeMessage('room2', { payload: 'r2-msg' }), defaults);

    const h1 = await repo.getHistory(ENDPOINT, 'room1');
    const h2 = await repo.getHistory(ENDPOINT, 'room2');

    expect(h1).toHaveLength(1);
    expect(h1[0].payload).toBe('r1-msg');
    expect(h2).toHaveLength(1);
    expect(h2[0].payload).toBe('r2-msg');
  });

  it('complex JSON payload', async () => {
    const payload = { text: 'hello', metadata: { nested: true, count: 42, tags: ['a', 'b'] } };
    await repo.persist(makeMessage('chat', { payload }), defaults);

    const history = await repo.getHistory(ENDPOINT, 'chat');
    expect(history[0].payload).toEqual(payload);
  });

  it('null senderId', async () => {
    await repo.persist(makeMessage('chat', { senderId: null, payload: 'server-msg' }), defaults);

    const history = await repo.getHistory(ENDPOINT, 'chat');
    expect(history[0].senderId).toBeNull();
  });

  it('clear resets all', async () => {
    await repo.persist(makeMessage('chat', { payload: 'hello' }), defaults);
    await repo.clear();

    const history = await repo.getHistory(ENDPOINT, 'chat');
    expect(history).toEqual([]);
  });
});
