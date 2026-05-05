import { afterEach, describe, expect, test } from 'bun:test';
import type { MiddlewareHandler } from 'hono';
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
  RESOLVE_ENTITY_FACTORIES,
  attachContext,
  createEntityRegistry,
  createEventDefinitionRegistry,
  createEventPublisher,
} from '@lastshotlabs/slingshot-core';
import { createEntityFactories } from '@lastshotlabs/slingshot-entity';
import { createNotificationsTestAdapters } from '@lastshotlabs/slingshot-notifications/testing';
import { createPermissionRegistry } from '@lastshotlabs/slingshot-permissions';
import { createMemoryPermissionsAdapter } from '@lastshotlabs/slingshot-permissions/testing';
import { createChatPlugin } from '../../src/plugin';

type PgRow = Record<string, unknown>;
type PgQueryResult = { rows: PgRow[]; rowCount: number | null };

const BLOCK_TABLE = 'slingshot_chat_blocks';
const pluginsToTeardown = new Set<ReturnType<typeof createChatPlugin>>();

class FakeChatRoutePostgresPool {
  readonly queries: string[] = [];
  private readonly rows: PgRow[] = [];

  query(sql: string, params: unknown[] = []): Promise<PgQueryResult> {
    this.queries.push(sql);

    if (
      sql.startsWith('CREATE TABLE IF NOT EXISTS') ||
      sql.startsWith('CREATE INDEX IF NOT EXISTS') ||
      sql.startsWith('CREATE UNIQUE INDEX IF NOT EXISTS')
    ) {
      return Promise.resolve({ rows: [], rowCount: null });
    }

    if (sql.startsWith(`INSERT INTO ${BLOCK_TABLE} (`)) {
      const match = /^INSERT INTO [^(]+\(([^)]+)\) VALUES/.exec(sql);
      if (!match?.[1]) {
        throw new Error(`Unable to parse insert columns: ${sql}`);
      }

      const columns = match[1].split(',').map(column => column.trim());
      const row: PgRow = {};
      for (let i = 0; i < columns.length; i++) {
        row[columns[i] ?? `col_${i}`] = params[i];
      }

      const existingIndex = this.rows.findIndex(entry => entry.id === row.id);
      if (existingIndex >= 0) {
        this.rows[existingIndex] = row;
      } else {
        this.rows.push(row);
      }

      return Promise.resolve({ rows: [], rowCount: 1 });
    }

    if (sql === `SELECT * FROM ${BLOCK_TABLE} WHERE blocker_id = $1 ORDER BY id ASC LIMIT $2`) {
      const blockerId = String(params[0]);
      const limit = Number(params[1]);
      const rows = this.rows
        .filter(entry => String(entry.blocker_id) === blockerId)
        .sort((left, right) => String(left.id).localeCompare(String(right.id)))
        .slice(0, limit)
        .map(entry => ({ ...entry }));
      return Promise.resolve({ rows, rowCount: rows.length });
    }

    throw new Error(`Unhandled SQL: ${sql}`);
  }
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

function createFrameworkConfig(pool: FakeChatRoutePostgresPool) {
  const storeInfra: StoreInfra = {
    appName: 'chat-postgres-route-test',
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

async function createPostgresChatBlocksApp(): Promise<{
  app: Hono<AppEnv>;
  pool: FakeChatRoutePostgresPool;
}> {
  const pool = new FakeChatRoutePostgresPool();
  const plugin = createChatPlugin({ storeType: 'postgres', enablePresence: false });
  pluginsToTeardown.add(plugin);

  const app = new Hono<AppEnv>();
  const bus = new InProcessAdapter();
  const events = createEventPublisher({
    definitions: createEventDefinitionRegistry(),
    bus,
  });
  const frameworkConfig = createFrameworkConfig(pool);

  const pluginState = new Map<string, unknown>([
    ['slingshot:package:capabilities:slingshot-permissions', createPermissionsState()],
    [
      `${PACKAGE_CAPABILITIES_PREFIX}slingshot-notifications`,
      createNotificationsCapabilitiesSlot(),
    ],
  ]);

  attachContext(app, {
    pluginState,
    ws: null,
    wsEndpoints: {},
    wsPublish: null,
    capabilityProviders: new Map<string, string>([
      ['slingshot-permissions:evaluator', 'slingshot-permissions'],
      ['slingshot-permissions:registry', 'slingshot-permissions'],
      ['slingshot-permissions:adapter', 'slingshot-permissions'],
      ['slingshot-notifications:builderFactory', 'slingshot-notifications'],
      ['slingshot-notifications:deliveryRegistry', 'slingshot-notifications'],
    ]),
    bus,
  } as unknown as Parameters<typeof attachContext>[1]);

  const routeAuth = {
    userAuth: (async (c, next) => {
      const userId = c.req.header('x-user-id');
      if (!userId) {
        return c.json({ error: 'Unauthorized' }, 401);
      }
      const actor = Object.freeze({
        id: userId,
        kind: 'user' as const,
        tenantId: null,
        sessionId: null,
        roles: null,
        claims: {},
      });
      (c as typeof c & { set(key: string, value: unknown): void }).set('actor', actor);
      await next();
    }) as MiddlewareHandler,
    requireRole: () => (async (_c, next) => next()) as MiddlewareHandler,
  };

  app.use('*', async (c, next) => {
    const userId = c.req.header('x-user-id');
    if (userId) {
      const actor = Object.freeze({
        id: userId,
        kind: 'user' as const,
        tenantId: null,
        sessionId: null,
        roles: null,
        claims: {},
      });
      (c as typeof c & { set(key: string, value: unknown): void }).set('actor', actor);
    }
    (c as typeof c & { set(key: string, value: unknown): void }).set('slingshotCtx', { routeAuth });
    await next();
  });

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

  return { app, pool };
}

afterEach(() => {
  for (const plugin of pluginsToTeardown) {
    plugin.teardown?.();
  }
  pluginsToTeardown.clear();
});

describe('chat postgres block routes', () => {
  test('POST /chat/blocks uses auth-scoped blockerId and GET /chat/blocks returns only caller rows', async () => {
    const { app, pool } = await createPostgresChatBlocksApp();

    const firstCreate = await app.request('/chat/blocks', {
      method: 'POST',
      headers: {
        'x-user-id': 'user-1',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ blockedId: 'user-2' }),
    });

    expect(firstCreate.status).toBe(201);
    const firstBlock = (await firstCreate.json()) as { blockerId: string; blockedId: string };
    expect(firstBlock.blockerId).toBe('user-1');
    expect(firstBlock.blockedId).toBe('user-2');

    const secondCreate = await app.request('/chat/blocks', {
      method: 'POST',
      headers: {
        'x-user-id': 'user-3',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ blockedId: 'user-4' }),
    });

    expect(secondCreate.status).toBe(201);

    const listForUser1 = await app.request('/chat/blocks', {
      method: 'GET',
      headers: { 'x-user-id': 'user-1' },
    });
    expect(listForUser1.status).toBe(200);
    const pageForUser1 = (await listForUser1.json()) as {
      items: Array<{ blockerId: string; blockedId: string }>;
      hasMore: boolean;
    };
    expect(pageForUser1.items).toHaveLength(1);
    expect(pageForUser1.items[0]).toMatchObject({
      blockerId: 'user-1',
      blockedId: 'user-2',
    });
    expect(pageForUser1.hasMore).toBe(false);

    const listForUser3 = await app.request('/chat/blocks', {
      method: 'GET',
      headers: { 'x-user-id': 'user-3' },
    });
    const pageForUser3 = (await listForUser3.json()) as {
      items: Array<{ blockerId: string; blockedId: string }>;
    };
    expect(pageForUser3.items).toHaveLength(1);
    expect(pageForUser3.items[0]).toMatchObject({
      blockerId: 'user-3',
      blockedId: 'user-4',
    });

    expect(pool.queries.some(sql => sql.startsWith(`INSERT INTO ${BLOCK_TABLE} (`))).toBe(true);
    expect(pool.queries).toContain(
      `SELECT * FROM ${BLOCK_TABLE} WHERE blocker_id = $1 ORDER BY id ASC LIMIT $2`,
    );
  });
});
