/**
 * Failure mode tests — verifies error isolation and recovery in critical
 * framework seams that previously had no test coverage.
 *
 * Covers:
 * - Event bus listener isolation
 * - SSE stream write failure after client disconnect
 * - WebSocket room cleanup after unclean disconnect
 * - Concurrent MFA challenge consumption
 * - Plugin setupMiddleware throwing halts startup
 */
// ---------------------------------------------------------------------------
// 4. Concurrent MFA challenge consumption
// ---------------------------------------------------------------------------
import {
  createMemoryMfaChallengeRepository,
  createSqliteMfaChallengeRepository,
} from '@auth/lib/mfaChallenge';
import type { MfaChallengeRepository } from '@auth/lib/mfaChallenge';
import { Database } from 'bun:sqlite';
import { beforeEach, describe, expect, spyOn, test } from 'bun:test';
// ---------------------------------------------------------------------------
// 1. Event bus — listener error isolation
// ---------------------------------------------------------------------------

import { ANONYMOUS_ACTOR, createInProcessAdapter } from '@lastshotlabs/slingshot-core';
import type { Actor, WsState } from '@lastshotlabs/slingshot-core';
import type { SlingshotPlugin } from '@lastshotlabs/slingshot-core';
// ---------------------------------------------------------------------------
// 5. Plugin setupMiddleware throwing halts startup
// ---------------------------------------------------------------------------

import {
  runPluginMiddleware,
  validateAndSortPlugins,
} from '../../src/framework/runPluginLifecycle';
// ---------------------------------------------------------------------------
// 2. SSE registry — stream write after disconnect
// ---------------------------------------------------------------------------

import { createSseRegistry } from '../../src/framework/sse/index';
import type { SseClientData } from '../../src/framework/sse/index';
// ---------------------------------------------------------------------------
// 3. WebSocket room cleanup — unclean disconnect
// ---------------------------------------------------------------------------

import { cleanupSocket, getRoomSubscribers, subscribe } from '../../src/framework/ws/rooms';

describe('event bus — listener error isolation', () => {
  let bus: ReturnType<typeof createInProcessAdapter>;
  let consoleSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    bus = createInProcessAdapter();
    consoleSpy = spyOn(console, 'error').mockImplementation(() => {});
  });

  test('sync throw is caught and logged — caller does not see the error', () => {
    bus.on('auth:login.success' as any, () => {
      throw new Error('sync boom');
    });

    expect(() => bus.emit('auth:login.success' as any, {} as any)).not.toThrow();
    expect(consoleSpy).toHaveBeenCalled();

    consoleSpy.mockRestore();
  });

  test('sync throw is isolated — subsequent listeners still execute', () => {
    const calls: string[] = [];

    bus.on('auth:login.success' as any, () => {
      calls.push('first');
      throw new Error('first exploded');
    });
    bus.on('auth:login.success' as any, () => {
      calls.push('second');
    });

    bus.emit('auth:login.success' as any, {} as any);

    expect(calls).toEqual(['first', 'second']);

    consoleSpy.mockRestore();
  });

  test('async listener rejection is isolated — other listeners still execute', async () => {
    const calls: string[] = [];

    bus.on('auth:login.success' as any, async () => {
      calls.push('async-first');
      throw new Error('async boom');
    });
    bus.on('auth:login.success' as any, async () => {
      calls.push('async-second');
    });

    bus.emit('auth:login.success' as any, {} as any);
    await new Promise(r => setTimeout(r, 10));

    // Async errors are caught by Promise.resolve().catch() — all listeners run
    expect(calls).toEqual(['async-first', 'async-second']);

    consoleSpy.mockRestore();
  });

  test('async listener rejection is logged with event name', async () => {
    bus.on('auth:login.success' as any, async () => {
      throw new Error('kaboom');
    });

    bus.emit('auth:login.success' as any, {} as any);
    await new Promise(r => setTimeout(r, 10));

    expect(consoleSpy).toHaveBeenCalled();
    const loggedMessage = consoleSpy.mock.calls[0][0] as string;
    expect(loggedMessage).toContain('auth:login.success');

    consoleSpy.mockRestore();
  });
});

