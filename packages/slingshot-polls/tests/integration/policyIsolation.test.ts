import { describe, expect, it } from 'bun:test';
import { Hono } from 'hono';
import type { MiddlewareHandler } from 'hono';
import type {
  AppEnv,
  CoreRegistrar,
  EntityRegistry,
  ResolvedEntityConfig,
  StoreInfra,
  StoreType,
} from '@lastshotlabs/slingshot-core';
import {
  InProcessAdapter,
  PERMISSIONS_STATE_KEY,
  attachContext,
  createEventDefinitionRegistry,
  createEventPublisher,
} from '@lastshotlabs/slingshot-core';
import { createPollsPlugin } from '../../src/plugin';

const memoryInfra = {} as unknown as StoreInfra;

function createTestFrameworkConfig() {
  const registeredEntities: ResolvedEntityConfig[] = [];
  const entityRegistry: EntityRegistry = {
    register(c: ResolvedEntityConfig) {
      registeredEntities.push(c);
    },
    getAll() {
      return registeredEntities;
    },
    filter(predicate: (e: ResolvedEntityConfig) => boolean) {
      return registeredEntities.filter(predicate);
    },
  };

  const registrar = {
    registerRouteAuth() {},
    build() {
      return { routeAuth: null, permissions: null };
    },
  } as unknown as CoreRegistrar;

  return {
    resolvedStores: {
      sessions: 'memory' as StoreType,
      oauthState: 'memory' as StoreType,
      cache: 'memory' as StoreType,
      authStore: 'memory' as StoreType,
      sqlite: undefined,
    },
    security: { cors: '*' },
    signing: null,
    dataEncryptionKeys: [],
    redis: undefined,
    mongo: undefined,
    captcha: null,
    trustProxy: false as const,
    storeInfra: memoryInfra,
    registrar,
    entityRegistry,
    password: Bun.password,
    registeredEntities,
  };
}

async function buildTestApp(plugin: ReturnType<typeof createPollsPlugin>) {
  const app = new Hono<AppEnv>();
  const bus = new InProcessAdapter();
  const events = createEventPublisher({
    definitions: createEventDefinitionRegistry(),
    bus,
  });
  const frameworkConfig = createTestFrameworkConfig();

  const pluginState = new Map<string, unknown>();
  pluginState.set(PERMISSIONS_STATE_KEY, {
    evaluator: {
      can() {
        return Promise.resolve(true);
      },
    },
    registry: {
      register() {},
      getAll() {
        return [];
      },
      get() {
        return undefined;
      },
    },
    adapter: null,
  });
  attachContext(app, {
    pluginState,
    ws: null,
    wsEndpoints: {},
    wsPublish: null,
    bus,
    events,
  } as unknown as Parameters<typeof attachContext>[1]);

  const routeAuth = {
    userAuth: (async (c, next) => {
      const uid = c.req.header('x-user-id');
      if (!uid) return c.json({ error: 'Unauthorized' }, 401);
      (c as typeof c & { set(key: string, value: unknown): void }).set('authUserId', uid);
      await next();
    }) as MiddlewareHandler,
    requireRole: () => ((_c, next) => next()) as MiddlewareHandler,
  };

  app.use('*', async (c, next) => {
    const uid = c.req.header('x-user-id');
    if (uid) {
      (c as typeof c & { set(key: string, value: unknown): void }).set('authUserId', uid);
    }
    const tid = c.req.header('x-tenant-id');
    if (tid) {
      (c as typeof c & { set(key: string, value: unknown): void }).set('tenantId', tid);
    }
    (c as typeof c & { set(key: string, value: unknown): void }).set('slingshotCtx', {
      routeAuth,
      events,
    });
    await next();
  });

  const ctx = {
    app,
    config: frameworkConfig as never,
    bus: bus as unknown as import('@lastshotlabs/slingshot-core').SlingshotEventBus,
    events,
  };
  await plugin.setupMiddleware?.(ctx);
  await plugin.setupRoutes?.(ctx);
  await plugin.setupPost?.(ctx);

  return app;
}

describe('policy behavioral isolation', () => {
  it('source type registered on plugin A is denied on plugin B', async () => {
    const pluginA = createPollsPlugin({ mountPath: '/polls', closeCheckIntervalMs: 0 });
    const pluginB = createPollsPlugin({ mountPath: '/polls', closeCheckIntervalMs: 0 });

    // Register allow-all handler only on plugin A.
    pluginA.registerSourceHandler('test:isolated', () => Promise.resolve({ allow: true }), 'poll');
    pluginA.registerSourceHandler('test:isolated', () => Promise.resolve({ allow: true }), 'vote');

    const appA = await buildTestApp(pluginA);
    const appB = await buildTestApp(pluginB);

    const body = JSON.stringify({
      sourceType: 'test:isolated',
      sourceId: 'src-1',
      scopeId: 'scope-1',
      question: 'Isolated?',
      options: ['Yes', 'No'],
    });
    const headers = {
      'content-type': 'application/json',
      'x-user-id': 'user-1',
    };

    // App A should allow the create (201).
    const resA = await appA.request('/polls/polls', { method: 'POST', headers, body });
    expect(resA.status).toBe(201);

    // App B should deny the create (403) — no handler registered for 'test:isolated'.
    const resB = await appB.request('/polls/polls', { method: 'POST', headers, body });
    expect(resB.status).toBe(403);
  });
});
