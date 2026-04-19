/**
 * Tests for src/framework/ws/messages.ts (lines 21-44, 53-58, 66-72)
 *
 * This module is a thin wrapper that consumes repositories from app context.
 */
import { describe, expect, spyOn, test } from 'bun:test';
import { Hono } from 'hono';
import { attachContext } from '@lastshotlabs/slingshot-core';
import type { RoomPersistenceConfig, StoredMessage, WsMessageRepository } from '@lastshotlabs/slingshot-core';
import { persistMessage, getMessageHistory, configureRoom } from '../../src/framework/ws/messages';
import { createMemoryWsMessageRepository } from '../../src/framework/persistence/wsMessages';

function makeStoredMessage(overrides: Partial<StoredMessage> = {}): StoredMessage {
  return {
    id: crypto.randomUUID(),
    endpoint: '/ws',
    room: 'general',
    senderId: 'user-1',
    payload: { text: 'hello' },
    createdAt: Date.now(),
    ...overrides,
  };
}

function buildAppWithPersistence(opts: {
  wsMessages?: WsMessageRepository;
  configuredRooms?: Map<string, { maxCount: number; ttlSeconds: number }>;
}) {
  const app = new Hono();
  const wsMessages = opts.wsMessages ?? createMemoryWsMessageRepository();
  const roomConfigs = opts.configuredRooms ?? new Map<string, { maxCount: number; ttlSeconds: number }>();

  const ctx = {
    app,
    config: { appName: 'test', resolvedStores: {}, security: {} },
    redis: null,
    mongo: null,
    sqlite: null,
    signing: null,
    dataEncryptionKeys: [],
    ws: null,
    persistence: {
      wsMessages,
      configureRoom(endpoint: string, room: string, config: RoomPersistenceConfig) {
        const key = `${endpoint}\0${room}`;
        if (!config.persist) {
          roomConfigs.delete(key);
          return;
        }
        roomConfigs.set(key, {
          maxCount: config.maxCount ?? 100,
          ttlSeconds: config.ttlSeconds ?? 86400,
        });
      },
      getRoomConfig(endpoint: string, room: string) {
        return roomConfigs.get(`${endpoint}\0${room}`) ?? null;
      },
    },
    pluginState: new Map(),
    async clear() {},
    async destroy() {},
  } as any;
  attachContext(app, ctx);
  return { app, wsMessages, roomConfigs };
}

describe('persistMessage', () => {
  test('returns null when room is not configured', async () => {
    const { app } = buildAppWithPersistence({});

    const result = await persistMessage('/ws', 'unconfigured-room', { payload: 'test' }, app);
    expect(result).toBeNull();
  });

  test('persists message when room is configured and returns StoredMessage', async () => {
    const { app, roomConfigs } = buildAppWithPersistence({});
    // Configure the room
    roomConfigs.set('/ws\0general', { maxCount: 100, ttlSeconds: 86400 });

    const result = await persistMessage(
      '/ws',
      'general',
      { senderId: 'user-1', payload: { text: 'hello' } },
      app,
    );

    expect(result).not.toBeNull();
    expect(result?.endpoint).toBe('/ws');
    expect(result?.room).toBe('general');
    expect(result?.senderId).toBe('user-1');
    expect(result?.payload).toEqual({ text: 'hello' });
  });

  test('senderId defaults to null when not provided', async () => {
    const { app, roomConfigs } = buildAppWithPersistence({});
    roomConfigs.set('/ws\0chat', { maxCount: 100, ttlSeconds: 86400 });

    const result = await persistMessage('/ws', 'chat', { payload: 'anon msg' }, app);

    expect(result?.senderId).toBeNull();
  });

  test('returns null and logs warning when persist throws', async () => {
    const failingRepo: WsMessageRepository = {
      async persist() {
        throw new Error('DB write failed');
      },
      async getHistory() {
        return [];
      },
      async clear() {},
    };

    const consoleSpy = spyOn(console, 'warn').mockImplementation(() => {});

    const { app, roomConfigs } = buildAppWithPersistence({ wsMessages: failingRepo });
    roomConfigs.set('/ws\0chat', { maxCount: 100, ttlSeconds: 86400 });

    const result = await persistMessage('/ws', 'chat', { payload: 'msg' }, app);

    expect(result).toBeNull();
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining('[wsMessages] failed to persist'),
      expect.any(Error),
    );
    consoleSpy.mockRestore();
  });

  test('message has a valid UUID id', async () => {
    const { app, roomConfigs } = buildAppWithPersistence({});
    roomConfigs.set('/ws\0room1', { maxCount: 100, ttlSeconds: 86400 });

    const result = await persistMessage('/ws', 'room1', { payload: 'test' }, app);

    expect(result?.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
  });

  test('message createdAt is a recent timestamp', async () => {
    const before = Date.now();
    const { app, roomConfigs } = buildAppWithPersistence({});
    roomConfigs.set('/ws\0room2', { maxCount: 100, ttlSeconds: 86400 });

    const result = await persistMessage('/ws', 'room2', { payload: 'test' }, app);
    const after = Date.now();

    expect(result?.createdAt).toBeGreaterThanOrEqual(before);
    expect(result?.createdAt).toBeLessThanOrEqual(after);
  });
});

