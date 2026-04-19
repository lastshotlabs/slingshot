import { beforeEach, describe, expect, mock, test } from 'bun:test';

const queryMock = mock(async (_sql: string) => ({ rows: [{ ok: 1 }], rowCount: 1 }));
const drizzleMock = mock((pool: unknown) => ({ kind: 'drizzle', pool }));
const drizzleNameSymbol = Symbol.for('drizzle:Name');

class MockPool {
  static instances: MockPool[] = [];
  options: unknown;

  constructor(options: unknown) {
    this.options = options;
    MockPool.instances.push(this);
  }

  query(sql: string) {
    return queryMock(sql);
  }
}

mock.module('pg', () => ({
  Pool: MockPool,
}));

mock.module('drizzle-orm/node-postgres', () => ({
  drizzle: (pool: unknown) => drizzleMock(pool),
}));

beforeEach(() => {
  MockPool.instances.length = 0;
  queryMock.mockClear();
  drizzleMock.mockClear();
});

describe('slingshot-postgres connection helpers', () => {
  test('connectPostgres eagerly verifies the pool and returns the drizzle handle', async () => {
    const { connectPostgres } = await import(`../src/connection.ts?connection=${Date.now()}`);

    const result = await connectPostgres('postgresql://db.example/app');

    expect(MockPool.instances).toHaveLength(1);
    expect(MockPool.instances[0]?.options).toEqual({
      connectionString: 'postgresql://db.example/app',
    });
    expect(queryMock).toHaveBeenCalledWith('SELECT 1');
    expect(drizzleMock).toHaveBeenCalledWith(MockPool.instances[0]);
    expect(result.pool).toBe(MockPool.instances[0]);
    expect(result.db).toEqual({ kind: 'drizzle', pool: MockPool.instances[0] });
    expect(typeof result.healthCheck).toBe('function');
    expect(typeof result.getStats).toBe('function');
    expect(result.getStats()).toMatchObject({
      migrationMode: 'apply',
      queryCount: 1,
      errorCount: 0,
      totalCount: 0,
      idleCount: 0,
      waitingCount: 0,
    });
  });

  test('connectPostgres passes pool sizing and migration options to the runtime', async () => {
    const { connectPostgres } = await import(`../src/connection.ts?pool=${Date.now()}`);

    const result = await connectPostgres('postgresql://db.example/app', {
      migrations: 'assume-ready',
      healthcheckTimeoutMs: 2500,
      pool: {
        max: 20,
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
    });

    expect(MockPool.instances[0]?.options).toEqual({
      connectionString: 'postgresql://db.example/app',
      max: 20,
      min: 4,
      idleTimeoutMillis: 15_000,
      connectionTimeoutMillis: 2_000,
      query_timeout: 1_500,
      statement_timeout: 1_200,
      maxUses: 500,
      allowExitOnIdle: true,
      keepAlive: true,
      keepAliveInitialDelayMillis: 3_000,
    });
    expect(result.getStats().migrationMode).toBe('assume-ready');
  });

  test('clearPostgresAuthTables truncates child tables before parent tables and re-exports connectPostgres', async () => {
    const schema = await import(`../src/schema.ts?schema=${Date.now()}`);
    const testing = await import(`../src/testing.ts?testing=${Date.now()}`);
    const deletedTables: unknown[] = [];

    await testing.clearPostgresAuthTables({
      db: {
        delete: async (table: unknown) => {
          deletedTables.push(table);
        },
      },
    } as never);

    expect(deletedTables.map(table => (table as Record<symbol, string>)[drizzleNameSymbol])).toEqual([
      (schema.groupMemberships as Record<symbol, string>)[drizzleNameSymbol],
      (schema.recoveryCodes as Record<symbol, string>)[drizzleNameSymbol],
      (schema.webauthnCredentials as Record<symbol, string>)[drizzleNameSymbol],
      (schema.oauthAccounts as Record<symbol, string>)[drizzleNameSymbol],
      (schema.userRoles as Record<symbol, string>)[drizzleNameSymbol],
      (schema.tenantRoles as Record<symbol, string>)[drizzleNameSymbol],
      (schema.groups as Record<symbol, string>)[drizzleNameSymbol],
      (schema.users as Record<symbol, string>)[drizzleNameSymbol],
    ]);
    expect(typeof testing.connectPostgres).toBe('function');
  });
});
