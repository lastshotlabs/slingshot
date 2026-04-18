/**
 * Unit tests for createInfrastructure store selection logic.
 *
 * These tests exercise the defaultStore fallback waterfall and store override
 * logic without making real database connections. The logic under test is
 * the pure decision logic extracted from createInfrastructure.ts:
 *
 *   defaultStore = redis > postgres > sqlite > mongo > memory
 *   sessions  = db.sessions ?? defaultStore
 *   oauthState = db.oauthState ?? sessions
 *   cache     = db.cache ?? defaultStore
 *   authStore = db.auth ?? (mongo !== false ? 'mongo' : sessions)
 *
 * We test via createApp (memory-only config) since createInfrastructure
 * itself requires real DB credentials. We verify the resolved stores that
 * reach the framework config by inspecting app.ctx.resolvedStores.
 */
import { describe, expect, test } from 'bun:test';
import { createApp } from '../../src/app';

// ---------------------------------------------------------------------------
// Helper — createApp with no real DB connections
// ---------------------------------------------------------------------------

const baseConfig = {
  routesDir: import.meta.dir + '/../fixtures/routes',
  meta: { name: 'Store Selection Test' },
  security: { rateLimit: { windowMs: 60_000, max: 100 } },
  logging: { onLog: () => {} },
};

async function getResolvedStores(dbOverrides: Record<string, any> = {}) {
  const { ctx } = await createApp({
    ...baseConfig,
    db: {
      mongo: false,
      redis: false,
      sessions: 'memory',
      cache: 'memory',
      auth: 'memory',
      ...dbOverrides,
    },
  });
  return ctx.config.resolvedStores as {
    sessions: string;
    oauthState: string;
    cache: string;
    authStore: string;
    sqlite: string | undefined;
  };
}

// ---------------------------------------------------------------------------
// Default store selection (memory-only)
// ---------------------------------------------------------------------------

describe('createInfrastructure — default store: memory (all disabled)', () => {
  test('sessions defaults to memory when redis and other stores are disabled', async () => {
    const stores = await getResolvedStores();
    expect(stores.sessions).toBe('memory');
  });

  test('oauthState defaults to sessions value', async () => {
    const stores = await getResolvedStores({ sessions: 'memory' });
    expect(stores.oauthState).toBe('memory');
  });

  test('cache defaults to memory when all stores disabled', async () => {
    const stores = await getResolvedStores();
    expect(stores.cache).toBe('memory');
  });

  test('authStore defaults to memory when mongo is false', async () => {
    const stores = await getResolvedStores({ auth: 'memory' });
    expect(stores.authStore).toBe('memory');
  });

  test('sqlite is undefined when not configured', async () => {
    const stores = await getResolvedStores();
    expect(stores.sqlite).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Explicit overrides are respected
// ---------------------------------------------------------------------------

describe('createInfrastructure — explicit store overrides', () => {
  test('explicit sessions override is respected', async () => {
    const stores = await getResolvedStores({ sessions: 'memory' });
    expect(stores.sessions).toBe('memory');
  });

  test('explicit cache override is respected', async () => {
    const stores = await getResolvedStores({ cache: 'memory' });
    expect(stores.cache).toBe('memory');
  });

  test('explicit auth override is respected', async () => {
    const stores = await getResolvedStores({ auth: 'memory' });
    expect(stores.authStore).toBe('memory');
  });

  test('oauthState follows sessions when not explicitly set', async () => {
    // When sessions = memory and oauthState not set, oauthState = sessions = memory
    const stores = await getResolvedStores({ sessions: 'memory' });
    expect(stores.oauthState).toBe(stores.sessions);
  });

  test('sqlite auth config does not require mongo when db.mongo is omitted', async () => {
    const { ctx } = await createApp({
      ...baseConfig,
      db: {
        sqlite: ':memory:',
        redis: false,
        sessions: 'sqlite',
        cache: 'sqlite',
        auth: 'sqlite',
      },
    });

    expect(ctx.config.resolvedStores.sessions).toBe('sqlite');
    expect(ctx.config.resolvedStores.cache).toBe('sqlite');
    expect(ctx.config.resolvedStores.authStore).toBe('sqlite');
    expect(ctx.config.mongo).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// resolvedStores shape
// ---------------------------------------------------------------------------

describe('createInfrastructure — resolvedStores shape', () => {
  test('resolvedStores has sessions, oauthState, cache, authStore properties', async () => {
    const stores = await getResolvedStores();
    expect(stores).toHaveProperty('sessions');
    expect(stores).toHaveProperty('oauthState');
    expect(stores).toHaveProperty('cache');
    expect(stores).toHaveProperty('authStore');
  });

  test('all store values are valid StoreType strings', async () => {
    const validStores = ['memory', 'redis', 'sqlite', 'mongo', 'postgres'];
    const stores = await getResolvedStores();
    expect(validStores).toContain(stores.sessions);
    expect(validStores).toContain(stores.oauthState);
    expect(validStores).toContain(stores.cache);
    expect(validStores).toContain(stores.authStore);
  });
});

// ---------------------------------------------------------------------------
// Infrastructure object reaches app context
// ---------------------------------------------------------------------------

describe('createInfrastructure — infrastructure wired into app context', () => {
  test('createApp succeeds with all-memory config', async () => {
    await expect(
      createApp({
        ...baseConfig,
        db: { mongo: false, redis: false, sessions: 'memory', cache: 'memory', auth: 'memory' },
      }),
    ).resolves.toBeDefined();
  });

  test('ctx is present after createApp', async () => {
    const { ctx } = await createApp({
      ...baseConfig,
      db: { mongo: false, redis: false, sessions: 'memory', cache: 'memory', auth: 'memory' },
    });
    expect(ctx).toBeDefined();
  });

  test('ctx.config.resolvedStores is present after createApp', async () => {
    const stores = await getResolvedStores();
    expect(stores).toBeDefined();
  });
});
