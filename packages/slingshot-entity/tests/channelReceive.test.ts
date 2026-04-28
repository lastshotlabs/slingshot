/**
 * Unit tests for buildEntityReceiveHandlers() and EntityPlugin.buildReceiveIncoming().
 *
 * Validates:
 * - handler map generation from channel receive config
 * - payload validation (room presence, room name validity, membership)
 * - whitelist enforcement
 * - room storageName and channelName matching
 * - broadcast behavior (toRoom, excludeSender)
 * - null WsState guard
 * - buildReceiveIncoming() merges per-entity declarations
 */
import { describe, expect, it, mock } from 'bun:test';
import type {
  ChannelIncomingEventDeclaration,
  EntityChannelConfig,
  ResolvedEntityConfig,
  WsState,
} from '@lastshotlabs/slingshot-core';
import { ANONYMOUS_ACTOR } from '@lastshotlabs/slingshot-core';
import { buildEntityReceiveHandlers } from '../src/channels/applyChannelConfig';
import type { WsPublishFn } from '../src/channels/applyChannelConfig';
import { createEntityPlugin } from '../src/createEntityPlugin';
import type { EntityPluginEntry } from '../src/createEntityPlugin';
import type { BareEntityAdapter } from '../src/routing/buildBareEntityRoutes';

function asResolvedConfig(config: Record<string, unknown>): ResolvedEntityConfig {
  return {
    _systemFields: {
      createdBy: 'createdBy',
      updatedBy: 'updatedBy',
      ownerField: 'ownerId',
      tenantField: 'tenantId',
      version: 'version',
    },
    _storageFields: {
      mongoPkField: '_id',
      ttlField: '_expires_at',
      mongoTtlField: '_expiresAt',
    },
    _conventions: {},
    ...config,
  } as unknown as ResolvedEntityConfig;
}

const containerConfig = asResolvedConfig({
  name: 'Container',
  fields: {
    id: { type: 'string', primary: true, immutable: true, optional: false, default: 'uuid' },
    title: { type: 'string', primary: false, immutable: false, optional: false },
  },
  _pkField: 'id',
  _storageName: 'containers',
});

const channelWithReceive: EntityChannelConfig = {
  channels: {
    live: {
      auth: 'userAuth',
      receive: {
        events: ['document.typing', 'thread.typing'],
        toRoom: true,
        excludeSender: true,
      },
    },
  },
};

const mockWsState = { presenceEnabled: false } as unknown as WsState;

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

function makeIncomingContext(
  endpoint = 'test',
): Parameters<ChannelIncomingEventDeclaration['handler']>[2] {
  return {
    socketId: 'sock1',
    actor: { ...ANONYMOUS_ACTOR, id: 'user1', kind: 'user' },
    requestTenantId: null,
    endpoint,
    publish: () => {},
    subscribe: () => {},
    unsubscribe: () => {},
  };
}

