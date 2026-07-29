import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { Pool, type PoolClient } from 'pg';
import type { EventEnvelope, PackageDomainRouteContext } from '@lastshotlabs/slingshot-core';
import { createInProcessAdapter, definePackage, domain, route } from '@lastshotlabs/slingshot-core';
import {
  createCompositeFactories,
  defineEntity,
  entity,
  field,
  op,
} from '@lastshotlabs/slingshot-entity';
import { createApp } from '../../src/app';
import { getContextStoreInfra } from '../../src/framework/persistence/internalRepoResolution';

const CONNECTION =
  process.env.TEST_POSTGRES_URL ?? 'postgresql://postgres:postgres@localhost:5433/slingshot_test';

const Account = defineEntity('ScopedTransactionAccount', {
  namespace: 'phase4',
  fields: {
    id: field.string({ primary: true }),
    label: field.string(),
  },
});

const Journal = defineEntity('ScopedTransactionJournal', {
  namespace: 'phase4',
  fields: {
    id: field.string({ primary: true }),
    accountId: field.string(),
    message: field.string(),
  },
});

const compositeOperations = {
  createPair: op.transaction({
    steps: [
      {
        op: 'create',
        entity: 'accounts',
        input: { id: 'param:accountId', label: 'param:label' },
      },
      {
        op: 'create',
        entity: 'journals',
        input: {
          id: 'param:journalId',
          accountId: 'param:accountId',
          message: 'param:message',
        },
      },
    ],
  }),
};
const compositeFactories = createCompositeFactories(
  {
    accounts: { config: Account },
    journals: { config: Journal },
  },
  compositeOperations,
);
const accountModule = entity({
  config: Account,
  operations: compositeOperations,
  wiring: { mode: 'factories', factories: compositeFactories, entityKey: 'accounts' },
});
const journalModule = entity({
  config: Journal,
  wiring: { mode: 'factories', factories: compositeFactories, entityKey: 'journals' },
});

