import { describe, expect, test } from 'bun:test';
import { Hono } from 'hono';
import { attachContext, getContext } from '@lastshotlabs/slingshot-core';
import type {
  ResolvedPersistence,
  RoomPersistenceConfig,
  SlingshotContext,
  WsMessageDefaults,
} from '@lastshotlabs/slingshot-core';
import { createAuditLogProvider } from '../../src/framework/auditLog';
import { idempotent } from '../../src/framework/lib/idempotency';
import { createMemoryIdempotencyAdapter } from '../../src/framework/persistence/idempotency';
import { createMemoryUploadRegistry } from '../../src/framework/persistence/uploadRegistry';
import { createMemoryWsMessageRepository } from '../../src/framework/persistence/wsMessages';
import { createTestApp } from '../setup';

function createTestPersistence(): ResolvedPersistence {
  const DEFAULT_MAX_COUNT = 100;
  const DEFAULT_TTL_SECONDS = 86_400;
  let defaults: Required<WsMessageDefaults> = {
    maxCount: DEFAULT_MAX_COUNT,
    ttlSeconds: DEFAULT_TTL_SECONDS,
  };
  const roomConfigs = new Map<string, { maxCount: number; ttlSeconds: number }>();

  return {
    uploadRegistry: createMemoryUploadRegistry(),
    idempotency: createMemoryIdempotencyAdapter(),
    wsMessages: createMemoryWsMessageRepository(),
    auditLog: createAuditLogProvider({ store: 'memory' }),
    configureRoom(endpoint: string, room: string, options: RoomPersistenceConfig) {
      const key = `${endpoint}\0${room}`;
      if (!options.persist) {
        roomConfigs.delete(key);
        return;
      }
      roomConfigs.set(key, {
        maxCount: options.maxCount ?? defaults.maxCount,
        ttlSeconds: options.ttlSeconds ?? defaults.ttlSeconds,
      });
    },
    getRoomConfig(endpoint: string, room: string) {
      return roomConfigs.get(`${endpoint}\0${room}`) ?? null;
    },
    setDefaults(newDefaults: WsMessageDefaults) {
      defaults = {
        maxCount: newDefaults.maxCount ?? DEFAULT_MAX_COUNT,
        ttlSeconds: newDefaults.ttlSeconds ?? DEFAULT_TTL_SECONDS,
      };
    },
    cronRegistry: {
      async getAll() {
        return new Set<string>();
      },
      async save(_names: ReadonlySet<string>) {},
    },
  };
}

function createTestContext(app: object, signing: unknown = null): SlingshotContext {
  const persistence = createTestPersistence();
  const ctx = {
    app,
    config: {
      appName: 'test',
      resolvedStores: {
        sessions: 'memory',
        oauthState: 'memory',
        cache: 'memory',
        authStore: 'memory',
        sqlite: undefined,
      },
      security: { cors: '*' },
      signing,
      dataEncryptionKeys: [],
      redis: undefined,
      mongo: undefined,
      captcha: null,
    },
    redis: null,
    mongo: null,
    sqlite: null,
    signing,
    dataEncryptionKeys: [],
    ws: null,
    persistence,
    pluginState: new Map(),
    async clear() {},
    async destroy() {},
  } as unknown as SlingshotContext;
  attachContext(app, ctx);
  return ctx;
}

function buildApp(callCount: { n: number }, signing: unknown = null) {
  const app = new Hono();
  createTestContext(app, signing);
  app.use(async (c, next) => {
    const { getContext } = await import('@lastshotlabs/slingshot-core');
    (c as any).set('slingshotCtx', getContext(app));
    await next();
  });
  app.use('/order', idempotent());
  app.post('/order', async c => {
    callCount.n++;
    return c.json({ orderId: 'abc-123', count: callCount.n }, 201);
  });
  return app;
}

