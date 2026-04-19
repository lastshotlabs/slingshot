import { beforeEach, describe, expect, it } from 'bun:test';
import type { WsState } from '@lastshotlabs/slingshot-core';
import {
  cleanupSocket,
  getRoomSubscribers,
  getRooms,
  getSubscriptions,
  publish,
  subscribe,
  unsubscribe,
} from '../../src/framework/ws/rooms';

const ENDPOINT = '/ws';

function createWsState(overrides?: Partial<WsState>): WsState {
  return {
    server: null,
    transport: null,
    instanceId: 'test-instance',
    presenceEnabled: false,
    roomRegistry: new Map(),
    heartbeatSockets: new Map(),
    heartbeatEndpointConfigs: new Map(),
    heartbeatTimer: null,
    socketUsers: new Map(),
    roomPresence: new Map(),
    socketRegistry: new Map(),
    rateLimitState: new Map(),
    sessionRegistry: new Map(),
    lastEventIds: new Map(),
    ...overrides,
  };
}

// Mock ServerWebSocket with the minimal interface needed
function createMockWs(id: string) {
  const subscribed = new Set<string>();
  return {
    data: { id, endpoint: ENDPOINT, rooms: new Set<string>() },
    subscribe(room: string) {
      subscribed.add(room);
    },
    unsubscribe(room: string) {
      subscribed.delete(room);
    },
    send() {},
    _subscribed: subscribed,
  } as any;
}

describe('ws room management', () => {
  let state: WsState;

  beforeEach(() => {
    state = createWsState();
  });

  describe('subscribe + unsubscribe', () => {
    it('subscribes a socket to a room', () => {
      const ws = createMockWs('sock-1');
      subscribe(state, ws, 'chat');

      expect(ws.data.rooms.has('chat')).toBe(true);
      expect(getRooms(state, ENDPOINT)).toContain('chat');
      expect(getRoomSubscribers(state, ENDPOINT, 'chat')).toContain('sock-1');
    });

    it('unsubscribes a socket from a room', () => {
      const ws = createMockWs('sock-2');
      subscribe(state, ws, 'chat');
      unsubscribe(state, ws, 'chat');

      expect(ws.data.rooms.has('chat')).toBe(false);
      expect(getRoomSubscribers(state, ENDPOINT, 'chat')).toEqual([]);
    });

    it('removes room from registry when last subscriber leaves', () => {
      const ws = createMockWs('sock-3');
      subscribe(state, ws, 'empty-room');
      unsubscribe(state, ws, 'empty-room');

      expect(getRooms(state, ENDPOINT)).not.toContain('empty-room');
    });

    it('handles multiple sockets in same room', () => {
      const ws1 = createMockWs('sock-a');
      const ws2 = createMockWs('sock-b');
      subscribe(state, ws1, 'multi');
      subscribe(state, ws2, 'multi');

      expect(getRoomSubscribers(state, ENDPOINT, 'multi')).toHaveLength(2);
      expect(getRoomSubscribers(state, ENDPOINT, 'multi')).toContain('sock-a');
      expect(getRoomSubscribers(state, ENDPOINT, 'multi')).toContain('sock-b');

      unsubscribe(state, ws1, 'multi');
      expect(getRoomSubscribers(state, ENDPOINT, 'multi')).toEqual(['sock-b']);
    });
  });

  describe('getSubscriptions', () => {
    it('returns rooms a socket is subscribed to', () => {
      const ws = createMockWs('sock-sub');
      subscribe(state, ws, 'room-1');
      subscribe(state, ws, 'room-2');

      const subs = getSubscriptions(ws);
      expect(subs).toHaveLength(2);
      expect(subs).toContain('room-1');
      expect(subs).toContain('room-2');
    });
  });

  describe('getRooms', () => {
    it('lists all rooms with subscribers', () => {
      const ws = createMockWs('sock-rooms');
      subscribe(state, ws, 'alpha');
      subscribe(state, ws, 'beta');

      const rooms = getRooms(state, ENDPOINT);
      expect(rooms).toContain('alpha');
      expect(rooms).toContain('beta');
    });
  });

  describe('getRoomSubscribers', () => {
    it('returns empty array for non-existent room', () => {
      expect(getRoomSubscribers(state, ENDPOINT, 'nonexistent')).toEqual([]);
    });
  });

  describe('cleanupSocket', () => {
    it('removes socket from all rooms on disconnect', () => {
      const ws = createMockWs('sock-cleanup');
      subscribe(state, ws, 'room-x');
      subscribe(state, ws, 'room-y');

      cleanupSocket(state, ws);

      expect(getRoomSubscribers(state, ENDPOINT, 'room-x')).toEqual([]);
      expect(getRoomSubscribers(state, ENDPOINT, 'room-y')).toEqual([]);
      // Rooms should be cleaned up since they're empty
      expect(getRooms(state, ENDPOINT)).not.toContain('room-x');
      expect(getRooms(state, ENDPOINT)).not.toContain('room-y');
    });
  });

  describe('publish', () => {
    it('does not throw when no server is set', () => {
      // state.server is null, publish should be a no-op
      expect(() => publish(state, ENDPOINT, 'topic', { msg: 'hello' })).not.toThrow();
    });

    it('publishes when server is set', () => {
      let published: { topic: string; data: string } | null = null;
      const mockServer = {
        publish(topic: string, data: string) {
          published = { topic, data };
        },
      } as any;
      state.server = mockServer;

      publish(state, ENDPOINT, 'my-topic', { hello: 'world' });

      expect(published).not.toBeNull();
      expect(JSON.parse(published!.data)).toEqual({ hello: 'world' });
    });
  });
});