describe('SSE registry — failure modes', () => {
  test('fanout continues for remaining clients after one disconnects', async () => {
    const registry = createSseRegistry();

    // Connect two clients
    const clientA: SseClientData<object> = {
      id: 'a',
      actor: { ...ANONYMOUS_ACTOR, id: 'u1', kind: 'user' as const } satisfies Actor,
      requestTenantId: null,
      endpoint: '/feed',
    };
    const clientB: SseClientData<object> = {
      id: 'b',
      actor: { ...ANONYMOUS_ACTOR, id: 'u2', kind: 'user' as const } satisfies Actor,
      requestTenantId: null,
      endpoint: '/feed',
    };

    const streamA = registry.createClientStream('/feed', clientA, false);
    const streamB = registry.createClientStream('/feed', clientB, false);

    // Start reading both streams
    const readerA = streamA.getReader();
    const readerB = streamB.getReader();

    // Read initial ": connected\n\n" from both
    await readerA.read();
    await readerB.read();

    // Disconnect client A
    await readerA.cancel();

    // Fanout should still deliver to client B without throwing
    registry.fanout('/feed', 'community:thread.created' as any, { msg: 'hello' }, undefined);

    const result = await readerB.read();
    const text = new TextDecoder().decode(result.value);
    expect(text).toContain('community:thread.created');
    expect(text).toContain('hello');

    await readerB.cancel();
  });

  test('fanout with throwing filter logs error and continues for other clients', async () => {
    const consoleSpy = spyOn(console, 'error').mockImplementation(() => {});
    const registry = createSseRegistry();

    const clientA: SseClientData<object> = {
      id: 'a',
      actor: { ...ANONYMOUS_ACTOR, id: 'u1', kind: 'user' as const } satisfies Actor,
      requestTenantId: null,
      endpoint: '/feed',
    };
    const clientB: SseClientData<object> = {
      id: 'b',
      actor: { ...ANONYMOUS_ACTOR, id: 'u2', kind: 'user' as const } satisfies Actor,
      requestTenantId: null,
      endpoint: '/feed',
    };

    const streamA = registry.createClientStream('/feed', clientA, false);
    const streamB = registry.createClientStream('/feed', clientB, false);

    const readerA = streamA.getReader();
    const readerB = streamB.getReader();
    await readerA.read();
    await readerB.read();

    // Filter that throws for client A, allows client B
    const brokenFilter = async (client: SseClientData<object>) => {
      if (client.id === 'a') throw new Error('permission check failed');
      return true;
    };

    registry.fanout('/feed', 'community:thread.created' as any, { data: 1 }, brokenFilter);

    // Wait for async filter promises to settle
    await new Promise(r => setTimeout(r, 20));

    // Client B should still receive the event
    const result = await Promise.race([
      readerB.read(),
      new Promise<{ done: true; value: undefined }>(r =>
        setTimeout(() => r({ done: true, value: undefined }), 500),
      ),
    ]);
    expect(result.done).toBe(false);

    // Error should be logged with [sse] prefix
    const sseErrors = consoleSpy.mock.calls.filter(
      args => typeof args[0] === 'string' && args[0].includes('[sse]'),
    );
    expect(sseErrors.length).toBeGreaterThanOrEqual(1);

    await readerA.cancel();
    await readerB.cancel();
    consoleSpy.mockRestore();
  });

  test('closeAll is idempotent — double close does not throw', () => {
    const registry = createSseRegistry();
    const client: SseClientData<object> = {
      id: 'x',
      actor: ANONYMOUS_ACTOR,
      requestTenantId: null,
      endpoint: '/feed',
    };
    registry.createClientStream('/feed', client, false);

    expect(() => {
      registry.closeAll();
      registry.closeAll();
    }).not.toThrow();
  });

  test('fanout after closeAll is a no-op', () => {
    const registry = createSseRegistry();
    const client: SseClientData<object> = {
      id: 'x',
      actor: ANONYMOUS_ACTOR,
      requestTenantId: null,
      endpoint: '/feed',
    };
    registry.createClientStream('/feed', client, false);
    registry.closeAll();

    // Should not throw
    expect(() => {
      registry.fanout('/feed', 'community:thread.created' as any, {}, undefined);
    }).not.toThrow();
  });
});

