import { describe, expect, test } from 'bun:test';
import type { WsState } from '@lastshotlabs/slingshot-core';
import { handleRoomActions } from '../../src/framework/ws/rooms';

/** Create a minimal WsState for testing. */
function makeWsState(): WsState {
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
  };
}

/** Minimal mock WebSocket for testing handleRoomActions. */
function mockWs() {
  const sent: string[] = [];
  const subscribed: string[] = [];
  return {
    data: { id: 'test-socket', endpoint: '/ws', rooms: new Set<string>() },
    send(msg: string) {
      sent.push(msg);
    },
    subscribe(room: string) {
      subscribed.push(room);
    },
    unsubscribe(_room: string) {},
    sent,
    subscribed,
  } as any;
}

describe('handleRoomActions — size limit', () => {
  test('rejects messages larger than 4KB', async () => {
    const state = makeWsState();
    const ws = mockWs();
    // Create a message larger than MAX_ROOM_ACTION_SIZE (4096 bytes)
    const oversized = JSON.stringify({ action: 'subscribe', room: 'a'.repeat(5000) });
    const result = await handleRoomActions(state, ws, oversized);
    // Should return false (not handled as room action)
    expect(result).toBe(false);
    expect(ws.sent).toHaveLength(0);
    expect(ws.subscribed).toHaveLength(0);
  });

  test('handles normal-sized subscribe messages', async () => {
    const state = makeWsState();
    const ws = mockWs();
    const msg = JSON.stringify({ action: 'subscribe', room: 'test-room' });
    const result = await handleRoomActions(state, ws, msg);
    expect(result).toBe(true);
    expect(ws.data.rooms.has('test-room')).toBe(true);
  });

  test('ignores non-JSON messages without error', async () => {
    const state = makeWsState();
    const ws = mockWs();
    const result = await handleRoomActions(state, ws, 'not json');
    expect(result).toBe(false);
  });

  test('handles unsubscribe messages', async () => {
    const state = makeWsState();
    const ws = mockWs();
    // First subscribe so the room is in the set
    ws.data.rooms.add('test-room');
    const msg = JSON.stringify({ action: 'unsubscribe', room: 'test-room' });
    const result = await handleRoomActions(state, ws, msg);
    expect(result).toBe(true);
    expect(ws.sent).toHaveLength(1);
    expect(JSON.parse(ws.sent[0]).event).toBe('unsubscribed');
  });

  test('respects room guard — deny', async () => {
    const state = makeWsState();
    const ws = mockWs();
    const msg = JSON.stringify({ action: 'subscribe', room: 'secret-room' });
    const guard = () => false;
    const result = await handleRoomActions(state, ws, msg, guard);
    expect(result).toBe(true); // handled (returned deny event)
    expect(ws.subscribed).toHaveLength(0);
    expect(ws.sent).toHaveLength(1);
    expect(JSON.parse(ws.sent[0]).event).toBe('subscribe_denied');
  });
});