describe('buildEntityReceiveHandlers', () => {
  it('returns empty object when no channels have receive config', () => {
    const noReceive: EntityChannelConfig = {
      channels: {
        updates: { auth: 'userAuth', forward: { events: ['entity:things.updated'] } },
      },
    };
    const { fn } = makePublishFn();
    const result = buildEntityReceiveHandlers(
      noReceive,
      containerConfig,
      () => mockWsState,
      fn,
      'test',
    );
    expect(Object.keys(result)).toHaveLength(0);
  });

  it('returns one handler per event type in receive.events', () => {
    const { fn } = makePublishFn();
    const result = buildEntityReceiveHandlers(
      channelWithReceive,
      containerConfig,
      () => mockWsState,
      fn,
      'test',
    );
    expect(Object.keys(result)).toEqual(['document.typing', 'thread.typing']);
    expect(result['document.typing'].auth).toBe('userAuth');
    expect(result['thread.typing'].auth).toBe('userAuth');
  });

  it('last-wins when the same event type appears in multiple channels', async () => {
    const multiChannel: EntityChannelConfig = {
      channels: {
        live: {
          receive: { events: ['shared.event'], toRoom: true },
        },
        secondary: {
          receive: { events: ['shared.event'], toRoom: false },
        },
      },
    };
    const { fn, calls } = makePublishFn();
    const result = buildEntityReceiveHandlers(
      multiChannel,
      containerConfig,
      () => mockWsState,
      fn,
      'test',
    );

    expect(Object.keys(result)).toHaveLength(1);
    await result['shared.event'].handler(
      makeWs('sock1', ['containers:abc:secondary']),
      { room: 'containers:abc:secondary' },
      makeIncomingContext(),
    );
    expect(calls).toHaveLength(0);
  });

  it('rejects missing payload.room', async () => {
    const { fn, calls } = makePublishFn();
    const result = buildEntityReceiveHandlers(
      channelWithReceive,
      containerConfig,
      () => mockWsState,
      fn,
      'test',
    );

    await result['document.typing'].handler(
      makeWs('sock1', ['containers:abc:live']),
      { noRoom: true },
      makeIncomingContext(),
    );
    expect(calls).toHaveLength(0);
  });

  it('rejects invalid room names', async () => {
    const { fn, calls } = makePublishFn();
    const result = buildEntityReceiveHandlers(
      channelWithReceive,
      containerConfig,
      () => mockWsState,
      fn,
      'test',
    );

    await result['document.typing'].handler(
      makeWs('sock1', ['containers:abc:live']),
      { room: 'bad room with spaces!' },
      makeIncomingContext(),
    );
    expect(calls).toHaveLength(0);
  });

  it('rejects rooms the sender has not joined', async () => {
    const { fn, calls } = makePublishFn();
    const result = buildEntityReceiveHandlers(
      channelWithReceive,
      containerConfig,
      () => mockWsState,
      fn,
      'test',
    );

    await result['document.typing'].handler(
      makeWs('sock1', []),
      { room: 'containers:abc:live' },
      makeIncomingContext(),
    );
    expect(calls).toHaveLength(0);
  });

  it('rejects room storageName mismatches', async () => {
    const { fn, calls } = makePublishFn();
    const result = buildEntityReceiveHandlers(
      channelWithReceive,
      containerConfig,
      () => mockWsState,
      fn,
      'test',
    );

    await result['document.typing'].handler(
      makeWs('sock1', ['threads:abc:live']),
      { room: 'threads:abc:live' },
      makeIncomingContext(),
    );
    expect(calls).toHaveLength(0);
  });

  it('publishes to the room when toRoom is true', async () => {
    const { fn, calls } = makePublishFn();
    const result = buildEntityReceiveHandlers(
      channelWithReceive,
      containerConfig,
      () => mockWsState,
      fn,
      'entities',
    );

    await result['document.typing'].handler(
      makeWs('sock1', ['containers:abc:live']),
      { room: 'containers:abc:live' },
      makeIncomingContext('entities'),
    );

    expect(calls).toHaveLength(1);
    const [state, endpoint, room] = calls[0];
    expect(state).toBe(mockWsState);
    expect(endpoint).toBe('entities');
    expect(room).toBe('containers:abc:live');
  });

  it('excludes the sender when excludeSender is true', async () => {
    const { fn, calls } = makePublishFn();
    const result = buildEntityReceiveHandlers(
      channelWithReceive,
      containerConfig,
      () => mockWsState,
      fn,
      'entities',
    );

    await result['document.typing'].handler(
      makeWs('sock1', ['containers:abc:live']),
      { room: 'containers:abc:live' },
      makeIncomingContext('entities'),
    );

    expect(calls).toHaveLength(1);
    const [, , , , options] = calls[0];
    expect((options as { exclude: Set<string> }).exclude).toContain('sock1');
  });

  it('does not publish when toRoom is false', async () => {
    const noPublish: EntityChannelConfig = {
      channels: {
        live: { receive: { events: ['cursor.move'], toRoom: false } },
      },
    };
    const { fn, calls } = makePublishFn();
    const result = buildEntityReceiveHandlers(
      noPublish,
      containerConfig,
      () => mockWsState,
      fn,
      'test',
    );

    await result['cursor.move'].handler(
      makeWs('sock1', ['containers:abc:live']),
      { room: 'containers:abc:live' },
      makeIncomingContext(),
    );
    expect(calls).toHaveLength(0);
  });

  it('does not exclude the sender when excludeSender is false', async () => {
    const includeAll: EntityChannelConfig = {
      channels: {
        live: { receive: { events: ['presence.ping'], toRoom: true, excludeSender: false } },
      },
    };
    const { fn, calls } = makePublishFn();
    const result = buildEntityReceiveHandlers(
      includeAll,
      containerConfig,
      () => mockWsState,
      fn,
      'test',
    );

    await result['presence.ping'].handler(
      makeWs('sock1', ['containers:abc:live']),
      { room: 'containers:abc:live' },
      makeIncomingContext(),
    );

    expect(calls).toHaveLength(1);
    const [, , , , options] = calls[0];
    expect(options).toBeUndefined();
  });

  it('skips publish when getWsState returns null', async () => {
    const { fn, calls } = makePublishFn();
    const result = buildEntityReceiveHandlers(
      channelWithReceive,
      containerConfig,
      () => null,
      fn,
      'test',
    );

    await result['document.typing'].handler(
      makeWs('sock1', ['containers:abc:live']),
      { room: 'containers:abc:live' },
      makeIncomingContext(),
    );
    expect(calls).toHaveLength(0);
  });
});