describe('getMessageHistory', () => {
  test('returns empty array when no messages persisted', async () => {
    const { app } = buildAppWithPersistence({});

    const history = await getMessageHistory('/ws', 'empty-room', undefined, app);
    expect(history).toEqual([]);
  });

  test('returns persisted messages for a room', async () => {
    const { app, roomConfigs } = buildAppWithPersistence({});
    roomConfigs.set('/ws\0chat', { maxCount: 100, ttlSeconds: 86400 });

    await persistMessage('/ws', 'chat', { senderId: 'u1', payload: 'msg1' }, app);
    await persistMessage('/ws', 'chat', { senderId: 'u2', payload: 'msg2' }, app);

    const history = await getMessageHistory('/ws', 'chat', undefined, app);
    expect(history).toHaveLength(2);
  });

  test('passes options (limit) to repository', async () => {
    const { app, roomConfigs } = buildAppWithPersistence({});
    roomConfigs.set('/ws\0room', { maxCount: 100, ttlSeconds: 86400 });

    for (let i = 0; i < 5; i++) {
      await persistMessage('/ws', 'room', { payload: `msg-${i}` }, app);
    }

    const history = await getMessageHistory('/ws', 'room', { limit: 2 }, app);
    expect(history.length).toBe(2);
  });

  test('delegates to persistence.wsMessages.getHistory', async () => {
    const mockRepo: WsMessageRepository = {
      async persist(msg) { return msg; },
      async getHistory(endpoint, room, opts) {
        return [
          { id: 'test-id', endpoint, room, senderId: null, payload: 'from-mock', createdAt: Date.now() },
        ];
      },
      async clear() {},
    };

    const { app } = buildAppWithPersistence({ wsMessages: mockRepo });

    const history = await getMessageHistory('/ws', 'room', undefined, app);
    expect(history[0].payload).toBe('from-mock');
  });
});

describe('configureRoom', () => {
  test('configures a room for persistence', () => {
    const { app, roomConfigs } = buildAppWithPersistence({});

    configureRoom('/ws', 'chat', { persist: true, maxCount: 50, ttlSeconds: 3600 }, app);

    const config = roomConfigs.get('/ws\0chat');
    expect(config).not.toBeNull();
    expect(config?.maxCount).toBe(50);
    expect(config?.ttlSeconds).toBe(3600);
  });

  test('removing room config when persist is false', () => {
    const { app, roomConfigs } = buildAppWithPersistence({});

    // First configure it
    roomConfigs.set('/ws\0chat', { maxCount: 100, ttlSeconds: 86400 });

    // Then disable persistence
    configureRoom('/ws', 'chat', { persist: false }, app);

    expect(roomConfigs.get('/ws\0chat')).toBeUndefined();
  });

  test('configures multiple rooms independently', () => {
    const { app, roomConfigs } = buildAppWithPersistence({});

    configureRoom('/ws', 'room1', { persist: true, maxCount: 10, ttlSeconds: 100 }, app);
    configureRoom('/ws', 'room2', { persist: true, maxCount: 20, ttlSeconds: 200 }, app);

    expect(roomConfigs.get('/ws\0room1')?.maxCount).toBe(10);
    expect(roomConfigs.get('/ws\0room2')?.maxCount).toBe(20);
  });
});
