import { afterEach, describe, expect, mock, test } from 'bun:test';
import {
  RESOLVE_REINDEX_SOURCE,
  createEntityRegistry,
  createRouter,
} from '@lastshotlabs/slingshot-core';
import type { SecretRepository } from '@lastshotlabs/slingshot-core';
import { createApp } from '../../src/app';
import { buildContext, finalizeContext } from '../../src/framework/buildContext';
import { createMetricsState } from '../../src/framework/metrics/registry';
import {
  CONTEXT_STORE_INFRA,
  getContextStoreInfra,
} from '../../src/framework/persistence/internalRepoResolution';

const disconnectRedisMock = mock(async () => {});
const disconnectMongoMock = mock(async () => {});

mock.module('@lib/redis', () => ({
  disconnectRedis: disconnectRedisMock,
}));

mock.module('@lib/mongo', () => ({
  disconnectMongo: disconnectMongoMock,
}));

const baseConfig = {
  meta: { name: 'Build Context Test App' },
  db: {
    mongo: false as const,
    redis: false,
    sessions: 'memory' as const,
    cache: 'memory' as const,
    auth: 'memory' as const,
  },
  security: {
    rateLimit: { windowMs: 60_000, max: 1000 },
    signing: {
      secret: 'test-secret-key-must-be-at-least-32-chars!!',
      sessionBinding: false as const,
    },
  },
  logging: { onLog: () => {} },
};

const createdContexts: Array<{ destroy(): Promise<void> }> = [];

afterEach(async () => {
  for (const ctx of createdContexts.splice(0)) {
    await ctx.destroy().catch(() => {});
  }
  disconnectRedisMock.mockClear();
  disconnectMongoMock.mockClear();
  disconnectRedisMock.mockResolvedValue(undefined);
  disconnectMongoMock.mockResolvedValue(undefined);
});

describe('finalizeContext', () => {
  test('replaces registrar-owned fields and refreshes mutable maps from the snapshot', () => {
    const ctx = {
      routeAuth: 'stale-route-auth',
      userResolver: 'stale-user-resolver',
      rateLimitAdapter: 'stale-rate-limit-adapter',
      fingerprintBuilder: 'stale-fingerprint-builder',
      cacheAdapters: new Map([[Symbol.for('old-store'), 'old-adapter']]),
      emailTemplates: new Map([['old-template', { subject: 'Old' }]]),
    } as any;

    const snapshot = {
      routeAuth: { userAuth: async () => {} },
      userResolver: { resolveUserId: async () => 'user-1' },
      rateLimitAdapter: {
        trackAttempt: async () => false,
        resetAttempts: async () => {},
      },
      fingerprintBuilder: { buildFingerprint: async () => 'fp-1' },
      cacheAdapters: new Map([[Symbol.for('new-store'), 'new-adapter']]),
      emailTemplates: new Map([['welcome', { subject: 'Welcome' }]]),
    } as any;

    finalizeContext(ctx, snapshot);

    expect(ctx.routeAuth).toBe(snapshot.routeAuth);
    expect(ctx.userResolver).toBe(snapshot.userResolver);
    expect(ctx.rateLimitAdapter).toBe(snapshot.rateLimitAdapter);
    expect(ctx.fingerprintBuilder).toBe(snapshot.fingerprintBuilder);
    expect(Object.isFrozen(ctx.routeAuth)).toBe(true);
    expect(Object.isFrozen(ctx.userResolver)).toBe(true);
    expect(Object.isFrozen(ctx.rateLimitAdapter)).toBe(true);
    expect(Object.isFrozen(ctx.fingerprintBuilder)).toBe(true);
    expect([...ctx.cacheAdapters.entries()]).toEqual([...snapshot.cacheAdapters.entries()]);
    expect([...ctx.emailTemplates.entries()]).toEqual([...snapshot.emailTemplates.entries()]);
    expect(Object.isFrozen(ctx.emailTemplates.get('welcome'))).toBe(true);
  });
});

