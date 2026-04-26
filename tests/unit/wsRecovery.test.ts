import { afterAll, beforeEach, describe, expect, it, mock } from 'bun:test';
import type { WsState } from '@lastshotlabs/slingshot-core';

type RecoveryModule = typeof import('../../src/framework/ws/recovery');

const getMessageHistoryMock = mock(() => Promise.resolve([]));

async function loadRecoveryModule(): Promise<RecoveryModule> {
  const actualWsMessages = await import('../../src/framework/ws/messages');
  mock.module('../../src/framework/ws/messages', () => ({
    ...actualWsMessages,
    getMessageHistory: getMessageHistoryMock,
  }));

  return import(`../../src/framework/ws/recovery.ts?ws-recovery=${Date.now()}-${Math.random()}`);
}

afterAll(() => {
  mock.restore();
});

function createWsState(): WsState {
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

function createMockWs(id: string, endpoint = '/ws') {
  const sent: string[] = [];
  const subscribed: string[] = [];
  return {
    send(msg: string) {
      sent.push(msg);
    },
    subscribe(channel: string) {
      subscribed.push(channel);
    },
    data: {
      id,
      endpoint,
      rooms: new Set<string>(),
      actor: { id: null, kind: 'anonymous', tenantId: null, sessionId: null, roles: null, claims: {} },
      requestTenantId: null,
    },
    sent,
    subscribed,
  };
}

const fakeApp = {};

describe('wsRecovery', () => {
  let state: WsState;
  let handleRecover: RecoveryModule['handleRecover'];
  let pruneExpiredSessions: RecoveryModule['pruneExpiredSessions'];
  let writeSession: RecoveryModule['writeSession'];

  beforeEach(async () => {
    mock.restore();
    getMessageHistoryMock.mockReset();
    getMessageHistoryMock.mockResolvedValue([]);
    ({ handleRecover, pruneExpiredSessions, writeSession } = await loadRecoveryModule());
    state = createWsState();
  });

  describe('handleRecover', () => {
    it('valid sessionId + matching rooms — messages sent in order, recovered event', async () => {
      const messages = [
        {
          id: 'm1',
          endpoint: '/ws',
          room: 'room1',
          senderId: null,
          payload: { text: 'a' },
          createdAt: 1,
        },
        {
          id: 'm2',
          endpoint: '/ws',
          room: 'room1',
          senderId: null,
          payload: { text: 'b' },
          createdAt: 2,
        },
      ];
      getMessageHistoryMock.mockResolvedValue(messages);

      state.sessionRegistry.set('sess-1', {
        rooms: ['room1'],
        lastEventId: 'm0',
        expiresAt: Date.now() + 60_000,
      });

      const ws = createMockWs('s1');
      await handleRecover(
        state,
        ws as never,
        { sessionId: 'sess-1', rooms: ['room1'], lastEventId: 'm0' },
        { persistence: { store: 'memory' } },
        fakeApp,
      );

      // Messages sent in order + recovered event
      expect(ws.sent).toHaveLength(3);
      expect(JSON.parse(ws.sent[0])).toEqual({ text: 'a' });
      expect(JSON.parse(ws.sent[1])).toEqual({ text: 'b' });
      expect(JSON.parse(ws.sent[2])).toEqual({ event: 'recovered', replayed: 2 });
    });

    it('replayed count equals total message count across all rooms', async () => {
      const room1Msgs = [
        { id: 'm1', endpoint: '/ws', room: 'room1', senderId: null, payload: 1, createdAt: 1 },
      ];
      const room2Msgs = [
        { id: 'm2', endpoint: '/ws', room: 'room2', senderId: null, payload: 2, createdAt: 2 },
        { id: 'm3', endpoint: '/ws', room: 'room2', senderId: null, payload: 3, createdAt: 3 },
      ];
      getMessageHistoryMock.mockResolvedValueOnce(room1Msgs).mockResolvedValueOnce(room2Msgs);

      state.sessionRegistry.set('sess-2', {
        rooms: ['room1', 'room2'],
        lastEventId: 'm0',
        expiresAt: Date.now() + 60_000,
      });

      const ws = createMockWs('s1');
      await handleRecover(
        state,
        ws as never,
        { sessionId: 'sess-2', rooms: ['room1', 'room2'], lastEventId: 'm0' },
        { persistence: { store: 'memory' } },
        fakeApp,
      );

      const recovered = JSON.parse(ws.sent[ws.sent.length - 1]);
      expect(recovered).toEqual({ event: 'recovered', replayed: 3 });
    });

    it('session expired — recover_failed with session_expired', async () => {
      state.sessionRegistry.set('sess-exp', {
        rooms: ['room1'],
        lastEventId: 'm0',
        expiresAt: Date.now() - 1000, // expired
      });

      const ws = createMockWs('s1');
      await handleRecover(
        state,
        ws as never,
        { sessionId: 'sess-exp', rooms: ['room1'], lastEventId: 'm0' },
        { persistence: { store: 'memory' } },
        fakeApp,
      );

      expect(ws.sent).toHaveLength(1);
      expect(JSON.parse(ws.sent[0])).toEqual({
        event: 'recover_failed',
        reason: 'session_expired',
      });
    });

    it('unknown sessionId — same as expired', async () => {
      const ws = createMockWs('s1');
      await handleRecover(
        state,
        ws as never,
        { sessionId: 'nonexistent', rooms: ['room1'], lastEventId: 'm0' },
        { persistence: { store: 'memory' } },
        fakeApp,
      );

      expect(JSON.parse(ws.sent[0])).toEqual({
        event: 'recover_failed',
        reason: 'session_expired',
      });
    });

    it('rooms mismatch — recover_failed with rooms_changed', async () => {
      state.sessionRegistry.set('sess-rooms', {
        rooms: ['room1', 'room2'],
        lastEventId: 'm0',
        expiresAt: Date.now() + 60_000,
      });

      const ws = createMockWs('s1');
      await handleRecover(
        state,
        ws as never,
        { sessionId: 'sess-rooms', rooms: ['room1', 'room3'], lastEventId: 'm0' },
        { persistence: { store: 'memory' } },
        fakeApp,
      );

      expect(JSON.parse(ws.sent[0])).toEqual({
        event: 'recover_failed',
        reason: 'rooms_changed',
      });
    });

    it('rooms same-set, different order — treated as matching', async () => {
      getMessageHistoryMock.mockResolvedValue([]);

      state.sessionRegistry.set('sess-order', {
        rooms: ['room1', 'room2'],
        lastEventId: 'm0',
        expiresAt: Date.now() + 60_000,
      });

      const ws = createMockWs('s1');
      await handleRecover(
        state,
        ws as never,
        { sessionId: 'sess-order', rooms: ['room2', 'room1'], lastEventId: 'm0' },
        { persistence: { store: 'memory' } },
        fakeApp,
      );

      // Should succeed, not rooms_changed
      expect(JSON.parse(ws.sent[ws.sent.length - 1])).toEqual({
        event: 'recovered',
        replayed: 0,
      });
    });

    it('persistence unavailable — recover_failed', async () => {
      state.sessionRegistry.set('sess-nop', {
        rooms: ['room1'],
        lastEventId: 'm0',
        expiresAt: Date.now() + 60_000,
      });

      const ws = createMockWs('s1');
      await handleRecover(
        state,
        ws as never,
        { sessionId: 'sess-nop', rooms: ['room1'], lastEventId: 'm0' },
        {}, // no persistence
        fakeApp,
      );

      expect(JSON.parse(ws.sent[0])).toEqual({
        event: 'recover_failed',
        reason: 'persistence_unavailable',
      });
    });

    it('session consumed — deleted after success, second recover fails', async () => {
      getMessageHistoryMock.mockResolvedValue([]);

      state.sessionRegistry.set('sess-once', {
        rooms: ['room1'],
        lastEventId: 'm0',
        expiresAt: Date.now() + 60_000,
      });

      const ws = createMockWs('s1');
      await handleRecover(
        state,
        ws as never,
        { sessionId: 'sess-once', rooms: ['room1'], lastEventId: 'm0' },
        { persistence: { store: 'memory' } },
        fakeApp,
      );

      expect(state.sessionRegistry.has('sess-once')).toBe(false);

      // Second attempt should fail
      const ws2 = createMockWs('s2');
      await handleRecover(
        state,
        ws2 as never,
        { sessionId: 'sess-once', rooms: ['room1'], lastEventId: 'm0' },
        { persistence: { store: 'memory' } },
        fakeApp,
      );

      expect(JSON.parse(ws2.sent[0])).toEqual({
        event: 'recover_failed',
        reason: 'session_expired',
      });
    });
  });

  describe('writeSession', () => {
    it('creates a session entry with correct fields', () => {
      state.lastEventIds.set('s1', 'm5');
      writeSession(state, 's1', 'sess-new', new Set(['room1', 'room2']), 120_000);

      expect(state.sessionRegistry.size).toBe(1);
      const entry = state.sessionRegistry.get('sess-new')!;
      expect(entry.rooms.sort()).toEqual(['room1', 'room2']);
      expect(entry.lastEventId).toBe('m5');
      expect(entry.expiresAt).toBeGreaterThan(Date.now());
    });

    it('defaults lastEventId to empty string when no tracking', () => {
      writeSession(state, 's1', 'sess-empty', new Set(['room1']), 60_000);
      expect(state.sessionRegistry.get('sess-empty')!.lastEventId).toBe('');
    });
  });

  it('getMessageHistory throws — sends recover_failed with history_unavailable (lines 64,67-68)', async () => {
    getMessageHistoryMock.mockRejectedValue(new Error('db error'));

    state.sessionRegistry.set('sess-err', {
      rooms: ['room1'],
      lastEventId: 'm0',
      expiresAt: Date.now() + 60_000,
    });

    const errorSpy = mock(() => {});
    const originalError = console.error;
    console.error = errorSpy;

    const ws = createMockWs('s1');
    try {
      await handleRecover(
        state,
        ws as never,
        { sessionId: 'sess-err', rooms: ['room1'], lastEventId: 'm0' },
        { persistence: { store: 'memory' } },
        fakeApp,
      );
    } finally {
      console.error = originalError;
    }

    expect(errorSpy).toHaveBeenCalled();
    expect(ws.sent).toHaveLength(1);
    expect(JSON.parse(ws.sent[0])).toEqual({
      event: 'recover_failed',
      reason: 'history_unavailable',
      room: 'room1',
    });
  });

  describe('pruneExpiredSessions', () => {
    it('removes entries with expiresAt < now, keeps valid ones', () => {
      state.sessionRegistry.set('expired-1', {
        rooms: [],
        lastEventId: '',
        expiresAt: Date.now() - 1000,
      });
      state.sessionRegistry.set('valid-1', {
        rooms: [],
        lastEventId: '',
        expiresAt: Date.now() + 60_000,
      });
      state.sessionRegistry.set('expired-2', {
        rooms: [],
        lastEventId: '',
        expiresAt: Date.now() - 500,
      });

      pruneExpiredSessions(state);

      expect(state.sessionRegistry.size).toBe(1);
      expect(state.sessionRegistry.has('valid-1')).toBe(true);
    });
  });
});