describe('PostgreSQL package-scoped transactions (docker)', () => {
  const schema = `slingshot_phase4_${randomUUID().replaceAll('-', '_')}`;
  const quotedSchema = `"${schema}"`;
  const adminPool = new Pool({ connectionString: CONNECTION });
  let appResult: Awaited<ReturnType<typeof createApp>> | undefined;
  let checkoutCount = 0;
  const transactionQueries: string[] = [];

  beforeAll(async () => {
    await adminPool.query(`CREATE SCHEMA ${quotedSchema}`);
    const scopedUrl = new URL(CONNECTION);
    scopedUrl.searchParams.set('options', `-c search_path=${schema}`);

    const transactionPackage = definePackage({
      name: 'phase4-transactions',
      entities: [accountModule, journalModule],
      domains: [
        domain({
          name: 'commands',
          basePath: '/phase4',
          routes: [
            route.post({
              path: '/commit',
              auth: 'none',
              async handler(ctx: PackageDomainRouteContext) {
                const suffix = randomUUID();
                return ctx.transactions.run('postgres', async scope => {
                  const accounts = ctx.entities.get(accountModule, { scope });
                  const journals = ctx.entities.get(journalModule, { scope });
                  await accounts.create({ id: `account-${suffix}`, label: 'committed' });
                  await ctx.transactions.run('postgres', async nestedScope => {
                    if (nestedScope !== scope) throw new Error('nested scope identity changed');
                    await journals.create({
                      id: `journal-${suffix}`,
                      accountId: `account-${suffix}`,
                      message: 'committed',
                    });
                  });
                  return ctx.respond.json({
                    scopeStable: true,
                    rawClientExposed:
                      Reflect.has(scope, 'client') ||
                      Reflect.has(scope, 'query') ||
                      Reflect.has(scope, 'pool'),
                  });
                });
              },
            }),
            route.post({
              path: '/declarative',
              auth: 'none',
              async handler(ctx: PackageDomainRouteContext) {
                const suffix = randomUUID();
                const results = await ctx.entities.get(accountModule).createPair({
                  accountId: `account-${suffix}`,
                  journalId: `journal-${suffix}`,
                  label: 'declarative',
                  message: 'declarative',
                });
                return ctx.respond.json({ steps: results.length });
              },
            }),
            route.post({
              path: '/rollback',
              auth: 'none',
              async handler(ctx: PackageDomainRouteContext) {
                const suffix = randomUUID();
                return ctx.transactions.run('postgres', async scope => {
                  await ctx.entities
                    .get(accountModule, { scope })
                    .create({ id: `account-${suffix}`, label: 'rolled-back' });
                  await ctx.entities.get(journalModule, { scope }).create({
                    id: `journal-${suffix}`,
                    accountId: `account-${suffix}`,
                    message: 'rolled-back',
                  });
                  throw new Error('injected package-service failure');
                });
              },
            }),
            route.post({
              path: '/caught-abort',
              auth: 'none',
              async handler(ctx: PackageDomainRouteContext) {
                return ctx.transactions.run('postgres', async scope => {
                  const accounts = ctx.entities.get(accountModule, { scope });
                  await accounts.create({ id: 'caught-duplicate', label: 'first' });
                  try {
                    await accounts.create({ id: 'caught-duplicate', label: 'duplicate' });
                  } catch {
                    // The provider must still reject the outer callback as rollback-only.
                  }
                  return ctx.respond.json({ incorrectlyCommitted: true });
                });
              },
            }),
            route.post({
              path: '/outbox-commit',
              auth: 'none',
              async handler(ctx: PackageDomainRouteContext) {
                const suffix = randomUUID();
                return ctx.transactions.run('postgres', async scope => {
                  await ctx.entities
                    .get(accountModule, { scope })
                    .create({ id: `outbox-${suffix}`, label: 'outbox-committed' });
                  ctx.events.publish(
                    'app:ready',
                    { plugins: ['outbox-committed'] },
                    { requestTenantId: null, delivery: 'outbox', transaction: scope },
                  );
                  return ctx.respond.json({ ok: true });
                });
              },
            }),
            route.post({
              path: '/outbox-rollback',
              auth: 'none',
              async handler(ctx: PackageDomainRouteContext) {
                const suffix = randomUUID();
                return ctx.transactions.run('postgres', async scope => {
                  await ctx.entities
                    .get(accountModule, { scope })
                    .create({ id: `outbox-${suffix}`, label: 'outbox-rolled-back' });
                  ctx.events.publish(
                    'app:ready',
                    { plugins: ['outbox-rolled-back'] },
                    { requestTenantId: null, delivery: 'outbox', transaction: scope },
                  );
                  throw new Error('rollback outbox');
                });
              },
            }),
          ],
        }),
      ],
    });

    const eventBus = Object.assign(createInProcessAdapter(), {
      async publishEnvelope(envelope: EventEnvelope) {
        return {
          eventId: envelope.meta.eventId,
          acceptedAt: new Date().toISOString(),
          transport: 'kafka' as const,
          durableDestinations: 1,
        };
      },
    });
    appResult = await createApp({
      meta: { name: 'Phase 4 PostgreSQL Transaction Test' },
      db: {
        mongo: false,
        redis: false,
        postgres: scopedUrl.toString(),
        sessions: 'memory',
        cache: 'memory',
        auth: 'postgres',
      },
      security: {
        rateLimit: { windowMs: 60_000, max: 1000 },
        signing: {
          secret: 'phase-4-postgres-transaction-test-secret',
          sessionBinding: false,
        },
      },
      logging: { onLog: () => {} },
      eventBus,
      events: {
        reliability: {
          store: 'postgres',
          outbox: { enabled: true },
        },
      },
      packages: [transactionPackage],
    });

    const infra = getContextStoreInfra(appResult.ctx);
    if (!infra) throw new Error('context StoreInfra was not attached');
    const pool = infra.getPostgres().pool;
    const instrumentedClients = new WeakSet<PoolClient>();
    const instrumentClient = (client: PoolClient): PoolClient => {
      if (!instrumentedClients.has(client)) {
        instrumentedClients.add(client);
        type QueryFunction = (query: unknown, ...args: unknown[]) => Promise<unknown>;
        const queryable = client as unknown as { query: QueryFunction };
        const originalQuery = queryable.query.bind(client);
        queryable.query = async (query: unknown, ...args: unknown[]): Promise<unknown> => {
          const sql = query;
          if (typeof sql === 'string') transactionQueries.push(sql);
          return originalQuery(query, ...args);
        };
      }
      return client;
    };
    type ConnectDone = (release?: unknown) => void;
    type ConnectCallback = (
      error: Error | undefined,
      client: PoolClient | undefined,
      done: ConnectDone,
    ) => void;
    type ConnectFunction = {
      (): Promise<PoolClient>;
      (callback: ConnectCallback): void;
    };
    const originalConnect = pool.connect.bind(pool) as unknown as ConnectFunction;
    const instrumentedConnect = (callback?: ConnectCallback): Promise<PoolClient> | void => {
      checkoutCount += 1;
      if (callback) {
        originalConnect((error, client, done) => {
          callback(error, client ? instrumentClient(client) : undefined, done);
        });
        return;
      }
      return originalConnect().then(instrumentClient);
    };
    pool.connect = instrumentedConnect as typeof pool.connect;
  });

  afterAll(async () => {
    await appResult?.ctx.destroy();
    await adminPool.query(`DROP SCHEMA IF EXISTS ${quotedSchema} CASCADE`);
    await adminPool.end();
  }, 15_000);

  async function rowCount(table: string): Promise<number> {
    const result = await adminPool.query<{ count: string }>(
      `SELECT COUNT(*) AS count FROM ${quotedSchema}."${table}"`,
    );
    return Number(result.rows[0]?.count ?? 0);
  }

  function resetTrace(): void {
    checkoutCount = 0;
    transactionQueries.length = 0;
  }

  test('commits and rolls back two typed entity adapters on one physical client', async () => {
    if (!appResult) throw new Error('app did not start');

    resetTrace();
    const committed = await appResult.app.request('/phase4/commit', { method: 'POST' });
    expect(committed.status).toBe(200);
    await expect(committed.json()).resolves.toEqual({
      scopeStable: true,
      rawClientExposed: false,
    });
    expect(checkoutCount).toBe(1);
    expect(transactionQueries.filter(query => query === 'BEGIN')).toHaveLength(1);
    expect(transactionQueries.filter(query => query === 'COMMIT')).toHaveLength(1);
    expect(transactionQueries).not.toContain('ROLLBACK');
    expect(await rowCount(`slingshot_${Account._storageName}`)).toBe(1);
    expect(await rowCount(`slingshot_${Journal._storageName}`)).toBe(1);

    resetTrace();
    const declarative = await appResult.app.request('/phase4/declarative', { method: 'POST' });
    expect(declarative.status).toBe(200);
    await expect(declarative.json()).resolves.toEqual({ steps: 2 });
    expect(checkoutCount).toBe(1);
    expect(transactionQueries.filter(query => query === 'BEGIN')).toHaveLength(1);
    expect(transactionQueries.filter(query => query === 'COMMIT')).toHaveLength(1);
    expect(transactionQueries).not.toContain('ROLLBACK');
    expect(await rowCount(`slingshot_${Account._storageName}`)).toBe(2);
    expect(await rowCount(`slingshot_${Journal._storageName}`)).toBe(2);

    resetTrace();
    const rolledBack = await appResult.app.request('/phase4/rollback', { method: 'POST' });
    expect(rolledBack.status).toBe(500);
    expect(checkoutCount).toBe(1);
    expect(transactionQueries.filter(query => query === 'BEGIN')).toHaveLength(1);
    expect(transactionQueries.filter(query => query === 'ROLLBACK')).toHaveLength(1);
    expect(transactionQueries).not.toContain('COMMIT');
    expect(await rowCount(`slingshot_${Account._storageName}`)).toBe(2);
    expect(await rowCount(`slingshot_${Journal._storageName}`)).toBe(2);
  });

  test('rolls back when a caught PostgreSQL error leaves the transaction aborted', async () => {
    if (!appResult) throw new Error('app did not start');

    resetTrace();
    const response = await appResult.app.request('/phase4/caught-abort', { method: 'POST' });
    expect(response.status).not.toBe(200);
    expect(checkoutCount).toBe(1);
    expect(transactionQueries.filter(query => query === 'BEGIN')).toHaveLength(1);
    expect(transactionQueries.filter(query => query === 'ROLLBACK')).toHaveLength(1);
    expect(transactionQueries).not.toContain('COMMIT');
    expect(await rowCount(`slingshot_${Account._storageName}`)).toBe(2);
  });

  test('commits and rolls back PostgreSQL domain and outbox rows atomically', async () => {
    if (!appResult) throw new Error('app did not start');
    const beforeAccounts = await rowCount(`slingshot_${Account._storageName}`);
    const beforeOutbox = await rowCount('slingshot_event_outbox');

    const committed = await appResult.app.request('/phase4/outbox-commit', { method: 'POST' });
    expect(committed.status).toBe(200);
    expect(await rowCount(`slingshot_${Account._storageName}`)).toBe(beforeAccounts + 1);
    expect(await rowCount('slingshot_event_outbox')).toBe(beforeOutbox + 1);

    const rolledBack = await appResult.app.request('/phase4/outbox-rollback', {
      method: 'POST',
    });
    expect(rolledBack.status).toBe(500);
    expect(await rowCount(`slingshot_${Account._storageName}`)).toBe(beforeAccounts + 1);
    expect(await rowCount('slingshot_event_outbox')).toBe(beforeOutbox + 1);
  });
});
