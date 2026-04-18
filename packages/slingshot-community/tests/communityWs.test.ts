/**
 * Tests for community plugin WebSocket wiring.
 *
 * Validates:
 * - buildReceiveIncoming() returns {} when ws not configured
 * - buildReceiveIncoming() is callable when ws is configured
 * - buildSubscribeGuard() returns a no-op guard (true) when ws not configured
 * - buildSubscribeGuard() returns a guard function when ws is configured
 * - Typing handlers from buildEntityReceiveHandlers broadcast correctly
 */
import { describe, expect, it, mock } from 'bun:test';
import type {
  EntityChannelConfig,
  ResolvedEntityConfig,
  WsState,
} from '@lastshotlabs/slingshot-core';
import { buildEntityReceiveHandlers } from '@lastshotlabs/slingshot-entity';
import type { WsPublishFn } from '@lastshotlabs/slingshot-entity';
import { createCommunityPlugin } from '../src/plugin';
import type { CommunityPluginConfig } from '../src/types/config';

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

const mockWsState = { presenceEnabled: true } as unknown as WsState;

function makePublishFn(): { fn: WsPublishFn; calls: unknown[][] } {
  const calls: unknown[][] = [];
  const fn: WsPublishFn = (state, endpoint, room, data, options) => {
    calls.push([state, endpoint, room, data, options]);
  };
  return { fn, calls };
}

function makeWs(socketId: string, rooms: string[]): unknown {
  return { data: { id: socketId, rooms: new Set(rooms) } };
}

const baseConfig: CommunityPluginConfig = {
  containerCreation: 'user',
};

// Minimal container config for receive handler tests
const containerConfig: ResolvedEntityConfig = {
  name: 'Container',
  fields: {
    id: { type: 'string', primary: true, immutable: true, optional: false, default: 'uuid' },
  },
  _pkField: 'id',
  _storageName: 'containers',
};

const containerChannel: EntityChannelConfig = {
  channels: {
    live: {
      auth: 'userAuth',
      presence: true,
      receive: {
        events: ['document.typing', 'thread.typing'],
        toRoom: true,
        excludeSender: true,
      },
    },
  },
};

// ---------------------------------------------------------------------------
// createCommunityPlugin WS wiring
// ---------------------------------------------------------------------------

describe('createCommunityPlugin WS wiring', () => {
  it('buildReceiveIncoming returns {} when ws not configured', () => {
    const plugin = createCommunityPlugin(baseConfig);
    const result = plugin.buildReceiveIncoming();
    expect(result).toEqual({});
  });

  it('buildReceiveIncoming is callable (returns object) when ws is configured', () => {
    const plugin = createCommunityPlugin({
      ...baseConfig,
      ws: {
        wsEndpoint: 'community',
      },
    });
    // innerPlugin is created in setupMiddleware; before that, returns {}.
    // This validates the method exists on the returned interface.
    const result = plugin.buildReceiveIncoming();
    expect(typeof result).toBe('object');
  });

  it('buildSubscribeGuard returns a function that resolves true when ws not configured', async () => {
    const plugin = createCommunityPlugin(baseConfig);
    const guard = plugin.buildSubscribeGuard({
      getIdentity: () => null,
      checkPermission: async () => false,
      middleware: {},
    });
    expect(typeof guard).toBe('function');
    // Before setupMiddleware, innerPlugin is undefined — no-op guard
    const result = await guard({}, 'containers:abc:live');
    expect(result).toBe(true);
  });

  it('buildSubscribeGuard returns a function when ws is configured', () => {
    const plugin = createCommunityPlugin({
      ...baseConfig,
      ws: {
        wsEndpoint: 'community',
      },
    });
    const guard = plugin.buildSubscribeGuard({
      getIdentity: () => null,
      checkPermission: async () => false,
      middleware: {},
    });
    expect(typeof guard).toBe('function');
  });
});

// ---------------------------------------------------------------------------
// Typing handler behavior (via buildEntityReceiveHandlers directly)
// Tests the receive config that createCommunityPlugin injects for containers.
// ---------------------------------------------------------------------------

describe('community container receive handlers', () => {
  it('document.typing handler broadcasts to room excluding sender', async () => {
    const { fn, calls } = makePublishFn();
    const handlers = buildEntityReceiveHandlers(
      containerChannel,
      containerConfig,
      () => mockWsState,
      fn,
      'community',
    );

    expect(handlers['document.typing']).toBeDefined();
    expect(handlers['thread.typing']).toBeDefined();

    const ws = makeWs('sender-socket', ['containers:abc:live']);
    await handlers['document.typing'].handler(
      ws,
      { room: 'containers:abc:live' },
      {
        socketId: 'sender-socket',
        userId: 'user-1',
        endpoint: 'community',
        publish() {},
        subscribe() {},
        unsubscribe() {},
      },
    );

    expect(calls).toHaveLength(1);
    const [, endpoint, room, , options] = calls[0] as unknown[];
    expect(endpoint).toBe('community');
    expect(room).toBe('containers:abc:live');
    expect((options as { exclude: Set<string> }).exclude).toContain('sender-socket');
  });

  it('thread.typing handler includes payload data in broadcast', async () => {
    const { fn, calls } = makePublishFn();
    const handlers = buildEntityReceiveHandlers(
      containerChannel,
      containerConfig,
      () => mockWsState,
      fn,
      'community',
    );

    const ws = makeWs('sender-socket', ['containers:abc:live']);
    await handlers['thread.typing'].handler(
      ws,
      { room: 'containers:abc:live', threadId: 'thread-123' },
      {
        socketId: 'sender-socket',
        userId: 'user-1',
        endpoint: 'community',
        publish() {},
        subscribe() {},
        unsubscribe() {},
      },
    );

    expect(calls).toHaveLength(1);
    const [, , , data] = calls[0] as unknown[];
    expect((data as Record<string, unknown>).event).toBe('thread.typing');
    expect((data as Record<string, unknown>).threadId).toBe('thread-123');
  });

  it('handler rejects events from unauthenticated sender (not subscribed)', async () => {
    const { fn, calls } = makePublishFn();
    const handlers = buildEntityReceiveHandlers(
      containerChannel,
      containerConfig,
      () => mockWsState,
      fn,
      'community',
    );

    // WS not subscribed to the room
    const ws = makeWs('sender-socket', []);
    await handlers['document.typing'].handler(
      ws,
      { room: 'containers:abc:live' },
      {
        socketId: 'sender-socket',
        userId: null,
        endpoint: 'community',
        publish() {},
        subscribe() {},
        unsubscribe() {},
      },
    );

    expect(calls).toHaveLength(0);
  });
});
