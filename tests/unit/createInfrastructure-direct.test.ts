import { afterAll, beforeEach, describe, expect, mock, test } from 'bun:test';
import { createCoreRegistrar } from '@lastshotlabs/slingshot-core';

const mongooseModule = await import('mongoose');
const actualMongo = await import('@lib/mongo');
const actualRedis = await import('@lib/redis');

const connectPostgresMock = mock(async (connectionString: string, options?: unknown) => ({
  pool: {
    query: async () => ({ rows: [], rowCount: 0 }),
    connect: async () => ({
      query: async () => ({ rows: [], rowCount: 0 }),
      release: () => {},
    }),
  },
  connectionString,
  options,
}));
const connectRedisMock = mock(async () => ({ kind: 'redis-client' }));
const disconnectRedisMock = mock(async () => {});
const connectMongoMock = mock(async () => ({
  authConn: mongooseModule.createConnection(),
  appConn: mongooseModule.createConnection(),
  mongoose: mongooseModule,
}));
const connectAuthMongoMock = mock(async () => ({
  authConn: mongooseModule.createConnection(),
  mongoose: mongooseModule,
}));
const connectAppMongoMock = mock(async () => ({
  appConn: mongooseModule.createConnection(),
}));
const disconnectMongoMock = mock(async () => {});

mock.module('@lastshotlabs/slingshot-postgres', () => ({
  connectPostgres: connectPostgresMock,
}));
mock.module('@lib/mongo', () => ({
  ...actualMongo,
  connectMongo: connectMongoMock,
  connectAuthMongo: connectAuthMongoMock,
  connectAppMongo: connectAppMongoMock,
  disconnectMongo: disconnectMongoMock,
}));
mock.module('@lib/redis', () => ({
  ...actualRedis,
  connectRedis: connectRedisMock,
  disconnectRedis: disconnectRedisMock,
}));

function createRuntime(sqliteDb?: {
  run(sql: string, ...params: unknown[]): void;
  query<T = unknown>(
    sql: string,
  ): {
    get(...args: unknown[]): T | null;
    all(...args: unknown[]): T[];
    run(...args: unknown[]): void;
  };
  prepare<T = unknown>(
    sql: string,
  ): {
    get(...args: unknown[]): T | null;
    all(...args: unknown[]): T[];
    run(...args: unknown[]): { changes: number };
  };
  transaction<T>(fn: () => T): () => T;
  close(): void;
}) {
  const db =
    sqliteDb ??
    ({
      run() {},
      query() {
        return {
          get() {
            return null;
          },
          all() {
            return [];
          },
          run() {},
        };
      },
      prepare() {
        return {
          get() {
            return null;
          },
          all() {
            return [];
          },
          run() {
            return { changes: 0 };
          },
        };
      },
      transaction<T>(fn: () => T) {
        return () => fn();
      },
      close() {},
    } as const);

  return {
    password: {
      hash: async (plain: string) => `hash:${plain}`,
      verify: async () => true,
    },
    sqlite: {
      open: mock(() => db),
    },
    server: {
      listen: () => ({
        port: 0,
        stop() {},
      }),
    },
    fs: {
      write: async () => {},
      readFile: async () => null,
      exists: async () => false,
    },
    glob: {
      scan: async function* () {},
    },
    readFile: async () => null,
    supportsAsyncLocalStorage: true,
  };
}

async function loadCreateInfrastructure() {
  const mod = await import('../../src/framework/createInfrastructure');
  return mod.createInfrastructure;
}

function baseOptions(runtime = createRuntime()) {
  return {
    db: {
      mongo: false as const,
      redis: false,
      sessions: 'memory' as const,
      cache: 'memory' as const,
      auth: 'memory' as const,
    },
    securitySigning: { secret: 'test-secret-key-must-be-at-least-32-chars!!' },
    cors: { origin: ['https://api.example.com'], credentials: true },
    captcha: { provider: 'hcaptcha' as const, secretKey: 'test-secret' },
    csrf: { exemptPaths: ['/hooks/public'] },
    trustProxy: 2 as const,
    registrar: createCoreRegistrar().registrar,
    secrets: {
      jwtSecret: undefined,
      bearerToken: undefined,
      dataEncryptionKey: undefined,
      redisHost: undefined,
      redisUser: undefined,
      redisPassword: undefined,
      mongoUser: undefined,
      mongoPassword: undefined,
      mongoHost: undefined,
      mongoDb: undefined,
      mongoAuthUser: undefined,
      mongoAuthPassword: undefined,
      mongoAuthHost: undefined,
      mongoAuthDb: undefined,
    },
    runtime,
  };
}

