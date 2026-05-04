// packages/slingshot-chat/tests/plugin.test.ts
import { describe, expect, it } from 'bun:test';
import { Hono } from 'hono';
import type { Pool } from 'pg';
import type {
  AppEnv,
  CoreRegistrar,
  PermissionsState,
  StoreInfra,
} from '@lastshotlabs/slingshot-core';
import {
  InProcessAdapter,
  PACKAGE_CAPABILITIES_PREFIX,
  PERMISSIONS_STATE_KEY,
  RESOLVE_ENTITY_FACTORIES,
  attachContext,
  createEntityRegistry,
  createEventDefinitionRegistry,
  createEventPublisher,
  getContext,
} from '@lastshotlabs/slingshot-core';
import { createEntityFactories } from '@lastshotlabs/slingshot-entity';
import { createNotificationsTestAdapters } from '@lastshotlabs/slingshot-notifications/testing';
import { createPermissionRegistry } from '@lastshotlabs/slingshot-permissions';
import { createMemoryPermissionsAdapter } from '@lastshotlabs/slingshot-permissions/testing';
import { createChatPlugin } from '../src/plugin';
import { CHAT_PLUGIN_STATE_KEY } from '../src/state';
import { createChatTestApp } from '../src/testing';
import type { ChatPluginState } from '../src/types';

class FakeChatPostgresPool {
  readonly queries: string[] = [];

  query(
    sql: string,
    params?: unknown[],
  ): Promise<{ rows: Record<string, unknown>[]; rowCount: number | null }> {
    this.queries.push(sql);
    void params;
    return Promise.resolve({ rows: [], rowCount: 0 });
  }
}

function createPostgresChatFrameworkConfig(pool: FakeChatPostgresPool) {
  const storeInfra: StoreInfra = {
    appName: 'chat-test',
    getRedis() {
      throw new Error('Redis is not configured in this test');
    },
    getMongo() {
      throw new Error('Mongo is not configured in this test');
    },
    getSqliteDb() {
      throw new Error('SQLite is not configured in this test');
    },
    getPostgres() {
      return { pool: pool as unknown as Pool, db: {} };
    },
  };
  Reflect.set(storeInfra as object, RESOLVE_ENTITY_FACTORIES, createEntityFactories);

  const registrar = {
    registerRouteAuth() {},
    build() {
      return { routeAuth: null, permissions: null };
    },
  } as unknown as CoreRegistrar;

  return {
    resolvedStores: {
      sessions: 'memory',
      oauthState: 'memory',
      cache: 'memory',
      authStore: 'postgres',
      sqlite: undefined,
    },
    security: { cors: '*' },
    signing: null,
    dataEncryptionKeys: [],
    redis: undefined,
    mongo: undefined,
    captcha: null,
    trustProxy: false as const,
    storeInfra,
    registrar,
    entityRegistry: createEntityRegistry(),
  };
}

function createPermissionsState(): PermissionsState {
  return {
    evaluator: {
      can() {
        return Promise.resolve(true);
      },
    },
    registry: createPermissionRegistry(),
    adapter: createMemoryPermissionsAdapter(),
  };
}

function createNotificationsCapabilitiesSlot(): Record<string, unknown> {
  const adapters = createNotificationsTestAdapters();
  return {
    builderFactory: ({ source }: { source: string }) => adapters.createBuilder(source),
    deliveryRegistry: { register() {} },
  };
}

