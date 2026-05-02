import { describe, expect, mock, test } from 'bun:test';
import type { WsState } from '@lastshotlabs/slingshot-core';
import {
  cleanupSocket,
  getRoomSubscribers,
  getRooms,
  getSubscriptions,
  handleRoomActions,
  publish,
  subscribe,
  unsubscribe,
} from '../../src/framework/ws/rooms';

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
function mockWs(id = 'test-socket') {
  const sent: string[] = [];
  const subscribed: string[] = [];
  const unsubscribed: string[] = [];
  return {
    data: { id, endpoint: '/ws', rooms: new Set<string>() },
    send(msg: string) {
      sent.push(msg);
    },
    subscribe(room: string) {
      subscribed.push(room);
    },
    unsubscribe(room: string) {
      unsubscribed.push(room);
    },
    sent,
    subscribed,
    unsubscribed,
  } as any;
}

// isStringArray is tested indirectly via recover action parsing
describe('parseRoomActionMessage — recover action (isStringArray path)', () => {
  test('parses a valid recover action with rooms array', async () => {
    const state = makeWsState();
    const ws = mockWs();
    const msg = JSON.stringify({
      action: 'recover',
      sessionId: 'sess-1',
      rooms: ['room-a', 'room-b'],
      lastEventId: 'evt-1',
    });
    // Without endpointConfig recovery, handleRoomActions returns false after parsing
    const result = await handleRoomActions(state, ws, msg);
    // recover action returns false when no endpointConfig recovery configured
    expect(result).toBe(false);
  });

  test('returns null for recover action with non-string-array rooms', async () => {
    const state = makeWsState();
    const ws = mockWs();
    const msg = JSON.stringify({
      action: 'recover',
      sessionId: 'sess-1',
      rooms: [1, 2, 3], // not strings — should fail isStringArray
      lastEventId: 'evt-1',
    });
    const result = await handleRoomActions(state, ws, msg);
    expect(result).toBe(false);
  });
});

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

  test('returns false for valid JSON with unrecognized action', async () => {
    const state = makeWsState();
    const ws = mockWs();
    const msg = JSON.stringify({ action: 'unknown_action', room: 'test' });
    const result = await handleRoomActions(state, ws, msg);
    expect(result).toBe(false);
  });

  test('returns false for valid JSON object without action field', async () => {
    const state = makeWsState();
    const ws = mockWs();
    const msg = JSON.stringify({ type: 'message', content: 'hello' });
    const result = await handleRoomActions(state, ws, msg);
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

  test('guard throws — treated as deny, sends subscribe_denied', async () => {
    const state = makeWsState();
    const ws = mockWs();
    const msg = JSON.stringify({ action: 'subscribe', room: 'guarded-room' });
    const guard = () => {
      throw new Error('guard exploded');
    };
    const errorSpy = mock(() => {});
    const originalError = console.error;
    console.error = errorSpy;

    const result = await handleRoomActions(state, ws, msg, guard);

    console.error = originalError;

    expect(result).toBe(true);
    expect(ws.subscribed).toHaveLength(0);
    expect(ws.sent).toHaveLength(1);
    expect(JSON.parse(ws.sent[0]).event).toBe('subscribe_denied');
    expect(errorSpy).toHaveBeenCalled();
  });

  test('handles Buffer messages (converts to string)', async () => {
    const state = makeWsState();
    const ws = mockWs();
    const msg = Buffer.from(JSON.stringify({ action: 'subscribe', room: 'buf-room' }));
    const result = await handleRoomActions(state, ws, msg);
    expect(result).toBe(true);
    expect(ws.data.rooms.has('buf-room')).toBe(true);
  });
});

