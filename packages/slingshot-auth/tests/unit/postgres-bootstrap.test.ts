import { beforeEach, describe, expect, mock, test } from 'bun:test';
import { createMemoryAuthAdapter } from '../../src/adapters/memoryAuth';
import { authPluginConfigSchema } from '../../src/types/config';
import { makeEventBus } from '../helpers/runtime';

const connectPostgresMock = mock(async (connectionString: string, options?: unknown) => ({
  pool: {
    end: mock(async () => {}),
  },
  db: { kind: 'drizzle-db' },
  healthCheck: mock(async () => ({ ok: true, latencyMs: 1, checkedAt: new Date().toISOString() })),
  getStats: mock(() => ({
    migrationMode: 'assume-ready' as const,
    totalCount: 2,
    idleCount: 1,
    waitingCount: 0,
    queryCount: 3,
    errorCount: 0,
    averageQueryDurationMs: 4,
    maxQueryDurationMs: 6,
    lastErrorAt: null,
  })),
  connectionString,
  options,
}));
const createPostgresAdapterMock = mock(async ({ pool }: { pool: unknown }) =>
  Object.assign(createMemoryAuthAdapter(), {
    pool,
    setSuspended: mock(async () => {}),
    getSuspended: mock(async () => null),
  }),
);

mock.module('@lastshotlabs/slingshot-postgres', () => ({
  connectPostgres: connectPostgresMock,
  createPostgresAdapter: createPostgresAdapterMock,
}));

async function loadBootstrapAuth() {
  const mod = await import('../../src/bootstrap');
  return mod.bootstrapAuth;
}

describe('bootstrapAuth postgres wiring', () => {
  beforeEach(() => {
    connectPostgresMock.mockClear();
    createPostgresAdapterMock.mockClear();
  });

  test('accepts standalone postgres pool and migration settings in auth config', () => {
    const parsed = authPluginConfigSchema.safeParse({
      db: {
        auth: 'postgres',
        postgres: 'postgres://slingshot:test@localhost:5432/app',
        sessions: 'postgres',
        oauthState: 'postgres',
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
      },
    });

    expect(parsed.success).toBe(true);
  });

  test('uses the shared postgres connector for standalone auth bootstrap', async () => {
    const bootstrapAuth = await loadBootstrapAuth();
    const bus = makeEventBus();

    const result = await bootstrapAuth(
      {
        db: {
          auth: 'postgres',
          postgres: 'postgres://slingshot:test@localhost:5432/app',
          sessions: 'postgres',
          oauthState: 'postgres',
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
        },
        auth: {
          enabled: false,
          jwt: {
            issuer: 'http://localhost',
            audience: 'slingshot-tests',
          },
        },
      },
      bus,
      undefined,
      {
        signing: { secret: 'integration-test-signing-secret-1234567890' },
        dataEncryptionKeys: [],
        password: Bun.password,
      },
    );

    const postgresBundle = await connectPostgresMock.mock.results[0]!.value;

    expect(connectPostgresMock).toHaveBeenCalledWith(
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
    expect(createPostgresAdapterMock).toHaveBeenCalledWith({
      pool: postgresBundle.pool,
    });
    expect(result.stores.authStore).toBe('postgres');

    for (const teardown of result.teardownFns) {
      await teardown();
    }
  });
});