describe('createChatPlugin', () => {
  it('returns a SlingshotPlugin with correct name', () => {
    const plugin = createChatPlugin({ storeType: 'memory' });
    expect(plugin.name).toBe('slingshot-chat');
    expect(plugin.dependencies).toContain('slingshot-notifications');
  });

  it('has setupMiddleware, setupRoutes, setupPost lifecycle methods', () => {
    const plugin = createChatPlugin({ storeType: 'memory' });
    expect(typeof plugin.setupMiddleware).toBe('function');
    expect(typeof plugin.setupRoutes).toBe('function');
    expect(typeof plugin.setupPost).toBe('function');
  });

  it('throws on invalid config (wrong storeType)', () => {
    expect(() => createChatPlugin({ storeType: 'cassandra' as never })).toThrow();
  });

  it('each call returns an independent plugin instance', () => {
    const plugin1 = createChatPlugin({ storeType: 'memory' });
    const plugin2 = createChatPlugin({ storeType: 'memory' });
    expect(plugin1).not.toBe(plugin2);
  });

  it('does not throw on construction with valid config', () => {
    expect(() =>
      createChatPlugin({
        storeType: 'memory',
        mountPath: '/api/chat',
        permissions: { createRoom: ['admin'] },
        pageSize: 25,
        enablePresence: false,
      }),
    ).not.toThrow();
  });

  it('publishes a deeply frozen config into plugin state', async () => {
    const { state } = await createChatTestApp({
      encryption: {
        provider: 'aes-gcm',
        keyBase64: Buffer.from('0123456789abcdef0123456789abcdef', 'utf8').toString('base64'),
      },
    });

    expect(Object.isFrozen(state.config)).toBe(true);
    expect(Object.isFrozen(state.config.permissions ?? {})).toBe(true);
    expect(Object.isFrozen(state.config.encryption ?? {})).toBe(true);
  });

  it('boots the plugin lifecycle with a Postgres-resolved store infra', async () => {
    const plugin = createChatPlugin({ storeType: 'postgres', enablePresence: false });
    const app = new Hono<AppEnv>();
    const bus = new InProcessAdapter();
    const events = createEventPublisher({
      definitions: createEventDefinitionRegistry(),
      bus,
    });
    const pool = new FakeChatPostgresPool();
    const frameworkConfig = createPostgresChatFrameworkConfig(pool);

    attachContext(app, {
      pluginState: new Map<string, unknown>([
        [PERMISSIONS_STATE_KEY, createPermissionsState()],
        [
          `${PACKAGE_CAPABILITIES_PREFIX}slingshot-notifications`,
          createNotificationsCapabilitiesSlot(),
        ],
      ]),
      ws: null,
      wsEndpoints: {},
      wsPublish: null,
      bus,
      capabilityProviders: new Map<string, string>([
        ['builderFactory', 'slingshot-notifications'],
        ['deliveryRegistry', 'slingshot-notifications'],
      ]),
    } as unknown as Parameters<typeof attachContext>[1]);

    await plugin.setupMiddleware?.({
      app,
      config: frameworkConfig as never,
      bus,
      events,
    });
    await plugin.setupRoutes?.({
      app,
      config: frameworkConfig as never,
      bus,
      events,
    });
    await plugin.setupPost?.({
      app,
      config: frameworkConfig as never,
      bus,
      events,
    });

    const state = getContext(app).pluginState.get(CHAT_PLUGIN_STATE_KEY) as
      | ChatPluginState
      | undefined;

    expect(state).toBeDefined();
    expect(state?.config.storeType).toBe('postgres');
    expect(getContext(app).wsEndpoints?.['/chat']).toBeDefined();

    plugin.teardown?.();
  });

  it('registers chat push formatters through the optional peer boundary', async () => {
    const registered = new Map<string, unknown>();
    const peersPluginState = new Map<string, unknown>([
      [
        'slingshot-push',
        {
          registerFormatter(type: string, formatter: unknown) {
            registered.set(type, formatter);
          },
        },
      ],
    ]);

    await createChatTestApp({}, { peersPluginState });

    expect(registered.has('chat:mention')).toBe(true);
    expect(registered.has('chat:reply')).toBe(true);
    expect(registered.has('chat:dm')).toBe(true);
    expect(registered.has('chat:invite')).toBe(true);
    expect(registered.has('chat:poll')).toBe(true);
  });
});