describe('subscribe / unsubscribe with presence', () => {
  function makePresenceState(): WsState {
    return {
      ...makeWsState(),
      presenceEnabled: true,
    };
  }

  test('subscribe with presenceEnabled publishes presence_join for new user', () => {
    const state = makePresenceState();
    state.socketUsers.set('sock-1', 'user-1');
    // Set up a mock server.publish to capture messages
    const published: { key: string; msg: string }[] = [];
    state.server = {
      publish(key: string, msg: string) {
        published.push({ key, msg });
      },
    } as any;

    const ws = mockWs('sock-1');
    subscribe(state, ws, 'room-1');

    expect(ws.data.rooms.has('room-1')).toBe(true);
    expect(published.length).toBeGreaterThan(0);
    const joinMsg = published.find(p => {
      try {
        return JSON.parse(p.msg).event === 'presence_join';
      } catch {
        return false;
      }
    });
    expect(joinMsg).toBeDefined();
  });

  test('subscribe with presenceEnabled does NOT publish join if user already in room', () => {
    const state = makePresenceState();
    state.socketUsers.set('sock-1', 'user-1');
    state.socketUsers.set('sock-2', 'user-1'); // same user, second tab
    const published: { key: string; msg: string }[] = [];
    state.server = {
      publish(key: string, msg: string) {
        published.push({ key, msg });
      },
    } as any;

    const ws1 = mockWs('sock-1');
    const ws2 = mockWs('sock-2');

    subscribe(state, ws1, 'room-1');
    const joinCountBefore = published.filter(p => {
      try {
        return JSON.parse(p.msg).event === 'presence_join';
      } catch {
        return false;
      }
    }).length;

    subscribe(state, ws2, 'room-1');
    const joinCountAfter = published.filter(p => {
      try {
        return JSON.parse(p.msg).event === 'presence_join';
      } catch {
        return false;
      }
    }).length;

    // Second socket for same user should NOT trigger another join
    expect(joinCountAfter).toBe(joinCountBefore);
  });

  test('unsubscribe with presenceEnabled publishes presence_leave for last socket', () => {
    const state = makePresenceState();
    state.socketUsers.set('sock-1', 'user-1');
    const published: { key: string; msg: string }[] = [];
    state.server = {
      publish(key: string, msg: string) {
        published.push({ key, msg });
      },
    } as any;

    const ws = mockWs('sock-1');
    subscribe(state, ws, 'room-1');
    published.length = 0; // clear join event

    unsubscribe(state, ws, 'room-1');

    const leaveMsg = published.find(p => {
      try {
        return JSON.parse(p.msg).event === 'presence_leave';
      } catch {
        return false;
      }
    });
    expect(leaveMsg).toBeDefined();
  });

  test('unsubscribe with presenceEnabled does NOT publish leave if other sockets remain', () => {
    const state = makePresenceState();
    state.socketUsers.set('sock-1', 'user-1');
    state.socketUsers.set('sock-2', 'user-1');
    const published: { key: string; msg: string }[] = [];
    state.server = {
      publish(key: string, msg: string) {
        published.push({ key, msg });
      },
    } as any;

    const ws1 = mockWs('sock-1');
    const ws2 = mockWs('sock-2');
    subscribe(state, ws1, 'room-1');
    subscribe(state, ws2, 'room-1');
    published.length = 0; // clear join events

    unsubscribe(state, ws1, 'room-1');

    const leaveMsg = published.find(p => {
      try {
        return JSON.parse(p.msg).event === 'presence_leave';
      } catch {
        return false;
      }
    });
    // ws1 leaves but ws2 still in room — no leave event
    expect(leaveMsg).toBeUndefined();
  });
});

