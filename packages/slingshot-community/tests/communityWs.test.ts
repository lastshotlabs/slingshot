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
import { describe, expect, it } from 'bun:test';
import type {
  EntityChannelConfig,
  ResolvedEntityConfig,
  WsState,
} from '@lastshotlabs/slingshot-core';
import { ANONYMOUS_ACTOR } from '@lastshotlabs/slingshot-core';
import { buildEntityReceiveHandlers } from '@lastshotlabs/slingshot-entity';
import type { WsPublishFn } from '@lastshotlabs/slingshot-entity';
import { createCommunityPackage } from '../src/plugin';
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

// Minimal container config for receive handler tests
const containerConfig = asResolvedConfig({
  name: 'Container',
  fields: {
    id: { type: 'string', primary: true, immutable: true, optional: false, default: 'uuid' },
  },
  _pkField: 'id',
  _storageName: 'containers',
});

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
// createCommunityPackage WS wiring smoke
//
// The package-tier API no longer exposes `buildSubscribeGuard` /
// `buildReceiveIncoming` directly on the returned definition (channels are
// forwarded through the entity modules instead). The block below kept the
// smoke checks that still apply: the package must accept the `ws` config
// without throwing.
// ---------------------------------------------------------------------------

describe('createCommunityPackage WS config acceptance', () => {
  it('accepts the package without ws config', () => {
    const pkg = createCommunityPackage(baseConfig);
    expect(pkg.name).toBe('slingshot-community');
  });

  it('accepts the package with ws config set', () => {
    const pkg = createCommunityPackage({
      ...baseConfig,
      ws: {
        wsEndpoint: 'community',
      },
    });
    expect(pkg.name).toBe('slingshot-community');
  });
});

// ---------------------------------------------------------------------------
// Typing handler behavior (via buildEntityReceiveHandlers directly)
// Tests the receive config that createCommunityPackage injects for containers.
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
        actor: { ...ANONYMOUS_ACTOR, id: 'user-1', kind: 'user' },
        requestTenantId: null,
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
        actor: { ...ANONYMOUS_ACTOR, id: 'user-1', kind: 'user' },
        requestTenantId: null,
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
        actor: ANONYMOUS_ACTOR,
        requestTenantId: null,
        endpoint: 'community',
        publish() {},
        subscribe() {},
        unsubscribe() {},
      },
    );

    expect(calls).toHaveLength(0);
  });
});