function makeWsState(overrides?: Partial<WsState>): WsState {
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

function makeFakeSocket(id: string, endpoint: string) {
  const subscriptions = new Set<string>();
  return {
    data: { id, endpoint, rooms: new Set<string>() },
    subscribe: (key: string) => subscriptions.add(key),
    unsubscribe: (key: string) => subscriptions.delete(key),
    send: () => {},
    _subscriptions: subscriptions,
  } as any;
}

describe('WebSocket room cleanup — unclean disconnect', () => {
  test('cleanupSocket removes socket from all rooms', () => {
    const state = makeWsState();
    const ws = makeFakeSocket('sock1', '/ws/chat');

    subscribe(state, ws, 'room-a');
    subscribe(state, ws, 'room-b');

    expect(getRoomSubscribers(state, '/ws/chat', 'room-a')).toContain('sock1');
    expect(getRoomSubscribers(state, '/ws/chat', 'room-b')).toContain('sock1');

    cleanupSocket(state, ws);

    expect(getRoomSubscribers(state, '/ws/chat', 'room-a')).toEqual([]);
    expect(getRoomSubscribers(state, '/ws/chat', 'room-b')).toEqual([]);
  });

  test('cleanupSocket handles already-removed room entries gracefully', () => {
    const state = makeWsState();
    const ws = makeFakeSocket('sock1', '/ws/chat');

    subscribe(state, ws, 'room-a');

    // Manually remove the registry entry to simulate a race condition
    state.roomRegistry.clear();

    // cleanupSocket should not throw even though the registry is empty
    expect(() => cleanupSocket(state, ws)).not.toThrow();
  });

  test('concurrent disconnect of two sockets in same room leaves clean state', () => {
    const state = makeWsState();
    const ws1 = makeFakeSocket('sock1', '/ws/chat');
    const ws2 = makeFakeSocket('sock2', '/ws/chat');

    subscribe(state, ws1, 'shared-room');
    subscribe(state, ws2, 'shared-room');

    expect(getRoomSubscribers(state, '/ws/chat', 'shared-room')).toHaveLength(2);

    // Both disconnect "simultaneously"
    cleanupSocket(state, ws1);
    cleanupSocket(state, ws2);

    // Room entry should be completely removed (not just empty Set)
    expect(getRoomSubscribers(state, '/ws/chat', 'shared-room')).toEqual([]);
    expect(state.roomRegistry.size).toBe(0);
  });

  test('cleanupSocket with empty rooms set is a no-op', () => {
    const state = makeWsState();
    const ws = makeFakeSocket('sock1', '/ws/chat');
    // ws.data.rooms is empty — never subscribed to anything

    expect(() => cleanupSocket(state, ws)).not.toThrow();
    expect(state.roomRegistry.size).toBe(0);
  });
});

function makeChallengeRecord() {
  return {
    userId: 'user-1',
    purpose: 'login' as const,
    emailOtpHash: 'otp-hash',
    createdAt: Date.now(),
    resendCount: 0,
  };
}

describe('concurrent MFA challenge — memory', () => {
  let repo: MfaChallengeRepository;

  beforeEach(() => {
    repo = createMemoryMfaChallengeRepository();
  });

  test('second consume of same challenge returns null', async () => {
    await repo.createChallenge('token-1', makeChallengeRecord(), 300);

    const first = await repo.consumeChallenge('token-1');
    const second = await repo.consumeChallenge('token-1');

    expect(first).not.toBeNull();
    expect(first!.userId).toBe('user-1');
    expect(second).toBeNull();
  });

  test('consuming expired challenge returns null', async () => {
    const record = makeChallengeRecord();
    await repo.createChallenge('token-exp', record, 0); // 0 second TTL — already expired

    // Small delay to ensure expiry
    await new Promise(r => setTimeout(r, 5));
    const result = await repo.consumeChallenge('token-exp');
    expect(result).toBeNull();
  });

  test('replaceOtp respects resend limit', async () => {
    await repo.createChallenge('token-r', makeChallengeRecord(), 300);

    // Exhaust all resends
    for (let i = 0; i < 3; i++) {
      const result = await repo.replaceOtp('token-r', `new-hash-${i}`, 300, 3);
      expect(result).not.toBeNull();
    }

    // Next resend should fail
    const result = await repo.replaceOtp('token-r', 'too-many', 300, 3);
    expect(result).toBeNull();
  });
});

describe('concurrent MFA challenge — sqlite', () => {
  let repo: MfaChallengeRepository;

  beforeEach(() => {
    const db = new Database(':memory:');
    repo = createSqliteMfaChallengeRepository(db);
  });

  test('second consume of same challenge returns null (atomic DELETE...RETURNING)', async () => {
    await repo.createChallenge('token-1', makeChallengeRecord(), 300);

    const first = await repo.consumeChallenge('token-1');
    const second = await repo.consumeChallenge('token-1');

    expect(first).not.toBeNull();
    expect(first!.userId).toBe('user-1');
    expect(second).toBeNull();
  });

  test('concurrent consume — exactly one succeeds', async () => {
    await repo.createChallenge('race-token', makeChallengeRecord(), 300);

    // SQLite is single-writer, but the DELETE...RETURNING guarantees atomicity
    const [a, b] = await Promise.all([
      repo.consumeChallenge('race-token'),
      repo.consumeChallenge('race-token'),
    ]);

    const successes = [a, b].filter(r => r !== null);
    expect(successes).toHaveLength(1);
    expect(successes[0]!.userId).toBe('user-1');
  });

  test('replaceOtp respects resend limit', async () => {
    await repo.createChallenge('token-r', makeChallengeRecord(), 300);

    for (let i = 0; i < 3; i++) {
      const result = await repo.replaceOtp('token-r', `new-hash-${i}`, 300, 3);
      expect(result).not.toBeNull();
    }

    const result = await repo.replaceOtp('token-r', 'too-many', 300, 3);
    expect(result).toBeNull();
  });
});

describe('plugin setupMiddleware — failure halts startup', () => {
  test('throwing plugin prevents subsequent plugins from running', async () => {
    const calls: string[] = [];

    const pluginA: SlingshotPlugin = {
      name: 'plugin-a',
      setupMiddleware: async () => {
        calls.push('a');
        throw new Error('plugin-a exploded');
      },
    };

    const pluginB: SlingshotPlugin = {
      name: 'plugin-b',
      setupMiddleware: async () => {
        calls.push('b');
      },
    };

    const sorted = validateAndSortPlugins([pluginA, pluginB]);

    await expect(runPluginMiddleware(sorted, {} as any, {} as any, {} as any)).rejects.toThrow(
      'plugin-a exploded',
    );

    // Plugin B should never have run
    expect(calls).toEqual(['a']);
  });

  test('error propagates from runPluginMiddleware — no silent swallowing', async () => {
    const plugin: SlingshotPlugin = {
      name: 'bad-plugin',
      setupMiddleware: async () => {
        throw new Error('setup failed');
      },
    };

    const sorted = validateAndSortPlugins([plugin]);

    await expect(runPluginMiddleware(sorted, {} as any, {} as any, {} as any)).rejects.toThrow(
      'setup failed',
    );
  });

  test('plugins with only setup() are excluded from framework lifecycle', () => {
    const spy = spyOn(console, 'info').mockImplementation(() => {});

    const standalonePlugin: SlingshotPlugin = {
      name: 'standalone',
      setup: async () => {},
    };

    const sorted = validateAndSortPlugins([standalonePlugin]);
    expect(sorted).toHaveLength(0);

    spy.mockRestore();
  });
});
