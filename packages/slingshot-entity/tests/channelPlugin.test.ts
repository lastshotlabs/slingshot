/**
 * Integration tests for createEntityPlugin() channel lifecycle.
 *
 * Validates that channel config integrates correctly with the current plugin lifecycle:
 * - buildSubscribeGuard() returns a working guard
 * - setupPost wires forwarding through app-context WS publish access
 * - forwarding registration happens even before WS state is ready
 * - teardown cleans up forwarding listeners
 * - entities without channels are ignored cleanly
 */
import { describe, expect, it, mock } from 'bun:test';
import type {
  Actor,
  EntityChannelConfig,
  EntityRegistry,
  ResolvedEntityConfig,
  SlingshotContext,
  SlingshotEventBus,
  SlingshotFrameworkConfig,
  StoreType,
  WsState,
} from '@lastshotlabs/slingshot-core';
import { ANONYMOUS_ACTOR } from '@lastshotlabs/slingshot-core';
import { createMemoryStoreInfra } from '@lastshotlabs/slingshot-core/testing';
import type { WsPublishFn } from '../src/channels/applyChannelConfig';
import { createEntityPlugin } from '../src/createEntityPlugin';
import type { EntityPluginEntry } from '../src/createEntityPlugin';
import type { BareEntityAdapter } from '../src/routing/buildBareEntityRoutes';

const userActor = (id: string): Actor => ({ ...ANONYMOUS_ACTOR, id, kind: 'user' });

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

const threadConfig = asResolvedConfig({
  name: 'Thread',
  fields: {
    id: { type: 'string', primary: true, immutable: true, optional: false, default: 'uuid' },
    title: { type: 'string', primary: false, immutable: false, optional: false },
  },
  _pkField: 'id',
  _storageName: 'threads',
});

const threadChannels: EntityChannelConfig = {
  channels: {
    updates: {
      auth: 'userAuth',
      permission: { requires: 'thread:read' },
      forward: {
        events: ['entity:threads.updated'],
      },
    },
  },
};

function createMockAdapter(): BareEntityAdapter {
  return {
    create: mock((data: unknown) => Promise.resolve({ id: '1', ...(data as object) })),
    getById: mock((id: string) => Promise.resolve(id === 'exists' ? { id } : null)),
    list: mock(() => Promise.resolve({ items: [], hasMore: false })),
    update: mock((id: string, data: unknown) => Promise.resolve({ id, ...(data as object) })),
    delete: mock(() => Promise.resolve(true)),
  };
}

type MockBus = SlingshotEventBus & {
  handlers: Map<string, Array<(payload: Record<string, unknown>) => void>>;
};

function createMockBus(): MockBus {
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
      if (!list) return;
      const index = list.indexOf(handler);
      if (index !== -1) list.splice(index, 1);
    }),
  } as unknown as MockBus;
}

function createMockFrameworkConfig(): SlingshotFrameworkConfig & {
  entityRegistry: EntityRegistry & { registered: ResolvedEntityConfig[] };
} {
  const registered: ResolvedEntityConfig[] = [];
  return {
    resolvedStores: {
      sessions: 'memory' as StoreType,
      oauthState: 'memory' as StoreType,
      cache: 'memory' as StoreType,
      authStore: 'memory' as StoreType,
      sqlite: undefined,
    },
    logging: {
      enabled: false,
      verbose: false,
      authTrace: false,
      auditWarnings: false,
    },
    security: { cors: '*' },
    signing: null,
    dataEncryptionKeys: [],
    redis: undefined,
    mongo: undefined,
    captcha: null,
    trustProxy: false,
    password: Bun.password,
    storeInfra: createMemoryStoreInfra(),
    registrar: {} as unknown as import('@lastshotlabs/slingshot-core').CoreRegistrar,
    entityRegistry: {
      registered,
      register: mock((config: ResolvedEntityConfig) => {
        registered.push(config);
      }),
      get: mock(() => undefined),
      list: mock(() => []),
    } as unknown as EntityRegistry & { registered: ResolvedEntityConfig[] },
  };
}

const APP_CONTEXT_SYMBOL = Symbol.for('slingshot.context');