function createMockAdapter(): BareEntityAdapter {
  return {
    create: mock((data: unknown) => Promise.resolve({ id: '1', ...(data as object) })),
    getById: mock((id: string) => Promise.resolve(id === 'exists' ? { id } : null)),
    list: mock(() => Promise.resolve({ items: [], hasMore: false })),
    update: mock((id: string, data: unknown) => Promise.resolve({ id, ...(data as object) })),
    delete: mock(() => Promise.resolve(true)),
  };
}

describe('EntityPlugin.buildReceiveIncoming', () => {
  it('returns empty object when no entities have receive channel config', () => {
    const plugin = createEntityPlugin({
      name: 'test',
      entities: [
        {
          config: containerConfig,
          buildAdapter: () => createMockAdapter(),
        } as unknown as EntityPluginEntry,
      ],
    });

    expect(Object.keys(plugin.buildReceiveIncoming())).toHaveLength(0);
  });

  it('returns handlers for entities with receive channel config', () => {
    const plugin = createEntityPlugin({
      name: 'test',
      entities: [
        {
          config: containerConfig,
          channels: channelWithReceive,
          buildAdapter: () => createMockAdapter(),
        } as unknown as EntityPluginEntry,
      ],
    });

    expect(Object.keys(plugin.buildReceiveIncoming()).sort()).toEqual([
      'document.typing',
      'thread.typing',
    ]);
  });

  it('builds handlers before app context is captured', () => {
    const plugin = createEntityPlugin({
      name: 'test',
      entities: [
        {
          config: containerConfig,
          channels: channelWithReceive,
          buildAdapter: () => createMockAdapter(),
        } as unknown as EntityPluginEntry,
      ],
    });

    expect(Object.keys(plugin.buildReceiveIncoming()).sort()).toEqual([
      'document.typing',
      'thread.typing',
    ]);
  });

  it('merges handlers from multiple entities', () => {
    const anotherConfig = asResolvedConfig({
      name: 'Thread',
      fields: {
        id: { type: 'string', primary: true, immutable: true, optional: false, default: 'uuid' },
        body: { type: 'string', primary: false, immutable: false, optional: false },
      },
      _pkField: 'id',
      _storageName: 'threads',
    });

    const threadChannel: EntityChannelConfig = {
      channels: {
        updates: {
          receive: { events: ['cursor.position'] },
        },
      },
    };

    const plugin = createEntityPlugin({
      name: 'test',
      entities: [
        {
          config: containerConfig,
          channels: channelWithReceive,
          buildAdapter: () => createMockAdapter(),
        } as unknown as EntityPluginEntry,
        {
          config: anotherConfig,
          channels: threadChannel,
          buildAdapter: () => createMockAdapter(),
        } as unknown as EntityPluginEntry,
      ],
    });

    expect(Object.keys(plugin.buildReceiveIncoming()).sort()).toEqual([
      'cursor.position',
      'document.typing',
      'thread.typing',
    ]);
  });
});
