import { afterEach, describe, expect, mock, spyOn, test } from 'bun:test';
import { Hono } from 'hono';
import {
  InProcessAdapter,
  PERMISSIONS_STATE_KEY,
  attachContext,
  createEventDefinitionRegistry,
  createEventPublisher,
  getContext,
} from '@lastshotlabs/slingshot-core';
import { createMemoryStoreInfra } from '@lastshotlabs/slingshot-core/testing';
import { runPackageLifecycle } from '@lastshotlabs/slingshot-entity/testing';
import { createInteractionsPackage } from '../src/plugin';
import { INTERACTIONS_PLUGIN_STATE_KEY } from '../src/state';
import type { InteractionsPluginState } from '../src/state';
import { createFakeDispatcher } from '../src/testing';

let infoSpy: ReturnType<typeof spyOn> | null = null;

afterEach(() => {
  infoSpy?.mockRestore();
  infoSpy = null;
});

function createFakePermissionsState() {
  return {
    evaluator: {
      async can() {
        return true;
      },
    },
    registry: {
      register() {},
      getActionsForRole() {
        return [];
      },
      getDefinition() {
        return null;
      },
      listResourceTypes() {
        return [];
      },
    },
    adapter: {
      async createGrant() {
        return 'grant-1';
      },
      async revokeGrant() {
        return false;
      },
      async getGrantsForSubject() {
        return [];
      },
      async getEffectiveGrantsForSubject() {
        return [];
      },
      async listGrantHistory() {
        return [];
      },
      async listGrantsOnResource() {
        return [];
      },
      async deleteAllGrantsForSubject() {},
    },
  };
}

function createFakeChatPeer() {
  return {
    peerKind: 'chat' as const,
    async resolveMessageByKindAndId(_kind: string, id: string) {
      if (id !== 'msg-1') return null;
      return {
        components: [
          {
            type: 'actionRow',
            children: [
              {
                type: 'button',
                actionId: 'runtime:approve',
                label: 'Approve',
              },
            ],
          },
        ],
      };
    },
    async updateComponents() {},
  };
}

function attachInteractionsContext(app: Hono, bus: InProcessAdapter, withPermissions = true) {
  const events = createEventPublisher({
    definitions: createEventDefinitionRegistry(),
    bus,
  });
  const pluginState = new Map<string, unknown>([
    ['slingshot-chat', { interactionsPeer: createFakeChatPeer() }],
  ]);
  if (withPermissions) {
    pluginState.set(PERMISSIONS_STATE_KEY, createFakePermissionsState());
  }

  const ctx = {
    app,
    pluginState,
    rateLimitAdapter: {
      async trackAttempt() {
        return false;
      },
    },
    publicPaths: new Set<string>(),
    ws: null,
    wsEndpoints: {},
    wsPublish: null,
    bus,
    events,
    // Minimal route-auth registry so entity-generated `userAuth` routes (e.g.
    // GET /interactionEvents) can authorize from the `x-test-user` header.
    routeAuth: {
      userAuth: (async (c: never, next: () => Promise<void>) => {
        const ctxC = c as unknown as {
          req: { header(name: string): string | undefined };
          set(key: string, value: unknown): void;
          json(body: unknown, status: number): unknown;
        };
        const user = ctxC.req.header('x-test-user');
        if (!user) return ctxC.json({ error: 'Unauthorized' }, 401);
        ctxC.set(
          'actor',
          Object.freeze({
            id: user,
            kind: 'user' as const,
            tenantId: null,
            sessionId: null,
            roles: null,
            claims: {},
          }),
        );
        await next();
      }) as never,
    },
  };
  attachContext(app, ctx as never);

  app.use('*', async (c, next) => {
    const user = c.req.header('x-test-user');
    if (user) {
      c.set(
        'actor' as never,
        Object.freeze({
          id: user,
          kind: 'user' as const,
          tenantId: null,
          sessionId: null,
          roles: null,
          claims: {},
        }) as never,
      );
    }
    await next();
  });
}

function createFrameworkConfig() {
  const cfg = {
    resolvedStores: {
      sessions: 'memory',
      oauthState: 'memory',
      cache: 'memory',
      authStore: 'memory',
      sqlite: undefined,
    },
    security: { cors: '*' },
    signing: null,
    dataEncryptionKeys: [],
    redis: undefined,
    mongo: undefined,
    captcha: null,
    trustProxy: false,
    storeInfra: createMemoryStoreInfra(),
    entityRegistry: {
      register() {},
      getAll() {
        return [];
      },
      filter() {
        return [];
      },
    },
    password: Bun.password,
  };
  return cfg as never;
}