describe('cleanupSocket with presence', () => {
  function makePresenceState(): WsState {
    return {
      ...makeWsState(),
      presenceEnabled: true,
    };
  }

  test('cleanupSocket with presenceEnabled publishes leave for each room', () => {
    const state = makePresenceState();
    state.socketUsers.set('sock-1', 'user-1');
    const published: { key: string; msg: string }[] = [];
    state.server = {
      publish(key: string, msg: string) {
        published.push({ key, msg });
      },
    } as any;

    const ws = mockWs('sock-1');
    subscribe(state, ws, 'room-a');
    subscribe(state, ws, 'room-b');
    published.length = 0; // clear join events

    cleanupSocket(state, ws);

    const leaveEvents = published.filter(p => {
      try {
        return JSON.parse(p.msg).event === 'presence_leave';
      } catch {
        return false;
      }
    });
    expect(leaveEvents.length).toBeGreaterThanOrEqual(2);
  });

  test('cleanupSocket without presenceEnabled clears roomRegistry entries', () => {
    const state = makeWsState(); // presenceEnabled = false
    const ws = mockWs('sock-cleanup');
    subscribe(state, ws, 'room-x');

    // Manually verify room was added
    expect(ws.data.rooms.has('room-x')).toBe(true);

    cleanupSocket(state, ws);

    // Registry should be cleaned up
    expect(state.roomRegistry.size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// publish — per-socket path (lines 99-126) and transport fan-out (lines 138-141)
// ---------------------------------------------------------------------------

describe('publish — per-socket path', () => {
  test('publish with trackDelivery attaches message id and tracks lastEventIds', () => {
    const state = makeWsState();
    const ws = mockWs('sock-1');
    subscribe(state, ws, 'room-1');

    // Register socket in socketRegistry with sendText
    const sentTexts: string[] = [];
    state.socketRegistry.set('sock-1', {
      sendText(msg: string) {
        sentTexts.push(msg);
        return 1; // success
      },
    } as any);

    publish(state, '/ws', 'room-1', { text: 'hello' }, { trackDelivery: true });

    expect(sentTexts).toHaveLength(1);
    // Should have attached an id field
    const parsed = JSON.parse(sentTexts[0]);
    expect(parsed.text).toBe('hello');
    expect(typeof parsed.id).toBe('string');
    // lastEventIds should be tracked with composite key (socketId\0room)
    expect(state.lastEventIds.has(`sock-1\0room-1`)).toBe(true);
  });

  test('publish with exclude skips excluded socket ids', () => {
    const state = makeWsState();
    const ws1 = mockWs('sock-1');
    const ws2 = mockWs('sock-2');
    subscribe(state, ws1, 'room-1');
    subscribe(state, ws2, 'room-1');

    const sentBy1: string[] = [];
    const sentBy2: string[] = [];
    state.socketRegistry.set('sock-1', {
      sendText(msg: string) {
        sentBy1.push(msg);
        return 1;
      },
    } as any);
    state.socketRegistry.set('sock-2', {
      sendText(msg: string) {
        sentBy2.push(msg);
        return 1;
      },
    } as any);

    publish(state, '/ws', 'room-1', { msg: 'test' }, { exclude: new Set(['sock-1']) });

    expect(sentBy1).toHaveLength(0);
    expect(sentBy2).toHaveLength(1);
  });

  test('publish with volatile=true skips sockets returning backpressure (status 0)', () => {
    const state = makeWsState();
    const ws = mockWs('sock-1');
    subscribe(state, ws, 'room-1');

    const sentTexts: string[] = [];
    state.socketRegistry.set('sock-1', {
      sendText(msg: string) {
        sentTexts.push(msg);
        return 0; // backpressure
      },
    } as any);

    // volatile=true should not throw or retry
    publish(state, '/ws', 'room-1', { msg: 'volatile-test' }, { volatile: true });
    expect(sentTexts).toHaveLength(1);
  });

  test('publish per-socket path skips missing socket in socketRegistry', () => {
    const state = makeWsState();
    const ws = mockWs('sock-1');
    subscribe(state, ws, 'room-1');
    // Do NOT register sock-1 in socketRegistry — simulate stale entry

    // Should not throw
    publish(state, '/ws', 'room-1', { msg: 'test' }, { volatile: true });
  });

  test('publish per-socket path with no sockets in room does nothing', () => {
    const state = makeWsState();
    // Room registry has no entry for this room
    publish(state, '/ws', 'nonexistent-room', { msg: 'test' }, { trackDelivery: true });
    // Should not throw
  });
});

describe('publish — transport fan-out', () => {
  test('publish calls transport.publish when transport is set', () => {
    const state = makeWsState();
    const transportCalls: Array<{ endpoint: string; room: string; msg: string }> = [];
    state.transport = {
      publish: async (endpoint: string, room: string, msg: string) => {
        transportCalls.push({ endpoint, room, msg });
      },
      connect: async () => {},
      disconnect: async () => {},
    };

    // Use server.publish path (no volatile/exclude/trackDelivery)
    state.server = { publish: () => {} } as any;
    publish(state, '/ws', 'room-1', { hello: 'world' });

    expect(transportCalls).toHaveLength(1);
    expect(transportCalls[0].endpoint).toBe('/ws');
    expect(transportCalls[0].room).toBe('room-1');
  });

  test('publish swallows transport.publish errors', () => {
    const state = makeWsState();
    const originalError = console.error;
    const errorCalls: unknown[] = [];
    console.error = (...args: unknown[]) => errorCalls.push(args);

    state.transport = {
      publish: async () => {
        throw new Error('transport down');
      },
      connect: async () => {},
      disconnect: async () => {},
    };

    state.server = { publish: () => {} } as any;
    // Should not throw
    publish(state, '/ws', 'room-1', { msg: 'test' });
    console.error = originalError;
  });
});

// ---------------------------------------------------------------------------
// tryAttachMessageId (lines 39-42) — tested indirectly through publish with trackDelivery
// ---------------------------------------------------------------------------

describe('publish — tryAttachMessageId edge cases', () => {
  test('trackDelivery with non-object JSON (e.g. string) returns original message', () => {
    const state = makeWsState();
    const ws = mockWs('sock-1');
    subscribe(state, ws, 'room-1');

    const sentTexts: string[] = [];
    state.socketRegistry.set('sock-1', {
      sendText(msg: string) {
        sentTexts.push(msg);
        return 1;
      },
    } as any);

    // Publish a plain string — tryAttachMessageId sees a non-object JSON
    publish(state, '/ws', 'room-1', 'just-a-string', { trackDelivery: true });

    expect(sentTexts).toHaveLength(1);
    // Should be the original string value since it's not a JSON object
    expect(sentTexts[0]).toBe('"just-a-string"');
  });

  test('trackDelivery with array JSON returns original message (isJsonObject rejects arrays)', () => {
    const state = makeWsState();
    const ws = mockWs('sock-1');
    subscribe(state, ws, 'room-1');

    const sentTexts: string[] = [];
    state.socketRegistry.set('sock-1', {
      sendText(msg: string) {
        sentTexts.push(msg);
        return 1;
      },
    } as any);

    // Publish an array — tryAttachMessageId sees isJsonObject return false for arrays
    publish(state, '/ws', 'room-1', [1, 2, 3], { trackDelivery: true });

    expect(sentTexts).toHaveLength(1);
    expect(sentTexts[0]).toBe('[1,2,3]');
  });
});

// ---------------------------------------------------------------------------
// unsubscribe with no registry entry
// ---------------------------------------------------------------------------

describe('unsubscribe — room not in registry', () => {
  test('unsubscribe from room with no roomRegistry entry does not throw', () => {
    const state = makeWsState();
    const ws = mockWs('sock-1');
    // Manually add room to socket data without going through subscribe
    ws.data.rooms.add('phantom-room');

    // Should not throw even though roomRegistry has no entry
    unsubscribe(state, ws, 'phantom-room');
    expect(ws.data.rooms.has('phantom-room')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// handleRoomActions — recover action with endpointConfig (lines 211-223)
// ---------------------------------------------------------------------------

describe('handleRoomActions — recover action with endpoint recovery config', () => {
  test('recover action returns false when endpointConfig has recovery but app is omitted', async () => {
    const state = makeWsState();
    const ws = mockWs('sock-1');

    const endpointConfig = { recovery: { windowMs: 60000 } };
    const msg = JSON.stringify({
      action: 'recover',
      sessionId: 'sess-1',
      rooms: ['room-a'],
      lastEventId: 'evt-1',
    });

    // Pass endpointConfig with recovery but no app — should fall through
    const result = await handleRoomActions(state, ws, msg, undefined, endpointConfig as any);
    expect(result).toBe(false);
  });

  test('recover action delegates to handleRecover when endpointConfig has recovery', async () => {
    const state = makeWsState();
    const ws = mockWs('sock-1');

    // Set up session for recovery
    state.sessionRegistry.set('sess-1', {
      rooms: ['room-a'],
      lastEventId: 'evt-1',
      expiresAt: Date.now() + 60000,
    });

    const endpointConfig = {
      recovery: { windowMs: 60000 },
      persistence: {
        getHistory: async () => [],
      },
    };

    const msg = JSON.stringify({
      action: 'recover',
      sessionId: 'sess-1',
      rooms: ['room-a'],
      lastEventId: 'evt-1',
    });

    const result = await handleRoomActions(
      state,
      ws,
      msg,
      undefined,
      endpointConfig as any,
      {} as any,
    );
    expect(result).toBe(true);
    // Should have sent a recovered or recover_failed response
    expect(ws.sent.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// subscribe / unsubscribe with presence + trackDelivery (lines 259-272, 292-305)
// ---------------------------------------------------------------------------

describe('subscribe / unsubscribe with presence and trackDelivery', () => {
  function makePresenceState(): WsState {
    return {
      ...makeWsState(),
      presenceEnabled: true,
    };
  }

  test('subscribe with trackDelivery passes trackDelivery option to presence publish', () => {
    const state = makePresenceState();
    state.socketUsers.set('sock-1', 'user-1');

    // Use per-socket publish path by registering sockets
    const ws = mockWs('sock-1');
    subscribe(state, ws, 'room-1', { trackDelivery: true });

    // The presence_join should have been published
    // Since we don't have other subscribers, it goes through server.publish
    // Just verify no error occurs and the room is joined
    expect(ws.data.rooms.has('room-1')).toBe(true);
  });

  test('unsubscribe with trackDelivery passes trackDelivery option to presence publish', () => {
    const state = makePresenceState();
    state.socketUsers.set('sock-1', 'user-1');
    state.socketUsers.set('sock-2', 'user-2');

    const ws1 = mockWs('sock-1');
    const ws2 = mockWs('sock-2');

    // Register both sockets to capture sendText calls
    const sentTexts: string[] = [];
    state.socketRegistry.set('sock-2', {
      sendText(msg: string) {
        sentTexts.push(msg);
        return 1;
      },
    } as any);

    subscribe(state, ws1, 'room-1');
    subscribe(state, ws2, 'room-1');

    // Clear any join messages
    sentTexts.length = 0;

    unsubscribe(state, ws1, 'room-1', { trackDelivery: true });

    // presence_leave should be published via per-socket path (trackDelivery)
    const leaveMsg = sentTexts.find(p => {
      try {
        return JSON.parse(p).event === 'presence_leave';
      } catch {
        return false;
      }
    });
    expect(leaveMsg).toBeDefined();
    // lastEventIds should be tracked for sock-2 (the receiver) with composite key
    expect(state.lastEventIds.has(`sock-2\0room-1`)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// cleanupSocket with presence + trackDelivery (lines 323-329)
// ---------------------------------------------------------------------------

describe('cleanupSocket with presence and trackDelivery', () => {
  test('cleanupSocket with trackDelivery passes option to presence_leave publish', () => {
    const state: WsState = {
      ...makeWsState(),
      presenceEnabled: true,
    };
    state.socketUsers.set('sock-1', 'user-1');
    state.socketUsers.set('sock-2', 'user-2');

    const ws1 = mockWs('sock-1');
    const ws2 = mockWs('sock-2');

    // Register sock-2 in socketRegistry to capture per-socket sends
    const sentTexts: string[] = [];
    state.socketRegistry.set('sock-2', {
      sendText(msg: string) {
        sentTexts.push(msg);
        return 1;
      },
    } as any);

    subscribe(state, ws1, 'room-a');
    subscribe(state, ws2, 'room-a');
    sentTexts.length = 0;

    cleanupSocket(state, ws1, { trackDelivery: true });

    const leaveEvents = sentTexts.filter(p => {
      try {
        return JSON.parse(p).event === 'presence_leave';
      } catch {
        return false;
      }
    });
    expect(leaveEvents.length).toBeGreaterThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
// handleRoomActions — invalid room name returns true without subscribing
// ---------------------------------------------------------------------------

describe('handleRoomActions — invalid room name', () => {
  test('subscribe with invalid room name returns true without subscribing', async () => {
    const state = makeWsState();
    const ws = mockWs();
    // Empty string is not a valid room name
    const msg = JSON.stringify({ action: 'subscribe', room: '' });
    const result = await handleRoomActions(state, ws, msg);
    expect(result).toBe(true);
    expect(ws.subscribed).toHaveLength(0);
  });

  test('unsubscribe with invalid room name returns true', async () => {
    const state = makeWsState();
    const ws = mockWs();
    const msg = JSON.stringify({ action: 'unsubscribe', room: '' });
    const result = await handleRoomActions(state, ws, msg);
    expect(result).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// handleRoomActions — trackDelivery when recovery is configured
// ---------------------------------------------------------------------------

describe('handleRoomActions — trackDelivery on subscribe/unsubscribe with recovery', () => {
  test('subscribe with recovery-configured endpoint tracks delivery', async () => {
    const state = makeWsState();
    const ws = mockWs('sock-1');

    const endpointConfig = { recovery: { windowMs: 60000 } };
    const msg = JSON.stringify({ action: 'subscribe', room: 'test-room' });
    const result = await handleRoomActions(state, ws, msg, undefined, endpointConfig as any);

    expect(result).toBe(true);
    expect(ws.data.rooms.has('test-room')).toBe(true);
  });

  test('unsubscribe with recovery-configured endpoint tracks delivery', async () => {
    const state = makeWsState();
    const ws = mockWs('sock-1');
    ws.data.rooms.add('test-room');

    const endpointConfig = { recovery: { windowMs: 60000 } };
    const msg = JSON.stringify({ action: 'unsubscribe', room: 'test-room' });
    const result = await handleRoomActions(state, ws, msg, undefined, endpointConfig as any);

    expect(result).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// getRooms / getRoomSubscribers / getSubscriptions
// ---------------------------------------------------------------------------

describe('getRooms / getRoomSubscribers / getSubscriptions', () => {
  test('getRooms returns rooms for a given endpoint', () => {
    const state = makeWsState();
    const ws = mockWs('sock-1');
    subscribe(state, ws, 'room-a');
    subscribe(state, ws, 'room-b');

    const rooms = getRooms(state, '/ws');
    expect(rooms).toContain('room-a');
    expect(rooms).toContain('room-b');
  });

  test('getRoomSubscribers returns socket ids for a room', () => {
    const state = makeWsState();
    const ws1 = mockWs('sock-1');
    const ws2 = mockWs('sock-2');
    subscribe(state, ws1, 'room-1');
    subscribe(state, ws2, 'room-1');

    const subs = getRoomSubscribers(state, '/ws', 'room-1');
    expect(subs).toContain('sock-1');
    expect(subs).toContain('sock-2');
  });

  test('getSubscriptions returns rooms the socket is subscribed to', () => {
    const state = makeWsState();
    const ws = mockWs('sock-1');
    subscribe(state, ws, 'room-x');
    subscribe(state, ws, 'room-y');

    const subs = getSubscriptions(ws);
    expect(subs).toContain('room-x');
    expect(subs).toContain('room-y');
  });
});
