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
  attachContext,
  createEventDefinitionRegistry,
  createEventPublisher,
} from '@lastshotlabs/slingshot-core';
import { createEntityPlugin } from '@lastshotlabs/slingshot-entity';
import type { EntityPluginEntry } from '@lastshotlabs/slingshot-entity';
import type { BareEntityAdapter } from '@lastshotlabs/slingshot-entity/routing';
import { Poll } from '../../src/entities/poll';
import { PollVote } from '../../src/entities/pollVote';
import { pollFactories, pollVoteFactories } from '../../src/entities/factories';
import { pollOperations, pollVoteOperations } from '../../src/operations/index';
import { createPollsPackage } from '../../src/plugin';

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

async function buildTestApp(plugin: ReturnType<typeof createPollsPackage>) {
  const app = new Hono<AppEnv>();
  const bus = new InProcessAdapter();
  const events = createEventPublisher({
    definitions: createEventDefinitionRegistry(),
    bus,
  });
  const frameworkConfig = createTestFrameworkConfig();

  const pluginState = new Map<string, unknown>();
  pluginState.set('slingshot:package:capabilities:slingshot-permissions', {
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
      (c as typeof c & { set(key: string, value: unknown): void }).set(
        'actor',
        Object.freeze({
          id: uid,
          kind: 'user' as const,
          tenantId: null,
          sessionId: null,
          roles: null,
          claims: {},
        }),
      );
      await next();
    }) as MiddlewareHandler,
    requireRole: () => ((_c, next) => next()) as MiddlewareHandler,
  };

  app.use('*', async (c, next) => {
    const uid = c.req.header('x-user-id');
    if (uid) {
      (c as typeof c & { set(key: string, value: unknown): void }).set(
        'actor',
        Object.freeze({
          id: uid,
          kind: 'user' as const,
          tenantId: null,
          sessionId: null,
          roles: null,
          claims: {},
        }),
      );
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

  // Mirror the manual lifecycle setup from `src/testing.ts` (this test was
  // written before the package-driven `createPollsTestApp` existed) — bypass
  // `createApp/compilePackages` but wire entity routes via `createEntityPlugin`
  // and feed the same adapter instances back into the package's onAdapter hooks.
  const sharedAdapters: { poll?: BareEntityAdapter; pollVote?: BareEntityAdapter } = {};
  const entityEntries: EntityPluginEntry[] = [
    {
      config: Poll,
      operations: pollOperations.operations,
      buildAdapter: (storeType, infra) => {
        sharedAdapters.poll = pollFactories[storeType](infra) as unknown as BareEntityAdapter;
        return sharedAdapters.poll;
      },
    },
    {
      config: PollVote,
      operations: pollVoteOperations.operations,
      buildAdapter: (storeType, infra) => {
        sharedAdapters.pollVote = pollVoteFactories[storeType](
          infra,
        ) as unknown as BareEntityAdapter;
        return sharedAdapters.pollVote;
      },
    },
  ];
  const entityPlugin = createEntityPlugin({
    name: 'slingshot-polls',
    mountPath: plugin.mountPath ?? '/polls',
    entities: entityEntries,
    middleware: plugin.middleware,
  });

  await plugin.setupMiddleware?.(ctx);
  await entityPlugin.setupMiddleware?.(ctx);
  await entityPlugin.setupRoutes?.(ctx);

  for (const entityModule of plugin.entities) {
    const impl = (entityModule as { implementation?: unknown }).implementation as
      | { wiring?: { mode?: string; onAdapter?: (adapter: BareEntityAdapter) => void } }
      | undefined;
    const wiring = impl?.wiring;
    if (wiring?.mode === 'factories') {
      if (entityModule.entityName === 'Poll' && sharedAdapters.poll) {
        wiring.onAdapter?.(sharedAdapters.poll);
      } else if (entityModule.entityName === 'PollVote' && sharedAdapters.pollVote) {
        wiring.onAdapter?.(sharedAdapters.pollVote);
      }
    }
  }

  await plugin.setupRoutes?.(ctx);
  await entityPlugin.setupPost?.(ctx);
  await plugin.setupPost?.(ctx);

  return app;
}

describe('policy behavioral isolation', () => {
  it('source type configured on package A is denied on package B', async () => {
    const pluginA = createPollsPackage({
      mountPath: '/polls',
      closeCheckIntervalMs: 0,
      sourceHandlers: { 'test:isolated': () => Promise.resolve({ allow: true }) },
      voteHandlers: { 'test:isolated': () => Promise.resolve({ allow: true }) },
    });
    const pluginB = createPollsPackage({ mountPath: '/polls', closeCheckIntervalMs: 0 });

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