describe('createInteractionsPackage lifecycle', () => {
  test('setupMiddleware requires permissions state', async () => {
    const app = new Hono();
    const bus = new InProcessAdapter();
    attachInteractionsContext(app, bus, false);

    const plugin = createInteractionsPackage({});

    await expect(
      plugin.setupMiddleware?.({
        app: app as never,
        config: createFrameworkConfig(),
        bus,
        events: getContext(app).events,
      }),
    ).rejects.toThrow('Permissions state not found');
  });

  test('setupRoutes fails loudly when setupMiddleware was never run', async () => {
    const app = new Hono();
    const bus = new InProcessAdapter();
    attachInteractionsContext(app, bus, true);

    const plugin = createInteractionsPackage({});

    await expect(
      plugin.setupRoutes?.({
        app: app as never,
        config: createFrameworkConfig(),
        bus,
        events: getContext(app).events,
      }),
    ).rejects.toThrow('InteractionEvent adapter was not resolved during setupRoutes');
  });

  test('full lifecycle publishes state, accepts runtime handlers, and logs readiness', async () => {
    infoSpy = spyOn(console, 'info').mockImplementation(() => {});

    const app = new Hono();
    const bus = new InProcessAdapter();
    attachInteractionsContext(app, bus, true);

    const plugin = createInteractionsPackage({
      mountPath: '/interactions',
      handlers: {},
      rateLimit: { windowMs: 30_000, max: 5 },
    });

    // Drive the full package lifecycle (entity-plugin path included) so the
    // InteractionEvent adapter resolves once and is shared into the dispatch
    // route via the module's `onAdapter` callback.
    await runPackageLifecycle(plugin, {
      app: app as never,
      config: createFrameworkConfig(),
      bus,
      events: getContext(app).events,
    });

    const ctxState = getContext(app).pluginState.get(INTERACTIONS_PLUGIN_STATE_KEY) as
      | InteractionsPluginState
      | undefined;
    expect(ctxState).toBeDefined();
    expect(ctxState?.peers.chat).not.toBeNull();
    expect(ctxState?.handlers.resolve('missing:action')).toBeNull();
    expect(ctxState?.rateLimitWindowMs).toBe(30_000);
    expect(ctxState?.rateLimitMax).toBe(5);
    expect(ctxState?.events.get('interactions:event.dispatched')).toBeDefined();
    expect(ctxState?.events.get('interactions:event.failed')).toBeDefined();

    // The dispatch route received the shared InteractionEvent adapter.
    expect(ctxState?.repos.interactionEvents).not.toBeNull();

    // setupPost logged readiness.
    expect(infoSpy).toHaveBeenCalled();
    expect(infoSpy?.mock.calls.at(-1)?.[1]).toBe('slingshot-interactions ready');

    // Runtime handlers can be registered after bootstrap and are dispatchable.
    const runtimeDispatch = mock(async () => ({
      status: 'ok' as const,
      message: 'handled',
      body: { ok: true },
    }));
    ctxState?.registerHandler(
      'runtime:',
      createFakeDispatcher(async payload => runtimeDispatch(payload)),
    );
    expect(ctxState?.handlers.resolve('runtime:approve')?.prefix).toBe('runtime:');

    const response = await app.request('http://slingshot.local/interactions/dispatch', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-test-user': 'user-1',
      },
      body: JSON.stringify({
        messageKind: 'chat:message',
        messageId: 'msg-1',
        actionId: 'runtime:approve',
      }),
    });
    await bus.drain();

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(runtimeDispatch).toHaveBeenCalledTimes(1);
  });

  test('regression: dispatched audit row is visible to the entity list route (shared store)', async () => {
    const app = new Hono();
    const bus = new InProcessAdapter();
    attachInteractionsContext(app, bus, true);

    const plugin = createInteractionsPackage({
      mountPath: '/interactions',
      handlers: {},
      rateLimit: { windowMs: 30_000, max: 5 },
    });

    await runPackageLifecycle(plugin, {
      app: app as never,
      config: createFrameworkConfig(),
      bus,
      events: getContext(app).events,
    });

    const ctxState = getContext(app).pluginState.get(INTERACTIONS_PLUGIN_STATE_KEY) as
      | InteractionsPluginState
      | undefined;
    ctxState?.registerHandler(
      'runtime:',
      createFakeDispatcher(async () => ({ status: 'ok' as const, message: 'ok', body: { ok: true } })),
    );

    // Dispatch writes an InteractionEvent audit row through the dispatch
    // route's adapter (state.repos.interactionEvents).
    const dispatchRes = await app.request('http://slingshot.local/interactions/dispatch', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-test-user': 'user-1' },
      body: JSON.stringify({
        messageKind: 'chat:message',
        messageId: 'msg-1',
        actionId: 'runtime:approve',
      }),
    });
    await bus.drain();
    expect(dispatchRes.status).toBe(200);

    // The entity's own list route reads through the framework-resolved adapter.
    // Before the fix, the dispatch write and this read hit divergent in-memory
    // stores, so the audit row was invisible here and `items` came back empty.
    const listRes = await app.request('http://slingshot.local/interactions/interactionEvents', {
      headers: { 'x-test-user': 'user-1' },
    });
    expect(listRes.status).toBe(200);
    const body = (await listRes.json()) as {
      items: Array<{ actionId: string; userId: string }>;
    };
    expect(body.items).toHaveLength(1);
    expect(body.items[0]).toMatchObject({ actionId: 'runtime:approve', userId: 'user-1' });
  });
});
