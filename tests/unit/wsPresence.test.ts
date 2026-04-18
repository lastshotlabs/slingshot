import { beforeEach, describe, expect, test } from 'bun:test';
import type { WsState } from '@lastshotlabs/slingshot-core';
import {
  addPresence,
  cleanupPresence,
  getRoomPresence,
  getUserPresence,
  removePresence,
  trackSocket,
  untrackSocket,
} from '../../src/framework/ws/presence';

const ENDPOINT = '/ws';

function createWsState(): WsState {
  return {
    server: null,
    transport: null,
    instanceId: 'test-instance',
    presenceEnabled: true,
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
  };
}

describe('wsPresence', () => {
  let state: WsState;

  beforeEach(() => {
    state = createWsState();
  });

  test('trackSocket stores userId for authenticated sockets', () => {
    trackSocket(state, 's1', 'user1');
    const result = addPresence(state, 's1', ENDPOINT, 'room1');
    expect(result).toEqual({ userId: 'user1', isNewUser: true });
  });

  test('trackSocket skips null userId', () => {
    trackSocket(state, 's1', null);
    const result = addPresence(state, 's1', ENDPOINT, 'room1');
    expect(result).toBeNull();
  });

  test('addPresence returns isNewUser true for first socket', () => {
    trackSocket(state, 's1', 'user1');
    const result = addPresence(state, 's1', ENDPOINT, 'room1');
    expect(result).toEqual({ userId: 'user1', isNewUser: true });
  });

  test('addPresence returns isNewUser false for second socket (multi-tab)', () => {
    trackSocket(state, 's1', 'user1');
    trackSocket(state, 's2', 'user1');
    addPresence(state, 's1', ENDPOINT, 'room1');
    const result = addPresence(state, 's2', ENDPOINT, 'room1');
    expect(result).toEqual({ userId: 'user1', isNewUser: false });
  });

  test('removePresence returns isLastSocket correctly', () => {
    trackSocket(state, 's1', 'user1');
    trackSocket(state, 's2', 'user1');
    addPresence(state, 's1', ENDPOINT, 'room1');
    addPresence(state, 's2', ENDPOINT, 'room1');

    const first = removePresence(state, 's1', ENDPOINT, 'room1');
    expect(first).toEqual({ userId: 'user1', isLastSocket: false });

    const second = removePresence(state, 's2', ENDPOINT, 'room1');
    expect(second).toEqual({ userId: 'user1', isLastSocket: true });
  });

  test('removePresence returns null for unauthenticated socket', () => {
    trackSocket(state, 's1', null);
    const result = removePresence(state, 's1', ENDPOINT, 'room1');
    expect(result).toBeNull();
  });

  test('removePresence returns null for room with no presence', () => {
    trackSocket(state, 's1', 'user1');
    const result = removePresence(state, 's1', ENDPOINT, 'nonexistent-room');
    expect(result).toBeNull();
  });

  test('cleanupPresence handles disconnect across multiple rooms', () => {
    trackSocket(state, 's1', 'user1');
    addPresence(state, 's1', ENDPOINT, 'room1');
    addPresence(state, 's1', ENDPOINT, 'room2');

    const departed = cleanupPresence(state, 's1', ENDPOINT, new Set(['room1', 'room2']));
    expect(departed).toHaveLength(2);
    expect(departed).toContainEqual({ room: 'room1', userId: 'user1' });
    expect(departed).toContainEqual({ room: 'room2', userId: 'user1' });
  });

  test('cleanupPresence does not report departure when other sockets remain', () => {
    trackSocket(state, 's1', 'user1');
    trackSocket(state, 's2', 'user1');
    addPresence(state, 's1', ENDPOINT, 'room1');
    addPresence(state, 's2', ENDPOINT, 'room1');

    const departed = cleanupPresence(state, 's1', ENDPOINT, new Set(['room1']));
    expect(departed).toHaveLength(0);
  });

  test('cleanupPresence returns empty for unauthenticated socket', () => {
    trackSocket(state, 's1', null);
    const departed = cleanupPresence(state, 's1', ENDPOINT, new Set(['room1']));
    expect(departed).toHaveLength(0);
  });

  test('getRoomPresence returns deduplicated userIds', () => {
    trackSocket(state, 's1', 'user1');
    trackSocket(state, 's2', 'user1');
    trackSocket(state, 's3', 'user2');
    addPresence(state, 's1', ENDPOINT, 'room1');
    addPresence(state, 's2', ENDPOINT, 'room1');
    addPresence(state, 's3', ENDPOINT, 'room1');

    const presence = getRoomPresence(state, ENDPOINT, 'room1');
    expect(presence.sort()).toEqual(['user1', 'user2']);
  });

  test('getRoomPresence returns empty array for unknown room', () => {
    expect(getRoomPresence(state, ENDPOINT, 'unknown')).toEqual([]);
  });

  test('getUserPresence returns rooms where user is present', () => {
    trackSocket(state, 's1', 'user1');
    addPresence(state, 's1', ENDPOINT, 'room1');
    addPresence(state, 's1', ENDPOINT, 'room2');

    const rooms = getUserPresence(state, 'user1');
    expect(rooms.sort()).toEqual(['room1', 'room2']);
  });

  test('getUserPresence returns empty for unknown user', () => {
    expect(getUserPresence(state, 'unknown')).toEqual([]);
  });

  test('untrackSocket removes socket-user mapping', () => {
    trackSocket(state, 's1', 'user1');
    untrackSocket(state, 's1');
    // After untrack, addPresence returns null since userId mapping is gone
    const result = addPresence(state, 's1', ENDPOINT, 'room1');
    expect(result).toBeNull();
  });

  test('presence cleans up empty room maps', () => {
    trackSocket(state, 's1', 'user1');
    addPresence(state, 's1', ENDPOINT, 'room1');
    removePresence(state, 's1', ENDPOINT, 'room1');

    // Room should be cleaned up entirely
    expect(getRoomPresence(state, ENDPOINT, 'room1')).toEqual([]);
  });

  test('fresh state has no presence data', () => {
    expect(getRoomPresence(state, ENDPOINT, 'room1')).toEqual([]);
    expect(getUserPresence(state, 'user1')).toEqual([]);
  });
});