function makeSingleMongoResult() {
  return {
    authConn: mongooseModule.createConnection(),
    appConn: mongooseModule.createConnection(),
    mongoose: mongooseModule,
  };
}

function makeSeparateMongoResult() {
  return {
    authConn: mongooseModule.createConnection(),
    appConn: mongooseModule.createConnection(),
    mongoose: mongooseModule,
  };
}

afterAll(() => {
  mock.restore();
});

beforeEach(() => {
  connectPostgresMock.mockClear();
  connectMongoMock.mockClear();
  connectAuthMongoMock.mockClear();
  connectAppMongoMock.mockClear();
  connectRedisMock.mockClear();
  disconnectRedisMock.mockClear();
  disconnectMongoMock.mockClear();
  const single = makeSingleMongoResult();
  const separate = makeSeparateMongoResult();
  connectMongoMock.mockResolvedValue(single);
  connectAuthMongoMock.mockResolvedValue({
    authConn: separate.authConn,
    mongoose: separate.mongoose,
  });
  connectAppMongoMock.mockResolvedValue({
    appConn: separate.appConn,
  });
  connectRedisMock.mockResolvedValue({ kind: 'redis-client' });
});

describe('createInfrastructure direct', () => {
  test('builds memory-backed persistence and room config defaults', async () => {
    const createInfrastructure = await loadCreateInfrastructure();

    const infra = await createInfrastructure(baseOptions());

    expect(infra.resolvedStores).toEqual({
      sessions: 'memory',
      oauthState: 'memory',
      cache: 'memory',
      authStore: 'memory',
      sqlite: undefined,
    });
    expect(infra.frameworkConfig.security.cors).toEqual(['https://api.example.com']);
    expect(Object.isFrozen(infra.frameworkConfig.security.cors)).toBe(true);
    expect(infra.frameworkConfig.security.csrf).toEqual({ exemptPaths: ['/hooks/public'] });
    expect(Object.isFrozen(infra.frameworkConfig.security.csrf?.exemptPaths)).toBe(true);
    expect(infra.frameworkConfig.trustProxy).toBe(2);
    expect(infra.frameworkConfig.captcha).toEqual({
      provider: 'hcaptcha',
      secretKey: 'test-secret',
    });
    expect(infra.frameworkConfig.storeInfra.appName).toBe('slingshot');
    expect(Object.isFrozen(infra.frameworkConfig.resolvedStores)).toBe(true);
    expect(Object.isFrozen(infra.frameworkConfig.dataEncryptionKeys)).toBe(true);

    infra.persistence.configureRoom('chat', 'general', { persist: true });
    expect(infra.persistence.getRoomConfig('chat', 'general')).toEqual({
      maxCount: 100,
      ttlSeconds: 86_400,
    });

    infra.persistence.setDefaults({ maxCount: 25 });
    infra.persistence.configureRoom('chat', 'support', { persist: true });
    expect(infra.persistence.getRoomConfig('chat', 'support')).toEqual({
      maxCount: 25,
      ttlSeconds: 86_400,
    });

    infra.persistence.configureRoom('chat', 'general', { persist: false });
    expect(infra.persistence.getRoomConfig('chat', 'general')).toBeNull();
  });

  test('opens sqlite when configured and exposes the sqlite store handle', async () => {
    const sqliteDb = {
      run() {},
      query() {
        return {
          get() {
            return null;
          },
          all() {
            return [];
          },
          run() {},
        };
      },
      prepare() {
        return {
          get() {
            return null;
          },
          all() {
            return [];
          },
          run() {
            return { changes: 0 };
          },
        };
      },
      transaction<T>(fn: () => T) {
        return () => fn();
      },
      close: mock(() => {}),
    };
    const runtime = createRuntime(sqliteDb as any);
    const createInfrastructure = await loadCreateInfrastructure();

    const infra = await createInfrastructure({
      ...baseOptions(runtime),
      db: {
        mongo: false,
        redis: false,
        sqlite: ':memory:',
        sessions: 'sqlite',
        cache: 'sqlite',
        auth: 'sqlite',
      },
    });

    expect(runtime.sqlite.open).toHaveBeenCalledWith(':memory:');
    expect(infra.sqliteDb).toBe(sqliteDb);
    expect(infra.resolvedStores.sqlite).toBe(':memory:');
    expect(infra.frameworkConfig.storeInfra.getSqliteDb()).toBe(sqliteDb);
  });

  test('storeInfra accessors fail fast when optional backends are unavailable', async () => {
    const createInfrastructure = await loadCreateInfrastructure();
    const infra = await createInfrastructure(baseOptions());

    expect(() => infra.frameworkConfig.storeInfra.getRedis()).toThrow(/Redis store selected/);
    expect(() => infra.frameworkConfig.storeInfra.getMongo()).toThrow(/Mongo store selected/);
    expect(() => infra.frameworkConfig.storeInfra.getSqliteDb()).toThrow(/SQLite store selected/);
    expect(() => infra.frameworkConfig.storeInfra.getPostgres()).toThrow(/Postgres store selected/);
  });

  test('throws when redis is enabled but REDIS_HOST is missing', async () => {
    const createInfrastructure = await loadCreateInfrastructure();

    await expect(
      createInfrastructure({
        ...baseOptions(),
        db: {
          mongo: false,
          redis: true,
          sessions: 'memory',
          cache: 'memory',
          auth: 'memory',
        },
      }),
    ).rejects.toThrow(/REDIS_HOST/);
  });

  test('throws when single mongo mode is missing required secrets', async () => {
    const createInfrastructure = await loadCreateInfrastructure();

    await expect(
      createInfrastructure({
        ...baseOptions(),
        db: {
          mongo: 'single',
          redis: false,
          sessions: 'memory',
          cache: 'memory',
          auth: 'memory',
        },
      }),
    ).rejects.toThrow(/db\.mongo="single"/);
  });

  test('connects single mongo mode and exposes the app mongo store handle', async () => {
    const single = makeSingleMongoResult();
    connectMongoMock.mockResolvedValueOnce(single);
    const createInfrastructure = await loadCreateInfrastructure();

    const infra = await createInfrastructure({
      ...baseOptions(),
      db: {
        mongo: 'single',
        redis: false,
        sessions: 'memory',
        cache: 'memory',
        auth: 'mongo',
      },
      secrets: {
        ...baseOptions().secrets,
        mongoUser: 'app-user',
        mongoPassword: 'app-pass',
        mongoHost: 'mongo.internal',
        mongoDb: 'slingshot',
      },
    });

    expect(connectMongoMock).toHaveBeenCalledWith({
      user: 'app-user',
      password: 'app-pass',
      host: 'mongo.internal',
      db: 'slingshot',
    });
    expect(infra.mongo?.auth).toBe(single.authConn);
    expect(infra.mongo?.app).toBe(single.appConn);
    expect(infra.mongo?.mongoose).toBe(mongooseModule);
    expect(infra.frameworkConfig.storeInfra.getMongo()).toEqual({
      conn: single.appConn,
      mg: mongooseModule,
    });
  });

  test('throws when separate mongo mode is missing app connection secrets', async () => {
    const createInfrastructure = await loadCreateInfrastructure();

    await expect(
      createInfrastructure({
        ...baseOptions(),
        db: {
          mongo: 'separate',
          redis: false,
          sessions: 'memory',
          cache: 'memory',
          auth: 'memory',
        },
        secrets: {
          ...baseOptions().secrets,
          mongoAuthUser: 'auth-user',
          mongoAuthPassword: 'auth-pass',
          mongoAuthHost: 'auth-host',
          mongoAuthDb: 'auth-db',
        },
      }),
    ).rejects.toThrow(/app connection is enabled/);
  });

  test('throws when separate mongo mode is missing auth connection secrets', async () => {
    const createInfrastructure = await loadCreateInfrastructure();

    await expect(
      createInfrastructure({
        ...baseOptions(),
        db: {
          mongo: 'separate',
          redis: false,
          sessions: 'memory',
          cache: 'memory',
          auth: 'memory',
        },
        secrets: {
          ...baseOptions().secrets,
          mongoUser: 'app-user',
          mongoPassword: 'app-pass',
          mongoHost: 'app-host',
          mongoDb: 'app-db',
        },
      }),
    ).rejects.toThrow(/auth connection is enabled/);
  });

  test('connects separate mongo mode and preserves auth and app connections', async () => {
    const separate = makeSeparateMongoResult();
    connectAuthMongoMock.mockResolvedValueOnce({
      authConn: separate.authConn,
      mongoose: mongooseModule,
    });
    connectAppMongoMock.mockResolvedValueOnce({
      appConn: separate.appConn,
    });
    const createInfrastructure = await loadCreateInfrastructure();

    const infra = await createInfrastructure({
      ...baseOptions(),
      db: {
        mongo: 'separate',
        redis: false,
        sessions: 'memory',
        cache: 'memory',
        auth: 'mongo',
      },
      secrets: {
        ...baseOptions().secrets,
        mongoUser: 'app-user',
        mongoPassword: 'app-pass',
        mongoHost: 'app-host',
        mongoDb: 'app-db',
        mongoAuthUser: 'auth-user',
        mongoAuthPassword: 'auth-pass',
        mongoAuthHost: 'auth-host',
        mongoAuthDb: 'auth-db',
      },
    });

    expect(connectAuthMongoMock).toHaveBeenCalledWith({
      user: 'auth-user',
      password: 'auth-pass',
      host: 'auth-host',
      db: 'auth-db',
    });
    expect(connectAppMongoMock).toHaveBeenCalledWith({
      user: 'app-user',
      password: 'app-pass',
      host: 'app-host',
      db: 'app-db',
    });
    expect(infra.mongo?.auth).toBe(separate.authConn);
    expect(infra.mongo?.app).toBe(separate.appConn);
    expect(infra.mongo?.mongoose).toBe(mongooseModule);
  });

  test('connects redis when enabled and passes through credentials', async () => {
    const createInfrastructure = await loadCreateInfrastructure();

    const infra = await createInfrastructure({
      ...baseOptions(),
      db: {
        mongo: false,
        redis: true,
        sessions: 'memory',
        cache: 'memory',
        auth: 'memory',
      },
      secrets: {
        ...baseOptions().secrets,
        redisHost: '127.0.0.1:6379',
        redisUser: 'slingshot',
        redisPassword: 'top-secret',
      },
    });

    expect(connectRedisMock).toHaveBeenCalledWith({
      host: '127.0.0.1:6379',
      user: 'slingshot',
      password: 'top-secret',
    });
    expect(infra.redis).toEqual({ kind: 'redis-client' } as any);
    expect(infra.frameworkConfig.redis).toEqual({ kind: 'redis-client' });
  });

  test('uses the postgres connector when db.postgres is configured', async () => {
    const createInfrastructure = await loadCreateInfrastructure();

    const infra = await createInfrastructure({
      ...baseOptions(),
      db: {
        mongo: false,
        redis: false,
        postgres: 'postgres://slingshot:test@localhost:5432/app',
        sessions: 'postgres',
        cache: 'postgres',
        auth: 'memory',
      },
    });

    expect(connectPostgresMock).toHaveBeenCalledWith('postgres://slingshot:test@localhost:5432/app', {
      pool: undefined,
      migrations: undefined,
      healthcheckTimeoutMs: undefined,
    });
    expect(infra.postgres).toMatchObject({
      connectionString: 'postgres://slingshot:test@localhost:5432/app',
    });
    expect(infra.frameworkConfig.storeInfra.getPostgres()).toBe(infra.postgres!);
  });

  test('passes postgres pool sizing and migration strategy through to the connector', async () => {
    const createInfrastructure = await loadCreateInfrastructure();

    await createInfrastructure({
      ...baseOptions(),
      db: {
        mongo: false,
        redis: false,
        postgres: 'postgres://slingshot:test@localhost:5432/app',
        postgresMigrations: 'assume-ready',
        postgresPool: {
          max: 24,
          min: 4,
          idleTimeoutMs: 15_000,
          connectionTimeoutMs: 2_000,
          queryTimeoutMs: 1_500,
          statementTimeoutMs: 1_200,
          maxUses: 500,
          allowExitOnIdle: true,
          keepAlive: true,
          keepAliveInitialDelayMillis: 3_000,
        },
        sessions: 'postgres',
        cache: 'postgres',
        auth: 'memory',
      },
    });

    expect(connectPostgresMock).toHaveBeenLastCalledWith(
      'postgres://slingshot:test@localhost:5432/app',
      {
        pool: {
          max: 24,
          min: 4,
          idleTimeoutMs: 15_000,
          connectionTimeoutMs: 2_000,
          queryTimeoutMs: 1_500,
          statementTimeoutMs: 1_200,
          maxUses: 500,
          allowExitOnIdle: true,
          keepAlive: true,
          keepAliveInitialDelayMillis: 3_000,
        },
        migrations: 'assume-ready',
        healthcheckTimeoutMs: 1_500,
      },
    );
  });

  test('disconnects opened mongo and redis handles when later bootstrap fails', async () => {
    const single = makeSingleMongoResult();
    const redisClient = { kind: 'redis-client' };
    connectMongoMock.mockResolvedValueOnce(single);
    connectRedisMock.mockResolvedValueOnce(redisClient as never);
    connectPostgresMock.mockRejectedValueOnce(new Error('postgres bootstrap failed'));
    const createInfrastructure = await loadCreateInfrastructure();

    await expect(
      createInfrastructure({
        ...baseOptions(),
        db: {
          mongo: 'single',
          redis: true,
          postgres: 'postgres://slingshot:test@localhost:5432/app',
          sessions: 'memory',
          cache: 'memory',
          auth: 'mongo',
        },
        secrets: {
          ...baseOptions().secrets,
          redisHost: '127.0.0.1:6379',
          mongoUser: 'app-user',
          mongoPassword: 'app-pass',
          mongoHost: 'mongo.internal',
          mongoDb: 'slingshot',
        },
      }),
    ).rejects.toThrow('postgres bootstrap failed');

    expect(disconnectRedisMock).toHaveBeenCalledTimes(1);
    expect(disconnectRedisMock).toHaveBeenCalledWith(redisClient);
    expect(disconnectMongoMock).toHaveBeenCalledTimes(1);
    expect(disconnectMongoMock).toHaveBeenCalledWith(single.authConn, single.appConn);
  });

  test('closes sqlite when persistence resolution fails after opening the database', async () => {
    const sqliteDb = {
      run() {},
      query() {
        return {
          get() {
            return null;
          },
          all() {
            return [];
          },
          run() {},
        };
      },
      prepare() {
        return {
          get() {
            return null;
          },
          all() {
            return [];
          },
          run() {
            return { changes: 0 };
          },
        };
      },
      transaction<T>(fn: () => T) {
        return () => fn();
      },
      close: mock(() => {}),
    };
    const runtime = createRuntime(sqliteDb as any);
    connectRedisMock.mockResolvedValueOnce(null as never);
    const createInfrastructure = await loadCreateInfrastructure();

    await expect(
      createInfrastructure({
        ...baseOptions(runtime),
        db: {
          mongo: false,
          redis: true,
          sqlite: ':memory:',
          sessions: 'memory',
          cache: 'memory',
          auth: 'memory',
        },
        secrets: {
          ...baseOptions(runtime).secrets,
          redisHost: '127.0.0.1:6379',
        },
      }),
    ).rejects.toThrow(/Redis store selected but Redis is unavailable/);

    expect(sqliteDb.close).toHaveBeenCalledTimes(1);
  });

  test('cleanup swallows postgres pool.end() error when bootstrap fails after postgres connects (lines 229-231)', async () => {
    // When postgres connects but a later step fails (bad data encryption key),
    // cleanupOpenInfrastructure calls postgresDb.pool.end(). If that throws,
    // the error is swallowed (best-effort).
    const poolEndMock = mock(async () => { throw new Error('pg pool.end failed'); });
    connectPostgresMock.mockResolvedValueOnce({
      pool: {
        end: poolEndMock,
        query: async () => ({ rows: [], rowCount: 0 }),
        connect: async () => ({
          query: async () => ({ rows: [], rowCount: 0 }),
          release: () => {},
        }),
      },
      connectionString: 'postgres://test',
    } as any);
    const createInfrastructure = await loadCreateInfrastructure();

    await expect(
      createInfrastructure({
        ...baseOptions(),
        db: {
          mongo: false,
          redis: false,
          postgres: 'postgres://test',
          sessions: 'memory',
          cache: 'memory',
          auth: 'memory',
        },
        secrets: {
          ...baseOptions().secrets,
          // Bad format: no colon separator — triggers getDataEncryptionKeys error
          dataEncryptionKey: 'bad-key-no-colon',
        },
      }),
    ).rejects.toThrow(/getDataEncryptionKeys/);

    // pool.end() was called during cleanup and its error was swallowed
    expect(poolEndMock).toHaveBeenCalledTimes(1);
  });

  test('cleanup swallows postgres pool.end() error during rollback (lines 229-231)', async () => {
    const poolEndMock = mock(async () => { throw new Error('pg pool end failed'); });
    connectPostgresMock.mockResolvedValueOnce({
      pool: {
        end: poolEndMock,
        query: async () => ({ rows: [], rowCount: 0 }),
        connect: async () => ({
          query: async () => ({ rows: [], rowCount: 0 }),
          release: () => {},
        }),
      },
      connectionString: 'postgres://test',
    } as any);
    // Make Redis connect return null so persistence resolution fails
    connectRedisMock.mockResolvedValueOnce(null as never);
    const createInfrastructure = await loadCreateInfrastructure();

    await expect(
      createInfrastructure({
        ...baseOptions(),
        db: {
          mongo: false,
          redis: true,
          postgres: 'postgres://test',
          sessions: 'memory',
          cache: 'memory',
          auth: 'memory',
        },
        secrets: {
          ...baseOptions().secrets,
          redisHost: '127.0.0.1:6379',
        },
      }),
    ).rejects.toThrow(/Redis store selected but Redis is unavailable/);

    // pool.end() was called and the error was swallowed
    expect(poolEndMock).toHaveBeenCalledTimes(1);
  });
});