describe('idempotency middleware', () => {
  test('first request executes handler', async () => {
    const count = { n: 0 };
    const app = buildApp(count);
    const res = await app.request('/order', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'idempotency-key': 'key-001' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(201);
    expect(count.n).toBe(1);
    const body = await res.json();
    expect(body.orderId).toBe('abc-123');
  });

  test('duplicate request returns cached result without calling handler again', async () => {
    const count = { n: 0 };
    const app = buildApp(count);

    const req = () =>
      app.request('/order', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'idempotency-key': 'key-002' },
        body: JSON.stringify({}),
      });

    const res1 = await req();
    const res2 = await req();

    expect(count.n).toBe(1); // handler only called once
    expect(res2.status).toBe(201);
    const body = await res2.json();
    expect(body.count).toBe(1); // cached, not re-executed
  });

  test('different keys execute handler independently', async () => {
    const count = { n: 0 };
    const app = buildApp(count);

    await app.request('/order', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'idempotency-key': 'key-A' },
      body: JSON.stringify({}),
    });
    await app.request('/order', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'idempotency-key': 'key-B' },
      body: JSON.stringify({}),
    });

    expect(count.n).toBe(2);
  });

  test('no Idempotency-Key header — handler called normally', async () => {
    const count = { n: 0 };
    const app = buildApp(count);

    await app.request('/order', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    await app.request('/order', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });

    expect(count.n).toBe(2);
  });

  test('HMAC on: key is hashed before storage (different from raw key)', async () => {
    const signing = { idempotencyKeys: true, secret: 'test-secret-32-chars-long-xxxxxxx' };

    const count1 = { n: 0 };
    const app1 = buildApp(count1, signing);

    // With HMAC on, the stored key is a hash of "key-hmac"
    await app1.request('/order', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'idempotency-key': 'key-hmac' },
      body: JSON.stringify({}),
    });
    expect(count1.n).toBe(1);

    // Build new app (fresh memory store), turn HMAC off — raw key should not match the hash
    const count2 = { n: 0 };
    const app2 = buildApp(count2, null);

    await app2.request('/order', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'idempotency-key': 'key-hmac' },
      body: JSON.stringify({}),
    });
    expect(count2.n).toBe(1); // fresh store, executed

    // Build new app with HMAC on — hashed key doesn't match raw "anon:key-hmac"
    const count3 = { n: 0 };
    const app3 = buildApp(count3, signing);
    await app3.request('/order', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'idempotency-key': 'key-hmac' },
      body: JSON.stringify({}),
    });
    expect(count3.n).toBe(1); // hashed key is different — cache miss, executes again
  });

  test('HMAC off: raw key stored', async () => {
    const count = { n: 0 };
    const app = buildApp(count, null);

    await app.request('/order', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'idempotency-key': 'raw-key' },
      body: JSON.stringify({}),
    });
    await app.request('/order', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'idempotency-key': 'raw-key' },
      body: JSON.stringify({}),
    });

    expect(count.n).toBe(1); // second request cached
  });
});

describe('memory persistence clear support', () => {
  test('memory idempotency adapter clear() removes cached entries', async () => {
    const adapter = createMemoryIdempotencyAdapter();

    await adapter.set('key-clear', '{"ok":true}', 201, 60);
    expect(await adapter.get('key-clear')).not.toBeNull();

    await adapter.clear?.();

    expect(await adapter.get('key-clear')).toBeNull();
  });

  test('memory upload registry clear() removes registered uploads', async () => {
    const registry = createMemoryUploadRegistry();

    await registry.register({ key: 'upload-clear', createdAt: Date.now(), ownerUserId: 'user-1' });
    expect(await registry.get('upload-clear')).not.toBeNull();

    await registry.clear?.();

    expect(await registry.get('upload-clear')).toBeNull();
  });

  test('ctx.clear() resets memory idempotency and upload registry state', async () => {
    const app = await createTestApp();
    const ctx = getContext(app as unknown as object);

    await ctx.persistence.idempotency.set('ctx-key', '{"ok":true}', 201, 60);
    await ctx.persistence.uploadRegistry.register({
      key: 'ctx-upload',
      createdAt: Date.now(),
      ownerUserId: 'user-1',
    });

    expect(await ctx.persistence.idempotency.get('ctx-key')).not.toBeNull();
    expect(await ctx.persistence.uploadRegistry.get('ctx-upload')).not.toBeNull();

    await ctx.clear();

    expect(await ctx.persistence.idempotency.get('ctx-key')).toBeNull();
    expect(await ctx.persistence.uploadRegistry.get('ctx-upload')).toBeNull();
  });
});
