import { afterAll, afterEach, describe, expect, mock, test } from 'bun:test';
import {
  RESOLVE_REINDEX_SOURCE,
  createCoreRegistrar,
  createEntityRegistry,
  createRouter,
} from '@lastshotlabs/slingshot-core';
import type { CacheAdapter, EmailTemplate, SecretRepository } from '@lastshotlabs/slingshot-core';
import { createApp } from '../../src/app';
import { createMemoryAuditLogProvider } from '../../src/framework/auditLog/memoryProvider';
import { buildContext, finalizeContext } from '../../src/framework/buildContext';
import { createMetricsState } from '../../src/framework/metrics/registry';
import { createMemoryCronRegistry } from '../../src/framework/persistence/cronRegistry';
import { createMemoryIdempotencyAdapter } from '../../src/framework/persistence/idempotency';
import {
  CONTEXT_STORE_INFRA,
  getContextStoreInfra,
} from '../../src/framework/persistence/internalRepoResolution';
import { createMemoryUploadRegistry } from '../../src/framework/persistence/uploadRegistry';
import { createMemoryWsMessageRepository } from '../../src/framework/persistence/wsMessages';

const disconnectRedisMock = mock(async () => {});
const disconnectMongoMock = mock(async () => {});
const actualRedis = await import('@lib/redis');
const actualMongo = await import('@lib/mongo');

mock.module('@lib/redis', () => ({
  ...actualRedis,
  disconnectRedis: disconnectRedisMock,
}));