function createMockApp(
  wsState: WsState | null = null,
  wsPublish: WsPublishFn | null = mock(() => {}),
) {
  const routes: Array<{ path: string; router: unknown }> = [];
  const app = {
    route: mock((path: string, router: unknown) => {
      routes.push({ path, router });
    }),
    use: mock(() => {}),
    routes,
  };

  Object.defineProperty(app, APP_CONTEXT_SYMBOL, {
    configurable: true,
    enumerable: false,
    writable: true,
    value: {
      ws: wsState,
      wsPublish,
      pluginState: new Map<string, unknown>(),
    } as unknown as SlingshotContext,
  });

  return { app, wsPublish };
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

function makeEntry(
  config: ResolvedEntityConfig,
  channels?: EntityChannelConfig,
): EntityPluginEntry {
  return {
    config,
    channels,
    buildAdapter: () => createMockAdapter(),
  };
}

async function runSetupPost(
  plugin: ReturnType<typeof createEntityPlugin>,
  app: object,
  config: SlingshotFrameworkConfig,
  bus: SlingshotEventBus,
): Promise<void> {
  await plugin.setupPost?.({
    app: app as unknown as import('hono').Hono,
    config,
    bus,
  } as unknown as Parameters<NonNullable<ReturnType<typeof createEntityPlugin>['setupPost']>>[0]);
}

describe('createEntityPlugin channel lifecycle', () => {
  it('buildSubscribeGuard returns a working guard for entities with channels', async () => {
    const entry = makeEntry(threadConfig, threadChannels);
    const plugin = createEntityPlugin({ name: 'test', entities: [entry] });

    const guard = plugin.buildSubscribeGuard({
      getActor: () => userActor('user-1'),
      checkPermission: () => Promise.resolve(true),
      middleware: {},
    });

    expect(await guard({}, 'threads:abc123:updates')).toBe(true);
    expect(await guard({}, 'threads:abc123:unknown')).toBe(false);
  });

  it('buildSubscribeGuard ignores entities without channels', async () => {
    const plugin = createEntityPlugin({ name: 'test', entities: [makeEntry(threadConfig)] });

    const guard = plugin.buildSubscribeGuard({
      getActor: () => userActor('user-1'),
      checkPermission: () => Promise.resolve(true),
      middleware: {},
    });

    expect(await guard({}, 'threads:abc123:updates')).toBe(false);
  });

  it('setupPost wires forwarding through app-context wsPublish', async () => {
    const wsState = makeMockWsState();
    const bus = createMockBus();
    const fw = createMockFrameworkConfig();
    const publish = mock<WsPublishFn>(() => {});
    const { app } = createMockApp(wsState, publish);

    const plugin = createEntityPlugin({
      name: 'test',
      entities: [makeEntry(threadConfig, threadChannels)],
    });

    await runSetupPost(plugin, app, fw, bus);

    expect(bus.handlers.get('entity:threads.updated')!.length).toBe(1);

    bus.handlers.get('entity:threads.updated')![0]({ id: 'thread-1', title: 'Updated' });
    expect(publish).toHaveBeenCalledWith(wsState, 'entities', 'threads:thread-1:updates', {
      id: 'thread-1',
      title: 'Updated',
    });
  });

  it('setupPost still wires forwarding before WS state exists', async () => {
    const bus = createMockBus();
    const fw = createMockFrameworkConfig();
    const publish = mock<WsPublishFn>(() => {});
    const { app } = createMockApp(null, publish);

    const plugin = createEntityPlugin({
      name: 'test',
      entities: [makeEntry(threadConfig, threadChannels)],
    });

    await runSetupPost(plugin, app, fw, bus);

    expect(bus.handlers.get('entity:threads.updated')!.length).toBe(1);
    bus.handlers.get('entity:threads.updated')![0]({ id: 'thread-1' });
    expect(publish).not.toHaveBeenCalled();
  });

  it('setupPost treats missing wsPublish as a no-op publisher', async () => {
    const wsState = makeMockWsState();
    const bus = createMockBus();
    const fw = createMockFrameworkConfig();
    const { app } = createMockApp(wsState, null);

    const plugin = createEntityPlugin({
      name: 'test',
      entities: [makeEntry(threadConfig, threadChannels)],
    });

    await runSetupPost(plugin, app, fw, bus);

    expect(bus.handlers.get('entity:threads.updated')!.length).toBe(1);
    expect(() => bus.handlers.get('entity:threads.updated')![0]({ id: 'thread-1' })).not.toThrow();
  });

  it('teardown cleans up forwarding listeners', async () => {
    const wsState = makeMockWsState();
    const bus = createMockBus();
    const fw = createMockFrameworkConfig();
    const { app } = createMockApp(wsState);

    const plugin = createEntityPlugin({
      name: 'test',
      entities: [makeEntry(threadConfig, threadChannels)],
    });

    await runSetupPost(plugin, app, fw, bus);
    expect(bus.handlers.get('entity:threads.updated')!.length).toBe(1);

    await plugin.teardown!();
    expect(bus.handlers.get('entity:threads.updated')!.length).toBe(0);
  });

  it('setupPost handles entity without channels cleanly', async () => {
    const wsState = makeMockWsState();
    const bus = createMockBus();
    const fw = createMockFrameworkConfig();
    const { app } = createMockApp(wsState);

    const plugin = createEntityPlugin({
      name: 'test',
      entities: [makeEntry(threadConfig)],
    });

    await runSetupPost(plugin, app, fw, bus);
    expect(bus.handlers.size).toBe(0);
  });

  it('uses custom wsEndpoint when specified', async () => {
    const wsState = makeMockWsState();
    const bus = createMockBus();
    const fw = createMockFrameworkConfig();
    const publish = mock<WsPublishFn>(() => {});
    const { app } = createMockApp(wsState, publish);

    const plugin = createEntityPlugin({
      name: 'test',
      entities: [makeEntry(threadConfig, threadChannels)],
      wsEndpoint: 'custom-ws',
    });

    await runSetupPost(plugin, app, fw, bus);
    bus.handlers.get('entity:threads.updated')![0]({ id: 'thread-1' });

    expect(publish).toHaveBeenCalledWith(wsState, 'custom-ws', 'threads:thread-1:updates', {
      id: 'thread-1',
    });
  });

  it('handles mixed entities with and without channels', async () => {
    const wsState = makeMockWsState();
    const bus = createMockBus();
    const fw = createMockFrameworkConfig();
    const { app } = createMockApp(wsState);

    const commentConfig = asResolvedConfig({
      name: 'Comment',
      fields: {
        id: { type: 'string', primary: true, immutable: true, optional: false, default: 'uuid' },
        text: { type: 'string', primary: false, immutable: false, optional: false },
      },
      _pkField: 'id',
      _storageName: 'comments',
    });

    const plugin = createEntityPlugin({
      name: 'test',
      entities: [makeEntry(threadConfig, threadChannels), makeEntry(commentConfig)],
    });

    await runSetupPost(plugin, app, fw, bus);

    expect(bus.handlers.get('entity:threads.updated')!.length).toBe(1);

    const guard = plugin.buildSubscribeGuard({
      getActor: () => userActor('user-1'),
      checkPermission: () => Promise.resolve(true),
      middleware: {},
    });

    expect(await guard({}, 'threads:abc:updates')).toBe(true);
    expect(await guard({}, 'comments:abc:updates')).toBe(false);
  });
});

describe('WsPublishFn options', () => {
  it('accepts options.exclude parameter without type errors', () => {
    const calls: unknown[][] = [];
    const fn: WsPublishFn = (state, endpoint, room, data, options) => {
      calls.push([state, endpoint, room, data, options]);
    };
    const mockState = {} as unknown as WsState;
    fn(mockState, 'test', 'room:1:ch', { event: 'test' }, { exclude: new Set(['sock1']) });
    expect(calls).toHaveLength(1);
    expect((calls[0][4] as { exclude: Set<string> }).exclude).toContain('sock1');
  });

  it('works without options', () => {
    const calls: unknown[][] = [];
    const fn: WsPublishFn = (state, endpoint, room, data, options) => {
      calls.push([state, endpoint, room, data, options]);
    };
    const mockState = {} as unknown as WsState;
    fn(mockState, 'test', 'room:1:ch', { event: 'test' });
    expect(calls).toHaveLength(1);
    expect(calls[0][4]).toBeUndefined();
  });
});
