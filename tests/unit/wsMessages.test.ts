import { beforeEach, describe, expect, test } from 'bun:test';
import type { StoredMessage, WsMessageRepository } from '@lastshotlabs/slingshot-core';
import { createMemoryWsMessageRepository } from '../../src/framework/persistence/wsMessages';

const ENDPOINT = '/ws';

describe('wsMessages (memory backend)', () => {
  let repo: WsMessageRepository;
  let defaults: { maxCount: number; ttlSeconds: number };

  beforeEach(async () => {
    repo = createMemoryWsMessageRepository();
    defaults = { maxCount: 100, ttlSeconds: 86400 };
  });

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

  test('persist stores message', async () => {
    const msg = makeMessage('chat', { senderId: 'user1', payload: 'hello' });
    const result = await repo.persist(msg, defaults);

    expect(result).not.toBeNull();
    expect(result.room).toBe('chat');
    expect(result.senderId).toBe('user1');
    expect(result.payload).toBe('hello');
    expect(result.id).toBeTruthy();
    expect(result.createdAt).toBeGreaterThan(0);
  });

  test('persist defaults senderId to null', async () => {
    const msg = makeMessage('chat', { payload: 'anon' });
    const result = await repo.persist(msg, defaults);
    expect(result.senderId).toBeNull();
  });

  test('getHistory returns stored messages in order', async () => {
    await repo.persist(makeMessage('chat', { senderId: 'u1', payload: 'first' }), defaults);
    await repo.persist(makeMessage('chat', { senderId: 'u2', payload: 'second' }), defaults);
    await repo.persist(makeMessage('chat', { senderId: 'u1', payload: 'third' }), defaults);

    const history = await repo.getHistory(ENDPOINT, 'chat');
    expect(history).toHaveLength(3);
    expect(history[0].payload).toBe('first');
    expect(history[1].payload).toBe('second');
    expect(history[2].payload).toBe('third');
  });

  test('getHistory returns empty for non-existent room', async () => {
    const history = await repo.getHistory(ENDPOINT, 'nonexistent');
    expect(history).toEqual([]);
  });

  test('maxCount trims oldest messages', async () => {
    const config = { maxCount: 3, ttlSeconds: 86400 };

    await repo.persist(makeMessage('chat', { payload: '1' }), config);
    await repo.persist(makeMessage('chat', { payload: '2' }), config);
    await repo.persist(makeMessage('chat', { payload: '3' }), config);
    await repo.persist(makeMessage('chat', { payload: '4' }), config);

    const history = await repo.getHistory(ENDPOINT, 'chat');
    expect(history).toHaveLength(3);
    expect(history[0].payload).toBe('2');
    expect(history[1].payload).toBe('3');
    expect(history[2].payload).toBe('4');
  });

  test('before cursor returns messages before the cursor', async () => {
    const m1 = await repo.persist(makeMessage('chat', { payload: '1' }), defaults);
    const m2 = await repo.persist(makeMessage('chat', { payload: '2' }), defaults);
    const m3 = await repo.persist(makeMessage('chat', { payload: '3' }), defaults);

    const history = await repo.getHistory(ENDPOINT, 'chat', { before: m3.id });
    expect(history).toHaveLength(2);
    expect(history[0].payload).toBe('1');
    expect(history[1].payload).toBe('2');
  });

  test('after cursor returns messages after the cursor', async () => {
    const m1 = await repo.persist(makeMessage('chat', { payload: '1' }), defaults);
    const m2 = await repo.persist(makeMessage('chat', { payload: '2' }), defaults);
    const m3 = await repo.persist(makeMessage('chat', { payload: '3' }), defaults);

    const history = await repo.getHistory(ENDPOINT, 'chat', { after: m1.id });
    expect(history).toHaveLength(2);
    expect(history[0].payload).toBe('2');
    expect(history[1].payload).toBe('3');
  });

  test('limit restricts result count', async () => {
    for (let i = 0; i < 10; i++) {
      await repo.persist(makeMessage('chat', { payload: `msg-${i}` }), defaults);
    }

    const history = await repo.getHistory(ENDPOINT, 'chat', { limit: 3 });
    expect(history).toHaveLength(3);
    // Returns last 3
    expect(history[0].payload).toBe('msg-7');
    expect(history[1].payload).toBe('msg-8');
    expect(history[2].payload).toBe('msg-9');
  });

  test('messages support complex payloads', async () => {
    const payload = { text: 'hello', metadata: { nested: true, count: 42 } };
    await repo.persist(makeMessage('chat', { payload }), defaults);

    const history = await repo.getHistory(ENDPOINT, 'chat');
    expect(history[0].payload).toEqual(payload);
  });

  test('multiple rooms are independent', async () => {
    await repo.persist(makeMessage('room1', { payload: 'r1-msg' }), defaults);
    await repo.persist(makeMessage('room2', { payload: 'r2-msg' }), defaults);

    const h1 = await repo.getHistory(ENDPOINT, 'room1');
    const h2 = await repo.getHistory(ENDPOINT, 'room2');

    expect(h1).toHaveLength(1);
    expect(h1[0].payload).toBe('r1-msg');
    expect(h2).toHaveLength(1);
    expect(h2[0].payload).toBe('r2-msg');
  });

  test('clear resets all state', async () => {
    await repo.persist(makeMessage('chat', { payload: 'hello' }), defaults);
    await repo.clear();

    const history = await repo.getHistory(ENDPOINT, 'chat');
    expect(history).toEqual([]);
  });
});