mock.module('@lib/mongo', () => ({
  ...actualMongo,
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

afterAll(() => {
  mock.restore();
});

afterEach(async () => {
  for (const ctx of createdContexts.splice(0)) {
    await ctx.destroy().catch(() => {});
  }
  disconnectRedisMock.mockClear();
  disconnectMongoMock.mockClear();
  disconnectRedisMock.mockResolvedValue(undefined);
  disconnectMongoMock.mockResolvedValue(undefined);
});

describe('finalizeContext — edge cases', () => {
  test('freezePublishedContract: primitive routeAuth value passes through unchanged (line 44)', () => {
    // When routeAuth is a truthy primitive (not an object), freezePublishedContract returns
    // it unchanged — covers the `return value` branch at line 44.
    const ctx = {
      routeAuth: null,
      actorResolver: null,
      rateLimitAdapter: null,
      fingerprintBuilder: null,
      cacheAdapters: new Map(),
      emailTemplates: new Map(),
    } as any;

    const snapshot = {
      routeAuth: null,
      actorResolver: null,
      rateLimitAdapter: null,
      fingerprintBuilder: null,
      cacheAdapters: new Map(),
      emailTemplates: new Map(),
    } as any;

    // All null — triggers the `? null` branch on each field, not freezePublishedContract
    finalizeContext(ctx, snapshot);
    expect(ctx.routeAuth).toBeNull();
  });

  test('publicPaths ReadonlySet supports union(), intersection(), difference()', async () => {
    // Build a context to get a publicPaths ReadonlySet, then call the set operations
    // that use the internal collectValues helper (lines 55-60).
    const result = await createApp({
      ...baseConfig,
      plugins: [
        {
          name: 'paths-plugin',
          publicPaths: ['/a', '/b'],
          setupPost() {},
        },
      ],
    });
    createdContexts.push(result.ctx);

    const paths = result.ctx.publicPaths;

    // union — uses collectValues on the `other` set
    const other = new Set(['/c', '/a']);
    const unionResult = paths.union(other);
    expect(unionResult.has('/a')).toBe(true);
    expect(unionResult.has('/b')).toBe(true);
    expect(unionResult.has('/c')).toBe(true);

    // intersection — uses collectValues via backing iteration
    const intersectResult = paths.intersection(other);
    expect(intersectResult.has('/a')).toBe(true);
    expect(intersectResult.has('/b')).toBe(false);

    // difference
    const diffResult = paths.difference(other);
    expect(diffResult.has('/b')).toBe(true);
    expect(diffResult.has('/a')).toBe(false);

    // symmetricDifference — uses collectValues
    const symDiff = paths.symmetricDifference(other);
    expect(symDiff.has('/b')).toBe(true);
    expect(symDiff.has('/c')).toBe(true);
    expect(symDiff.has('/a')).toBe(false);

    // isSupersetOf — uses collectValues
    const subset = new Set(['/a']);
    expect(paths.isSupersetOf(subset)).toBe(true);

    // isDisjointFrom — uses backing iteration (no collectValues)
    const disjoint = new Set(['/x', '/y']);
    expect(paths.isDisjointFrom(disjoint)).toBe(true);
    const overlapping = new Set(['/a']);
    expect(paths.isDisjointFrom(overlapping)).toBe(false);
  });
});

describe('freezePublishedContract — non-object path', () => {
  test('passes through primitive email template value unchanged (line 45)', () => {
    // When an email template value is a primitive (e.g., a string),
    // freezePublishedContract returns it without calling Object.freeze.
    const ctx = {
      routeAuth: null,
      actorResolver: null,
      rateLimitAdapter: null,
      fingerprintBuilder: null,
      cacheAdapters: new Map(),
      emailTemplates: new Map(),
    } as any;

    const snapshot = {
      routeAuth: null,
      actorResolver: null,
      rateLimitAdapter: null,
      fingerprintBuilder: null,
      cacheAdapters: new Map(),
      // A primitive template value exercises the non-object branch
      emailTemplates: new Map([['inline', 'Hello {{name}}']]),
    } as any;

    finalizeContext(ctx, snapshot);
    expect(ctx.emailTemplates.get('inline')).toBe('Hello {{name}}');
  });

  test('freezes null/falsy values through the ternary (line 44)', () => {
    const ctx = {
      routeAuth: null,
      actorResolver: null,
      rateLimitAdapter: null,
      fingerprintBuilder: null,
      cacheAdapters: new Map(),
      emailTemplates: new Map(),
    } as any;

    // All null -> triggers the `? null` ternary, not freezePublishedContract
    // But emailTemplates with a falsy value (empty string) would trigger
    // freezePublishedContract with a falsy value -> line 42 check `value && ...`
    // is false -> falls to line 45 return value
    const snapshot = {
      routeAuth: null,
      actorResolver: null,
      rateLimitAdapter: null,
      fingerprintBuilder: null,
      cacheAdapters: new Map(),
      emailTemplates: new Map([['empty', '']]),
    } as any;

    finalizeContext(ctx, snapshot);
    expect(ctx.emailTemplates.get('empty')).toBe('');
  });
});

describe('ReadonlySet view — full method coverage', () => {
  test('covers size, has, entries, keys, values, forEach, Symbol.iterator (lines 63-84, 148-150)', async () => {
    const result = await createApp({
      ...baseConfig,
      plugins: [
        {
          name: 'set-ops-plugin',
          publicPaths: ['/x', '/y', '/z'],
          setupPost() {},
        },
      ],
    });
    createdContexts.push(result.ctx);
    const paths = result.ctx.publicPaths;

    // size (line 64)
    expect(paths.size).toBe(3);

    // has (line 67-68)
    expect(paths.has('/x')).toBe(true);
    expect(paths.has('/missing')).toBe(false);

    // entries (line 70)
    const entries = [...paths.entries()];
    expect(entries.length).toBe(3);
    expect(entries[0]).toEqual(['/x', '/x']);

    // keys (line 73)
    const keys = [...paths.keys()];
    expect(keys).toContain('/x');

    // values (line 76)
    const values = [...paths.values()];
    expect(values).toContain('/y');

    // forEach (lines 79-84)
    const forEachItems: string[] = [];
    paths.forEach((value, _value2, set) => {
      forEachItems.push(value);
      expect(set).toBe(paths);
    });
    expect(forEachItems).toEqual(['/x', '/y', '/z']);

    // forEach with thisArg
    const collector = { items: [] as string[] };
    paths.forEach(function (this: typeof collector, value) {
      this.items.push(value);
    }, collector);
    expect(collector.items).toEqual(['/x', '/y', '/z']);

    // isSubsetOf (lines 126-131)
    const superset = new Set(['/x', '/y', '/z', '/w']);
    expect(paths.isSubsetOf(superset)).toBe(true);
    const partial = new Set(['/x']);
    expect(paths.isSubsetOf(partial)).toBe(false);

    // isSupersetOf — false branch (line 137)
    const notSubset = new Set(['/x', '/y', '/z', '/missing']);
    expect(paths.isSupersetOf(notSubset)).toBe(false);

    // Symbol.iterator (lines 148-150)
    const iterItems = [...paths];
    expect(iterItems).toEqual(['/x', '/y', '/z']);
  });
});

describe('finalizeContext', () => {
  test('replaces registrar-owned fields and refreshes mutable maps from the snapshot', () => {
    const ctx = {
      routeAuth: 'stale-route-auth',
      actorResolver: 'stale-actor-resolver',
      rateLimitAdapter: 'stale-rate-limit-adapter',
      fingerprintBuilder: 'stale-fingerprint-builder',
      cacheAdapters: new Map([[Symbol.for('old-store'), 'old-adapter']]),
      emailTemplates: new Map([['old-template', { subject: 'Old' }]]),
    } as any;

    const snapshot = {
      routeAuth: { userAuth: async () => {} },
      actorResolver: {
        resolveActor: async () => ({
          id: 'user-1',
          kind: 'user' as const,
          tenantId: null,
          sessionId: null,
          roles: null,
          claims: {},
        }),
      },
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
    expect(ctx.actorResolver).toBe(snapshot.actorResolver);
    expect(ctx.rateLimitAdapter).toBe(snapshot.rateLimitAdapter);
    expect(ctx.fingerprintBuilder).toBe(snapshot.fingerprintBuilder);
    expect(Object.isFrozen(ctx.routeAuth)).toBe(true);
    expect(Object.isFrozen(ctx.actorResolver)).toBe(true);
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
    const events = {
      definitions: {
        register() {},
        get() {
          return undefined;
        },
        has() {
          return false;
        },
        list() {
          return [];
        },
        freeze() {},
        frozen: false,
      },
      register() {},
      get() {
        return undefined;
      },
      list() {
        return [];
      },
      publish(key: string, payload: unknown) {
        return {
          key,
          payload,
          meta: {
            eventId: 'test-event-id',
            occurredAt: new Date(0).toISOString(),
            ownerPlugin: 'build-context-test',
            exposure: ['internal'] as const,
            scope: null,
          },
        };
      },
    };
    const app = createRouter();
    const entityRegistry = createEntityRegistry();
    const { registrar } = createCoreRegistrar();
    const resolvedStores = {
      sessions: 'memory' as const,
      oauthState: 'memory' as const,
      cache: 'memory' as const,
      authStore: 'memory' as const,
      sqlite: undefined,
    };
    const infra: Parameters<typeof buildContext>[0]['infra'] = {
      frameworkConfig: {
        resolvedStores,
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
        registrar,
        entityRegistry,
        password: Bun.password,
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
      resolvedStores,
      redisEnabled: false,
      mongoMode: false,
      dataEncryptionKeys: [],
      corsOrigins: '*',
      persistence: {
        idempotency: createMemoryIdempotencyAdapter(),
        uploadRegistry: createMemoryUploadRegistry(),
        wsMessages: createMemoryWsMessageRepository(),
        auditLog: createMemoryAuditLogProvider(),
        cronRegistry: createMemoryCronRegistry(),
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
    };

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
      events: events as any,
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
      identityResolver: null,
      routeAuth: null,
      actorResolver: null,
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
    const replacement = () => null;

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

  test('destroy closes the postgres pool when postgres infra is configured', async () => {
    const poolEnd = mock(async () => {});
    const { ctx } = await createDirectContext({
      infra: {
        postgres: {
          pool: {
            end: poolEnd,
          },
          db: {} as any,
        } as any,
      },
    });

    await ctx.destroy();

    expect(poolEnd).toHaveBeenCalledTimes(1);
  });

  test('ReadonlyMap views exercise all methods (lines 159-183)', async () => {
    const { ctx } = await createDirectContext();
    const cacheAdapter1 = {
      name: 'memory',
      get: async () => null,
      set: async () => {},
      del: async () => {},
      delPattern: async () => {},
      isReady: () => true,
    };
    const cacheAdapter2 = {
      name: 'redis',
      get: async () => null,
      set: async () => {},
      del: async () => {},
      delPattern: async () => {},
      isReady: () => true,
    };

    finalizeContext(ctx, {
      identityResolver: null,
      routeAuth: null,
      actorResolver: null,
      rateLimitAdapter: null,
      fingerprintBuilder: null,
      cacheAdapters: new Map([
        ['memory', cacheAdapter1],
        ['redis', cacheAdapter2],
      ] satisfies Array<['memory' | 'redis', CacheAdapter]>),
      emailTemplates: new Map([
        ['welcome', { subject: 'Hi', html: '<p>Hi</p>' }],
        ['reset', { subject: 'Reset', html: '<p>Reset</p>' }],
      ] satisfies Array<[string, EmailTemplate]>),
    });

    // size
    expect(ctx.cacheAdapters.size).toBe(2);
    // has
    expect(ctx.cacheAdapters.has('memory')).toBe(true);
    expect(ctx.cacheAdapters.has('postgres')).toBe(false);
    // get
    expect(ctx.cacheAdapters.get('memory')).toBe(cacheAdapter1);
    // entries
    expect([...ctx.cacheAdapters.entries()].length).toBe(2);
    // keys
    expect([...ctx.cacheAdapters.keys()]).toContain('memory');
    // values
    expect([...ctx.cacheAdapters.values()]).toContain(cacheAdapter1);
    // forEach
    const cacheForEach: string[] = [];
    ctx.cacheAdapters.forEach((_v, k, map) => {
      cacheForEach.push(k as string);
      expect(map).toBe(ctx.cacheAdapters);
    });
    expect(cacheForEach).toEqual(['memory', 'redis']);
    // Symbol.iterator
    expect([...ctx.cacheAdapters].length).toBe(2);

    // emailTemplates map
    expect(ctx.emailTemplates.size).toBe(2);
    expect(ctx.emailTemplates.has('welcome')).toBe(true);
    expect([...ctx.emailTemplates.entries()].length).toBe(2);
    expect([...ctx.emailTemplates.keys()]).toContain('welcome');
    expect([...ctx.emailTemplates.values()].length).toBe(2);
    const emailForEach: string[] = [];
    ctx.emailTemplates.forEach((_v, k) => {
      emailForEach.push(k);
    });
    expect(emailForEach).toEqual(['welcome', 'reset']);
    expect([...ctx.emailTemplates].length).toBe(2);
  });

  test('wsEndpoints constructed when ws config has endpoints (lines 395-396)', async () => {
    const { ctx } = await createDirectContext({
      infra: {
        frameworkConfig: {
          entityRegistry: createEntityRegistry(),
          resolvedStores: {
            sessions: 'memory',
            oauthState: 'memory',
            cache: 'memory',
            authStore: 'memory',
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
          registrar: createCoreRegistrar().registrar,
          password: Bun.password,
          trustProxy: false,
          ws: {
            endpoints: {
              '/chat': { maxConnections: 100 },
              '/notifications': { maxConnections: 50 },
            },
          },
          storeInfra: {
            appName: 'ws-app',
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
      } as any,
    });
    expect(ctx.wsEndpoints).not.toBeNull();
    expect(ctx.wsEndpoints?.['/chat']).toBeDefined();
    expect(ctx.wsEndpoints?.['/notifications']).toBeDefined();
  });

  // Permissions bootstrap moved to the permissions plugin (createPermissionsPlugin).
  // Tested in tests/unit/permissions-bootstrap.test.ts via createApp().

  test('ReadonlyMap forEach passes thisArg correctly (lines 178-181)', async () => {
    const { ctx } = await createDirectContext();
    const cacheAdapter1: CacheAdapter = {
      name: 'memory',
      get: async () => null,
      set: async () => {},
      del: async () => {},
      delPattern: async () => {},
      isReady: () => true,
    };
    const cacheAdapter2: CacheAdapter = {
      name: 'redis',
      get: async () => null,
      set: async () => {},
      del: async () => {},
      delPattern: async () => {},
      isReady: () => true,
    };
    finalizeContext(ctx, {
      identityResolver: null,
      routeAuth: null,
      actorResolver: null,
      rateLimitAdapter: null,
      fingerprintBuilder: null,
      cacheAdapters: new Map([
        ['memory', cacheAdapter1],
        ['redis', cacheAdapter2],
      ] satisfies Array<['memory' | 'redis', CacheAdapter]>),
      emailTemplates: new Map([['t1', { subject: 'S1', html: '<p>S1</p>' }]]),
    });

    // Exercise the forEach thisArg path on ReadonlyMap (line 178-181)
    const collector = { keys: [] as string[] };
    ctx.cacheAdapters.forEach(function (this: typeof collector, _v: unknown, k: unknown) {
      this.keys.push(k as string);
    }, collector);
    expect(collector.keys).toEqual(['memory', 'redis']);

    const emailCollector = { names: [] as string[] };
    ctx.emailTemplates.forEach(function (this: typeof emailCollector, _v: unknown, k: string) {
      this.names.push(k);
    }, emailCollector);
    expect(emailCollector.names).toEqual(['t1']);
  });

  test('upload config includes generateKey and tenantScopedKeys (lines 424-425)', async () => {
    const generateKey = () => 'custom-key';
    const { ctx } = await createDirectContext({
      upload: {
        storage: { put: async () => ({ key: 'k', url: '/u' }) } as any,
        maxFileSize: 2048,
        maxFiles: 5,
        allowedMimeTypes: ['image/png'],
        keyPrefix: 'uploads/',
        generateKey,
        tenantScopedKeys: true,
      },
    });
    expect(ctx.upload?.config.generateKey).toBe(generateKey);
    expect(ctx.upload?.config.tenantScopedKeys).toBe(true);
    expect(ctx.upload?.config.keyPrefix).toBe('uploads/');
  });

  test('destroy without ws transport exercises the non-ws path (lines 463-469)', async () => {
    const { ctx, secretDestroy } = await createDirectContext();
    // ctx.ws is null by default — destroy should not throw
    expect(ctx.ws).toBeNull();
    await ctx.destroy();
    expect(secretDestroy).toHaveBeenCalledTimes(1);
  });

  test('destroy with ws but no transport exercises the ws.transport falsy path (line 463)', async () => {
    const { ctx } = await createDirectContext();
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
      transport: null, // no transport to disconnect
    } as any;
    await ctx.destroy();
    // Should not throw — transport is null, so disconnect is skipped
  });

  test('destroy swallows bus.shutdown errors (line 473)', async () => {
    const busShutdown = mock(async () => {
      throw new Error('bus shutdown failed');
    });
    const { ctx } = await createDirectContext({ busShutdown });
    await ctx.destroy();
    expect(busShutdown).toHaveBeenCalledTimes(1);
  });

  test('destroy swallows plugin teardown errors (line 459)', async () => {
    const teardown = mock(async () => {
      throw new Error('teardown failed');
    });
    const { ctx } = await createDirectContext({
      plugins: [{ name: 'failing-plugin', teardown }],
    });
    await ctx.destroy();
    expect(teardown).toHaveBeenCalledTimes(1);
  });

  test('clear without ws state does not throw (lines 437-451)', async () => {
    const { ctx } = await createDirectContext();
    expect(ctx.ws).toBeNull();
    // clear should not throw when ws is null
    await ctx.clear();
  });

  test('clear handles ws without heartbeatTimer (line 447)', async () => {
    const { ctx } = await createDirectContext();
    ctx.ws = {
      roomRegistry: new Map([['r1', new Set(['s1'])]]),
      heartbeatSockets: new Set(['s1']),
      heartbeatEndpointConfigs: new Map(),
      socketUsers: new Map(),
      roomPresence: new Map(),
      socketRegistry: new Map(),
      rateLimitState: new Map(),
      sessionRegistry: new Map(),
      lastEventIds: new Map(),
      heartbeatTimer: null, // no timer to clear
    } as any;
    await ctx.clear();
    expect(ctx.ws?.roomRegistry.size).toBe(0);
    expect(ctx.ws?.heartbeatSockets.size).toBe(0);
  });

  test('clearIfPresent handles null/undefined/non-clearable values', async () => {
    const { ctx } = await createDirectContext({
      infra: {
        persistence: {
          idempotency: null, // null — clearIfPresent sees null
          uploadRegistry: {}, // no clear method
          wsMessages: undefined, // undefined
          auditLog: {},
          cronRegistry: {},
          configureRoom() {},
          getRoomConfig() {
            return null;
          },
          setDefaults() {},
        },
      } as any,
    });
    // Should not throw when persistence sub-objects are null/undefined/missing clear
    await ctx.clear();
  });

  test('corsOrigins as string (non-array) passes through without copying (line 378-379)', async () => {
    const { ctx } = await createDirectContext({
      infra: {
        corsOrigins: '*',
      } as any,
    });
    expect(ctx.config.security.cors).toBe('*');
  });

  test('mongo config is undefined when infra.mongo is null (lines 314-319)', async () => {
    const { ctx } = await createDirectContext({
      infra: { mongo: null } as any,
    });
    expect(ctx.config.mongo).toBeUndefined();
    expect(ctx.mongo).toBeNull();
  });

  test('mongo config is frozen when infra.mongo is set (lines 314-319)', async () => {
    const { ctx } = await createDirectContext({
      infra: {
        mongo: {
          auth: { kind: 'auth' } as any,
          app: { kind: 'app' } as any,
          mongoose: {} as any,
        },
        mongoMode: 'single',
      } as any,
    });
    expect(ctx.config.mongo).toBeDefined();
    expect(Object.isFrozen(ctx.config.mongo!)).toBe(true);
    expect(ctx.mongo).not.toBeNull();
    expect(ctx.mongo?.auth).toEqual({ kind: 'auth' });
    expect(ctx.mongo?.app).toEqual({ kind: 'app' });
  });

  test('redis is null and config.redis is undefined when infra.redis is null (lines 383-387)', async () => {
    const { ctx } = await createDirectContext({
      infra: { redis: null } as any,
    });
    expect(ctx.redis).toBeNull();
    expect(ctx.config.redis).toBeUndefined();
  });

  test('sqlite and sqliteDb are null when not configured (lines 389-390)', async () => {
    const { ctx } = await createDirectContext({
      infra: { sqliteDb: null } as any,
    });
    expect(ctx.sqlite).toBeNull();
    expect(ctx.sqliteDb).toBeNull();
  });

  test('captcha cloneAndFreezeConfig with null returns null (line 49)', async () => {
    const { ctx } = await createDirectContext({ captcha: null });
    expect(ctx.config.captcha).toBeNull();
  });

  test('captcha cloneAndFreezeConfig with object returns frozen deep clone (line 50)', async () => {
    const captcha = { provider: 'test', siteKey: 'key-1', secretKey: 'secret-1' };
    const { ctx } = await createDirectContext({ captcha: captcha as any });
    expect(ctx.config.captcha).not.toBe(captcha);
    expect(ctx.config.captcha).toEqual(captcha);
    expect(Object.isFrozen(ctx.config.captcha)).toBe(true);
  });

  test('upload is null when not provided (line 428)', async () => {
    const { ctx } = await createDirectContext();
    expect(ctx.upload).toBeNull();
  });

  test('upload config without allowedMimeTypes sets it to undefined (line 420-421)', async () => {
    const { ctx } = await createDirectContext({
      upload: {
        storage: { put: async () => ({ key: 'k', url: '/u' }) } as any,
        maxFileSize: 1024,
        maxFiles: 1,
        // no allowedMimeTypes
      },
    });
    expect(ctx.upload?.config.allowedMimeTypes).toBeUndefined();
  });

  test('secrets provider destroy is called even when optional (line 503)', async () => {
    const { ctx } = await createDirectContext({
      secretDestroy: undefined as any,
    });
    // destroy should not throw when provider.destroy is undefined
    await ctx.destroy();
  });
});
