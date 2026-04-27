/**
 * Unit tests for wireChannelForwarding() — bus-to-WS-room event forwarding.
 *
 * Validates room name construction, idField extraction, multi-channel routing,
 * and cleanup via the unsubscribe function.
 */
import { describe, expect, it, mock } from 'bun:test';
import type {
  EntityChannelConfig,
  ResolvedEntityConfig,
  SlingshotEventBus,
  WsState,
} from '@lastshotlabs/slingshot-core';
import { wireChannelForwarding } from '../../packages/slingshot-entity/src/channels/applyChannelConfig';
import type { WsPublishFn } from '../../packages/slingshot-entity/src/channels/applyChannelConfig';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeEntityConfig(overrides: Partial<ResolvedEntityConfig> = {}): ResolvedEntityConfig {
  return {
    name: 'Thread',
    fields: {
      id: { type: 'string', primary: true, immutable: true, optional: false, default: 'uuid' },
      title: { type: 'string', primary: false, immutable: false, optional: false },
    },
    _pkField: 'id',
    _storageName: 'threads',
    ...overrides,
  } as unknown as ResolvedEntityConfig;
}

function makeMockWsState(): WsState {
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

type MockBus = {
  handlers: Map<string, Array<(payload: Record<string, unknown>) => void>>;
  on: ReturnType<typeof mock>;
  off: ReturnType<typeof mock>;
};

function makeMockBus(): SlingshotEventBus & MockBus {
  const handlers = new Map<string, Array<(payload: Record<string, unknown>) => void>>();

  return {
    handlers,
    emit: mock(() => {}) as unknown as SlingshotEventBus['emit'],
    on: mock((event: string, handler: (payload: Record<string, unknown>) => void) => {
      if (!handlers.has(event)) handlers.set(event, []);
      handlers.get(event)!.push(handler);
    }),
    off: mock((event: string, handler: (payload: Record<string, unknown>) => void) => {
      const list = handlers.get(event);
      if (list) {
        const idx = list.indexOf(handler);
        if (idx !== -1) list.splice(idx, 1);
      }
    }),
  } as unknown as SlingshotEventBus & MockBus;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('wireChannelForwarding', () => {
  it('publishes to correct room when bus event fires', () => {
    const entity = makeEntityConfig();
    const wsState = makeMockWsState();
    const bus = makeMockBus();
    const publishFn = mock(() => {}) as unknown as WsPublishFn;

    const channelConfig: EntityChannelConfig = {
      channels: {
        updates: {
          forward: { events: ['entity:threads.updated'] },
        },
      },
    };

    wireChannelForwarding(channelConfig, entity, () => wsState, bus, 'entities', publishFn);

    // Simulate bus event
    const handlers = bus.handlers.get('entity:threads.updated');
    expect(handlers).toBeDefined();
    expect(handlers!.length).toBe(1);

    handlers![0]({ id: 'abc123', title: 'Updated Title' });

    expect(publishFn).toHaveBeenCalledWith(wsState, 'entities', 'threads:abc123:updates', {
      id: 'abc123',
      title: 'Updated Title',
    });
  });

  it('uses correct room format: {storageName}:{entityId}:{channelName}', () => {
    const entity = makeEntityConfig({ _storageName: 'containers' });
    const wsState = makeMockWsState();
    const bus = makeMockBus();
    const publishFn = mock(() => {}) as unknown as WsPublishFn;

    const channelConfig: EntityChannelConfig = {
      channels: {
        activity: {
          forward: { events: ['entity:containers.updated'] },
        },
      },
    };

    wireChannelForwarding(channelConfig, entity, () => wsState, bus, 'entities', publishFn);

    bus.handlers.get('entity:containers.updated')![0]({ id: 'xyz789' });

    expect(publishFn).toHaveBeenCalledWith(wsState, 'entities', 'containers:xyz789:activity', {
      id: 'xyz789',
    });
  });

  it('uses custom idField from ChannelForwardConfig', () => {
    const entity = makeEntityConfig();
    const wsState = makeMockWsState();
    const bus = makeMockBus();
    const publishFn = mock(() => {}) as unknown as WsPublishFn;

    const channelConfig: EntityChannelConfig = {
      channels: {
        updates: {
          forward: {
            events: ['entity:replies.created'],
            idField: 'threadId',
          },
        },
      },
    };

    wireChannelForwarding(channelConfig, entity, () => wsState, bus, 'entities', publishFn);

    bus.handlers.get('entity:replies.created')![0]({
      replyId: 'reply-1',
      threadId: 'thread-99',
    });

    expect(publishFn).toHaveBeenCalledWith(wsState, 'entities', 'threads:thread-99:updates', {
      replyId: 'reply-1',
      threadId: 'thread-99',
    });
  });

  it('handles multiple channels each receiving their own declared events', () => {
    const entity = makeEntityConfig();
    const wsState = makeMockWsState();
    const bus = makeMockBus();
    const publishFn = mock(() => {}) as unknown as WsPublishFn;

    const channelConfig: EntityChannelConfig = {
      channels: {
        updates: {
          forward: { events: ['entity:threads.updated'] },
        },
        activity: {
          forward: { events: ['entity:replies.created'] },
        },
      },
    };

    wireChannelForwarding(channelConfig, entity, () => wsState, bus, 'entities', publishFn);

    // Fire updates event
    bus.handlers.get('entity:threads.updated')![0]({ id: 'thread-1' });
    expect(publishFn).toHaveBeenCalledWith(wsState, 'entities', 'threads:thread-1:updates', {
      id: 'thread-1',
    });

    // Fire activity event
    bus.handlers.get('entity:replies.created')![0]({ id: 'thread-2' });
    expect(publishFn).toHaveBeenCalledWith(wsState, 'entities', 'threads:thread-2:activity', {
      id: 'thread-2',
    });
  });

  it('unsubscribe function removes all bus listeners', () => {
    const entity = makeEntityConfig();
    const wsState = makeMockWsState();
    const bus = makeMockBus();
    const publishFn = mock(() => {}) as unknown as WsPublishFn;

    const channelConfig: EntityChannelConfig = {
      channels: {
        updates: {
          forward: { events: ['entity:threads.updated', 'entity:threads.created'] },
        },
      },
    };

    const unsub = wireChannelForwarding(
      channelConfig,
      entity,
      () => wsState,
      bus,
      'entities',
      publishFn,
    );

    expect(bus.handlers.get('entity:threads.updated')!.length).toBe(1);
    expect(bus.handlers.get('entity:threads.created')!.length).toBe(1);

    unsub();

    expect(bus.handlers.get('entity:threads.updated')!.length).toBe(0);
    expect(bus.handlers.get('entity:threads.created')!.length).toBe(0);
  });

  it('does not publish when entity ID is missing from payload', () => {
    const entity = makeEntityConfig();
    const wsState = makeMockWsState();
    const bus = makeMockBus();
    const publishFn = mock(() => {}) as unknown as WsPublishFn;

    const channelConfig: EntityChannelConfig = {
      channels: {
        updates: {
          forward: { events: ['entity:threads.updated'] },
        },
      },
    };

    wireChannelForwarding(channelConfig, entity, () => wsState, bus, 'entities', publishFn);

    // Fire event without 'id' field
    bus.handlers.get('entity:threads.updated')![0]({ title: 'no id here' });

    expect(publishFn).not.toHaveBeenCalled();
  });

  it('skips channels without forward config', () => {
    const entity = makeEntityConfig();
    const wsState = makeMockWsState();
    const bus = makeMockBus();
    const publishFn = mock(() => {}) as unknown as WsPublishFn;

    const channelConfig: EntityChannelConfig = {
      channels: {
        noForward: {
          auth: 'userAuth',
          // No forward config
        },
        withForward: {
          forward: { events: ['entity:threads.updated'] },
        },
      },
    };

    wireChannelForwarding(channelConfig, entity, () => wsState, bus, 'entities', publishFn);

    // Only one event should be subscribed
    expect(bus.on).toHaveBeenCalledTimes(1);
  });
});
