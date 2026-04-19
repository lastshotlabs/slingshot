import { afterEach, describe, expect, mock, spyOn, test } from 'bun:test';
import { Hono } from 'hono';
import {
  InProcessAdapter,
  PERMISSIONS_STATE_KEY,
  attachContext,
  getContext,
} from '@lastshotlabs/slingshot-core';
import { createMemoryStoreInfra } from '@lastshotlabs/slingshot-core/testing';
import { createInteractionsPlugin } from '../src/plugin';
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
  };
  attachContext(app, ctx as never);

  app.use('*', async (c, next) => {
    const user = c.req.header('x-test-user');
    if (user) {
      c.set('authUserId' as never, user as never);
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

describe('createInteractionsPlugin lifecycle', () => {
  test('setupMiddleware requires permissions state', async () => {
    const app = new Hono();
    const bus = new InProcessAdapter();
    attachInteractionsContext(app, bus, false);

    const plugin = createInteractionsPlugin({});

    await expect(
      plugin.setupMiddleware?.({
        app: app as never,
        config: createFrameworkConfig(),
        bus,
      }),
    ).rejects.toThrow('Permissions state not found');
  });

  test('setupRoutes fails loudly when setupMiddleware was never run', async () => {
    const app = new Hono();
    const bus = new InProcessAdapter();
    attachInteractionsContext(app, bus, true);

    const plugin = createInteractionsPlugin({});

    await expect(
      plugin.setupRoutes?.({
        app: app as never,
        config: createFrameworkConfig(),
        bus,
      }),
    ).rejects.toThrow('InteractionEvent adapter was not resolved during setupRoutes');
  });

  test('full lifecycle publishes state, accepts runtime handlers, and logs readiness', async () => {
    infoSpy = spyOn(console, 'info').mockImplementation(() => {});

    const app = new Hono();
    const bus = new InProcessAdapter();
    attachInteractionsContext(app, bus, true);

    const plugin = createInteractionsPlugin({
      mountPath: '/interactions',
      handlers: {},
      rateLimit: { windowMs: 30_000, max: 5 },
    });

    await plugin.setupMiddleware?.({
      app: app as never,
      config: createFrameworkConfig(),
      bus,
    });

    const ctxState = getContext(app).pluginState.get(INTERACTIONS_PLUGIN_STATE_KEY) as
      | InteractionsPluginState
      | undefined;
    expect(ctxState).toBeDefined();
    expect(ctxState?.peers.chat).not.toBeNull();
    expect(ctxState?.handlers.resolve('missing:action')).toBeNull();
    expect(ctxState?.rateLimitWindowMs).toBe(30_000);
    expect(ctxState?.rateLimitMax).toBe(5);
    expect(bus.clientSafeKeys.has('interactions:event.dispatched')).toBe(true);
    expect(bus.clientSafeKeys.has('interactions:event.failed')).toBe(true);

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

    await plugin.setupRoutes?.({
      app: app as never,
      config: createFrameworkConfig(),
      bus,
    });
    expect(ctxState?.repos.interactionEvents).not.toBeNull();

    await plugin.setupPost?.({
      app: app as never,
      config: createFrameworkConfig(),
      bus,
    });

    expect(infoSpy).toHaveBeenCalled();
    expect(infoSpy?.mock.calls.at(-1)?.[1]).toBe('slingshot-interactions ready');

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
});