describe('buildContext lifecycle', () => {
  async function createDirectContext(overrides?: {
    infra?: Partial<Parameters<typeof buildContext>[0]['infra']>;
    permissions?: unknown;
    plugins?: Parameters<typeof buildContext>[0]['plugins'];
    secretDestroy?: ReturnType<typeof mock>;
    busShutdown?: ReturnType<typeof mock>;
    upload?: Parameters<typeof buildContext>[0]['upload'];
    signing?: Parameters<typeof buildContext>[0]['signing'];
    captcha?: Parameters<typeof buildContext>[0]['captcha'];
    mergedSecrets?: Record<string, string | undefined>;
  }) {
    const busShutdown = overrides?.busShutdown ?? mock(async () => {});
    const secretDestroy = overrides?.secretDestroy ?? mock(async () => {});
    const app = createRouter();
    const entityRegistry = createEntityRegistry();
    const infra = {
      frameworkConfig: {
        entityRegistry,
        trustProxy: false,
        storeInfra: {
          appName: 'direct-app',
          getRedis: () => {
            throw new Error('not configured');
          },
          getMongo: () => {
            throw new Error('not configured');
          },
          getSqliteDb: () => {
            throw new Error('not configured');
          },
          getPostgres: () => {
            throw new Error('not configured');
          },
        },
      },
      resolvedStores: {
        sessions: 'memory',
        oauthState: 'memory',
        cache: 'memory',
        authStore: 'memory',
        sqlite: undefined,
      },
      redisEnabled: false,
      mongoMode: false,
      dataEncryptionKeys: [],
      corsOrigins: '*',
      persistence: {
        idempotency: { clear: async () => {} },
        uploadRegistry: { clear: async () => {} },
        wsMessages: { clear: async () => {} },
        auditLog: {},
        cronRegistry: {},
        configureRoom() {},
        getRoomConfig() {
          return null;
        },
        setDefaults() {},
      },
      sqliteDb: null,
      redis: null,
      mongo: null,
      postgres: null,
      ...overrides?.infra,
    } as Parameters<typeof buildContext>[0]['infra'];

    const ctx = await buildContext({
      app,
      appName: 'direct-app',
      infra,
      signing: overrides?.signing ?? null,
      captcha: overrides?.captcha ?? null,
      upload: overrides?.upload,
      metricsState: createMetricsState(),
      plugins: overrides?.plugins ?? [],
      bus: {
        shutdown: busShutdown,
      } as any,
      secretBundle: {
        provider: {
          name: 'direct-secrets',
          get: async () => null,
          getMany: async () => new Map(),
          destroy: secretDestroy,
        },
        framework: {} as any,
        app: null as any,
        merged: (overrides?.mergedSecrets ?? {}) as any,
      },
      permissions: overrides?.permissions as any,
    });

    createdContexts.push(ctx);
    return { ctx, busShutdown, secretDestroy };
  }

  test('freezes externally readable config snapshots and copies mutable inputs', async () => {
    const corsOrigins = ['https://api.example.com'];
    const allowedMimeTypes = ['image/png'];
    const mergedSecrets = { JWT_SECRET: 'secret-1' };
    const { ctx } = await createDirectContext({
      infra: {
        corsOrigins,
      },
      upload: {
        storage: { put: async () => ({ key: 'file-1', url: '/uploads/file-1' }) } as any,
        maxFileSize: 1024,
        maxFiles: 2,
        allowedMimeTypes,
      },
      mergedSecrets,
    });

    corsOrigins.push('https://mutated.example.com');
    allowedMimeTypes.push('image/jpeg');
    mergedSecrets.JWT_SECRET = 'secret-2';

    expect(ctx.config.security.cors).toEqual(['https://api.example.com']);
    expect(Object.isFrozen(ctx.config.security.cors)).toBe(true);
    expect(ctx.upload?.config.allowedMimeTypes).toEqual(['image/png']);
    expect(Object.isFrozen(ctx.upload?.config.allowedMimeTypes)).toBe(true);
    expect(ctx.resolvedSecrets).toEqual({ JWT_SECRET: 'secret-1' });
    expect(Object.isFrozen(ctx.resolvedSecrets)).toBe(true);
  });

  test('clones and freezes signing config at the context boundary', async () => {
    const signing = {
      secret: ['secret-1'],
      requestSigning: { tolerance: 300, header: 'x-signature' },
      sessionBinding: { fields: ['ua'] as ('ua' | 'ip')[], onMismatch: 'reject' as const },
    };

    const { ctx } = await createDirectContext({ signing });

    signing.secret.push('secret-2');
    signing.requestSigning.tolerance = 30;
    signing.sessionBinding.fields.push('ip');

    expect(ctx.signing).toEqual({
      secret: ['secret-1'],
      requestSigning: { tolerance: 300, header: 'x-signature' },
      sessionBinding: { fields: ['ua'], onMismatch: 'reject' },
    });
    expect(ctx.config.signing).toEqual(ctx.signing);
    expect(ctx.signing).not.toBe(signing);
    expect(ctx.config.signing).not.toBe(signing);
    expect(Object.isFrozen(ctx.signing)).toBe(true);
    expect(Object.isFrozen(ctx.config.signing)).toBe(true);
  });

  test('publishes registrar maps through readonly views after finalization', async () => {
    const { ctx } = await createDirectContext();
    const cacheAdapter = {
      name: 'memory',
      get: async () => null,
      set: async () => {},
      del: async () => {},
      delPattern: async () => {},
      isReady: () => true,
    };
    const template = {
      subject: 'Welcome',
      html: '<p>Hello</p>',
    };

    finalizeContext(ctx, {
      routeAuth: null,
      userResolver: null,
      rateLimitAdapter: null,
      fingerprintBuilder: null,
      cacheAdapters: new Map([['memory', cacheAdapter]]),
      emailTemplates: new Map([['welcome', template]]),
    });

    expect(ctx.cacheAdapters.get('memory')).toBe(cacheAdapter);
    expect(ctx.emailTemplates.get('welcome')).toBe(template);
    expect('set' in (ctx.cacheAdapters as object)).toBe(false);
    expect('delete' in (ctx.cacheAdapters as object)).toBe(false);
    expect('clear' in (ctx.cacheAdapters as object)).toBe(false);
    expect('set' in (ctx.emailTemplates as object)).toBe(false);
    expect('delete' in (ctx.emailTemplates as object)).toBe(false);
    expect('clear' in (ctx.emailTemplates as object)).toBe(false);
  });

  test('locks context store infra except for the reindex source slot', async () => {
    const { ctx } = await createDirectContext();
    const storeInfra = getContextStoreInfra(ctx);
    const replacement = (_storageName: string) => null;

    expect(storeInfra).not.toBeNull();
    expect(Object.isExtensible(storeInfra)).toBe(false);
    expect(Reflect.set(storeInfra as object, 'appName', 'mutated-app')).toBe(false);
    expect(Reflect.set(storeInfra as object, 'randomProperty', 'value')).toBe(false);
    expect(Reflect.set(storeInfra as object, RESOLVE_REINDEX_SOURCE, replacement)).toBe(true);
    expect(Reflect.get(storeInfra as object, RESOLVE_REINDEX_SOURCE)).toBe(replacement);
  });

  test('rejects forged unbranded context store infra objects', () => {
    const carrier = {};
    const forgedStoreInfra = {
      appName: 'forged-app',
      getRedis: () => {
        throw new Error('forged');
      },
      getMongo: () => {
        throw new Error('forged');
      },
      getSqliteDb: () => {
        throw new Error('forged');
      },
      getPostgres: () => {
        throw new Error('forged');
      },
    };

    Object.defineProperty(carrier, CONTEXT_STORE_INFRA, {
      configurable: false,
      enumerable: false,
      writable: false,
      value: forgedStoreInfra,
    });

    expect(getContextStoreInfra(carrier)).toBeNull();
  });

  test('clear resets websocket runtime state and stops the heartbeat timer', async () => {
    const result = await createApp(baseConfig);
    createdContexts.push(result.ctx);

    const heartbeatTimer = setInterval(() => {}, 1_000);
    result.ctx.ws = {
      roomRegistry: new Map([['room-1', new Set(['socket-1'])]]),
      heartbeatSockets: new Set(['socket-1']),
      heartbeatEndpointConfigs: new Map([['chat', { intervalMs: 1_000 }]]),
      socketUsers: new Map([['socket-1', 'user-1']]),
      roomPresence: new Map([['room-1', new Set(['user-1'])]]),
      socketRegistry: new Map([['socket-1', {}]]),
      rateLimitState: new Map([['socket-1', { count: 1, windowStart: Date.now() }]]),
      sessionRegistry: new Map([
        ['session-1', { rooms: ['room-1'], lastEventId: 'evt-1', expiresAt: Date.now() + 1_000 }],
      ]),
      lastEventIds: new Map([['socket-1', 'evt-1']]),
      heartbeatTimer,
    } as any;

    await result.ctx.clear();

    expect(result.ctx.ws?.roomRegistry.size).toBe(0);
    expect(result.ctx.ws?.heartbeatSockets.size).toBe(0);
    expect(result.ctx.ws?.heartbeatEndpointConfigs.size).toBe(0);
    expect(result.ctx.ws?.socketUsers.size).toBe(0);
    expect(result.ctx.ws?.roomPresence.size).toBe(0);
    expect(result.ctx.ws?.socketRegistry.size).toBe(0);
    expect(result.ctx.ws?.rateLimitState.size).toBe(0);
    expect(result.ctx.ws?.sessionRegistry.size).toBe(0);
    expect(result.ctx.ws?.lastEventIds.size).toBe(0);
    expect(result.ctx.ws?.heartbeatTimer).toBeNull();
  });

  test('destroy calls the secret provider destroy hook', async () => {
    const destroy = mock(async () => {});
    const teardown = mock(async () => {});
    const busShutdown = mock(async () => {});
    const secrets: SecretRepository = {
      name: 'test-secrets',
      get: async () => null,
      getMany: async () => new Map(),
      destroy,
    };

    const result = await createApp({
      ...baseConfig,
      secrets,
      plugins: [
        {
          name: 'test-plugin',
          setupPost: async () => {},
          teardown,
        },
      ],
    });
    result.ctx.bus.shutdown = busShutdown;

    await result.ctx.destroy();

    expect(destroy).toHaveBeenCalledTimes(1);
    expect(teardown).toHaveBeenCalledTimes(1);
    expect(busShutdown).toHaveBeenCalledTimes(1);
  });

  test('destroy is idempotent and swallows transport and backend disconnect failures', async () => {
    disconnectRedisMock.mockRejectedValueOnce(new Error('redis disconnect failed'));
    disconnectMongoMock.mockRejectedValueOnce(new Error('mongo disconnect failed'));
    const transportDisconnect = mock(async () => {
      throw new Error('transport disconnect failed');
    });
    const sqliteClose = mock(() => {});
    const teardown = mock(async () => {});
    const { ctx, secretDestroy } = await createDirectContext({
      infra: {
        redisEnabled: true,
        redis: { kind: 'redis-client' } as any,
        mongoMode: 'single',
        mongo: {
          auth: { kind: 'auth-conn' } as any,
          app: { kind: 'app-conn' } as any,
          mongoose: { connection: { readyState: 1 } } as any,
        },
        sqliteDb: { close: sqliteClose } as any,
      },
      plugins: [
        {
          name: 'teardown-plugin',
          teardown,
        },
      ],
    });
    ctx.ws = {
      roomRegistry: new Map(),
      heartbeatSockets: new Set(),
      heartbeatEndpointConfigs: new Map(),
      socketUsers: new Map(),
      roomPresence: new Map(),
      socketRegistry: new Map(),
      rateLimitState: new Map(),
      sessionRegistry: new Map(),
      lastEventIds: new Map(),
      heartbeatTimer: null,
      transport: {
        disconnect: transportDisconnect,
      },
    } as any;

    const firstDestroy = ctx.destroy();
    const secondDestroy = ctx.destroy();
    await Promise.all([firstDestroy, secondDestroy]);

    expect(transportDisconnect).toHaveBeenCalledTimes(1);
    expect(disconnectRedisMock).toHaveBeenCalledTimes(1);
    expect(disconnectMongoMock).toHaveBeenCalledTimes(1);
    expect(sqliteClose).toHaveBeenCalledTimes(1);
    expect(teardown).toHaveBeenCalledTimes(1);
    expect(secretDestroy).toHaveBeenCalledTimes(1);
    expect(ctx.ws?.transport).toBeNull();
  });
});
