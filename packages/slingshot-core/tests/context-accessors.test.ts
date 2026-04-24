import { describe, expect, test } from 'bun:test';
import { Hono } from 'hono';
import { getAuthRuntimePeer, getAuthRuntimePeerOrNull } from '../src/authPeer';
import { getCacheAdapter, getCacheAdapterOrNull } from '../src/cache';
import { resolveContext } from '../src/context/contextAccess';
import { attachContext, getContext, getContextOrNull } from '../src/context/contextStore';
import { createCoreRegistrar } from '../src/coreRegistrar';
import { getEmailTemplate, getEmailTemplates } from '../src/emailTemplates';
import { getEmbedsPeer, getEmbedsPeerOrNull } from '../src/embedsPeer';
import { getNotificationsState, getNotificationsStateOrNull } from '../src/notificationsPeer';
import { getPermissionsState, getPermissionsStateOrNull } from '../src/permissions';
import {
  getPluginState,
  getPluginStateFromRequest,
  getPluginStateOrNull,
} from '../src/pluginState';
import { getPushFormatterPeer, getPushFormatterPeerOrNull } from '../src/pushPeer';
import { getFingerprintBuilder, getRateLimitAdapter } from '../src/rateLimit';
import {
  getRequestActorResolver,
  getRequestActorResolverOrNull,
} from '../src/requestActorResolver';
import { getRouteAuth, getRouteAuthOrNull } from '../src/routeAuth';
import { getSearchPluginRuntime, getSearchPluginRuntimeOrNull } from '../src/searchPluginRuntime';

function createMiddleware() {
  return (async (_c: unknown, next: () => Promise<void>) => {
    await next();
  }) as never;
}

function createCacheAdapter(name = 'memory') {
  return {
    name,
    async get(): Promise<string | null> {
      return null;
    },
    async set(): Promise<void> {},
    async del(): Promise<void> {},
    async delPattern(): Promise<void> {},
    isReady(): boolean {
      return true;
    },
  };
}

function createContextFixture(overrides: Record<string, unknown> = {}) {
  return {
    config: {},
    persistence: {},
    routeAuth: null,
    actorResolver: null,
    rateLimitAdapter: null,
    fingerprintBuilder: null,
    cacheAdapters: new Map(),
    emailTemplates: new Map(),
    pluginState: new Map(),
    ...overrides,
  };
}

describe('slingshot-core context accessors', () => {
  test('createCoreRegistrar drains registered dependencies into isolated snapshots', async () => {
    const { registrar, drain } = createCoreRegistrar();
    const routeAuth = {
      userAuth: createMiddleware(),
      requireRole: () => createMiddleware(),
      bearerAuth: createMiddleware(),
    };
    const actorResolver = {
      async resolveActorId(): Promise<string | null> {
        return 'user-1';
      },
    };
    const rateLimitAdapter = {
      async trackAttempt(): Promise<boolean> {
        return false;
      },
    };
    const fingerprintBuilder = {
      async buildFingerprint(): Promise<string> {
        return 'abc123def456';
      },
    };
    const cacheAdapter = createCacheAdapter();
    const template = {
      subject: 'Welcome',
      html: '<p>Hello</p>',
      text: 'Hello',
    };

    registrar.setRouteAuth(routeAuth);
    registrar.setRequestActorResolver(actorResolver);
    registrar.setRateLimitAdapter(rateLimitAdapter);
    registrar.setFingerprintBuilder(fingerprintBuilder);
    registrar.addCacheAdapter('memory', cacheAdapter);
    registrar.addEmailTemplates({ welcome: template });

    const snapshot = drain();
    expect(snapshot.routeAuth).toBe(routeAuth);
    expect(snapshot.actorResolver).toBe(actorResolver);
    expect(snapshot.rateLimitAdapter).toBe(rateLimitAdapter);
    expect(snapshot.fingerprintBuilder).toBe(fingerprintBuilder);
    expect(snapshot.cacheAdapters.get('memory')).toBe(cacheAdapter);
    expect(snapshot.emailTemplates.get('welcome')).toEqual(template);

    snapshot.cacheAdapters.set('redis', createCacheAdapter('redis'));
    snapshot.emailTemplates.set('other', { subject: 'Other', html: '<p>Other</p>' });

    const nextSnapshot = drain();
    expect(nextSnapshot.cacheAdapters.has('redis')).toBe(false);
    expect(nextSnapshot.emailTemplates.has('other')).toBe(false);
  });

  test('createCoreRegistrar freezes its API shape and rejects late registration after drain', () => {
    const { registrar, drain } = createCoreRegistrar();
    const routeAuth = {
      userAuth: createMiddleware(),
      requireRole: () => createMiddleware(),
      bearerAuth: createMiddleware(),
    };
    const cacheAdapter = createCacheAdapter();

    expect(Object.isFrozen(registrar)).toBe(true);

    registrar.setRouteAuth(routeAuth);
    registrar.addCacheAdapter('memory', cacheAdapter);

    const firstSnapshot = drain();
    expect(firstSnapshot.routeAuth).toBe(routeAuth);
    expect(firstSnapshot.cacheAdapters.get('memory')).toBe(cacheAdapter);

    expect(() => registrar.setRouteAuth(routeAuth)).toThrow('CoreRegistrar is finalized');
    expect(() => registrar.addCacheAdapter('redis', createCacheAdapter('redis'))).toThrow(
      'CoreRegistrar is finalized',
    );
    expect(() =>
      registrar.addEmailTemplates({
        welcome: { subject: 'Welcome', html: '<p>Hello</p>' },
      }),
    ).toThrow('CoreRegistrar is finalized');

    const secondSnapshot = drain();
    expect(secondSnapshot.routeAuth).toBe(routeAuth);
    expect(secondSnapshot.cacheAdapters.get('memory')).toBe(cacheAdapter);
    expect(secondSnapshot.cacheAdapters.has('redis')).toBe(false);
    expect(secondSnapshot.emailTemplates.has('welcome')).toBe(false);
  });

  test('attachContext exposes the context on the app and request middleware', async () => {
    const app = new Hono();
    const ctx = createContextFixture({ marker: 'ctx-1' });

    expect(getContextOrNull(app)).toBeNull();
    expect(() => getContext(app)).toThrow('SlingshotContext not found');

    attachContext(app, ctx as never);

    app.get('/ctx', c => {
      const requestCtx = c.get('slingshotCtx' as never) as { marker: string };
      return c.json({ marker: requestCtx.marker });
    });

    expect(getContext(app)).toBe(ctx);
    expect(getContextOrNull(app)).toBe(ctx);
    expect(resolveContext(app)).toBe(ctx);
    expect(resolveContext(ctx as never)).toBe(ctx);

    const response = await app.request('/ctx');
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ marker: 'ctx-1' });
  });

  test('resolveContext rejects lookalike objects that were never branded as framework context', () => {
    const lookalike = createContextFixture({ marker: 'not-really-context' });

    expect(() => resolveContext(lookalike as never)).toThrow('SlingshotContext not found');
  });

  test('attachContext rejects attaching a different context to the same app', () => {
    const app = new Hono();
    const firstCtx = createContextFixture({ marker: 'ctx-1' });
    const secondCtx = createContextFixture({ marker: 'ctx-2' });

    attachContext(app, firstCtx as never);

    expect(() => attachContext(app, secondCtx as never)).toThrow(
      'SlingshotContext is already attached',
    );
    expect(getContext(app)).toBe(firstCtx);
  });

  test('attachContext is idempotent when the same context is attached twice', () => {
    const app = new Hono();
    const ctx = createContextFixture({ marker: 'ctx-1' });

    attachContext(app, ctx as never);

    expect(() => attachContext(app, ctx as never)).not.toThrow();
    expect(getContext(app)).toBe(ctx);
  });

  test('pluginState accessors resolve from app, carrier, and request contexts', async () => {
    const app = new Hono();
    const permissionsState = {
      adapter: { createGrant() {} },
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
      evaluator: {
        can() {
          return Promise.resolve(true);
        },
      },
    };
    const pluginState = new Map([
      ['slingshot-auth', { adapter: {} }],
      [
        'slingshot-notifications',
        {
          createBuilder() {
            return {
              notify() {
                return Promise.resolve(null);
              },
              notifyMany() {
                return Promise.resolve([]);
              },
              schedule() {
                return Promise.resolve({
                  id: 'notification-1',
                  userId: 'user-1',
                  source: 'test',
                  type: 'test',
                  read: false,
                  dispatched: false,
                  priority: 'normal',
                  createdAt: new Date().toISOString(),
                });
              },
              cancel() {
                return Promise.resolve();
              },
            };
          },
          registerDeliveryAdapter() {},
        },
      ],
      [
        'slingshot-embeds',
        {
          unfurl(urls: string[]) {
            return Promise.resolve(urls.map(url => ({ url })));
          },
        },
      ],
      ['slingshot-permissions', permissionsState],
      [
        'slingshot-push',
        {
          registerFormatter() {},
        },
      ],
      [
        'slingshot-search',
        {
          ensureConfigEntity() {
            return Promise.resolve();
          },
          getSearchClient() {
            return null;
          },
        },
      ],
    ]);
    const ctx = createContextFixture({ pluginState });

    attachContext(app, ctx as never);

    expect(getPluginState(app)).toBe(pluginState);
    expect(getPluginStateOrNull(app)).toBe(pluginState);
    expect(getPluginState(ctx as never)).toBe(pluginState);
    expect(getPluginStateOrNull({ pluginState })).toBe(pluginState);
    expect(getAuthRuntimePeer(app)).toEqual({ adapter: {} });
    expect(getAuthRuntimePeerOrNull(app)).toEqual({ adapter: {} });
    expect(getEmbedsPeer(app)).toBe(pluginState.get('slingshot-embeds'));
    expect(getEmbedsPeerOrNull(app)).toBe(pluginState.get('slingshot-embeds'));
    expect(getNotificationsState(app)).toBe(pluginState.get('slingshot-notifications'));
    expect(getNotificationsStateOrNull(app)).toBe(pluginState.get('slingshot-notifications'));
    expect(getPermissionsState(app)).toBe(permissionsState);
    expect(getPermissionsStateOrNull(app)).toBe(permissionsState);
    expect(getPushFormatterPeer(app)).toBe(pluginState.get('slingshot-push'));
    expect(getPushFormatterPeerOrNull(app)).toBe(pluginState.get('slingshot-push'));
    expect(getSearchPluginRuntime(app)).toBe(pluginState.get('slingshot-search'));
    expect(getSearchPluginRuntimeOrNull(app)).toBe(pluginState.get('slingshot-search'));

    app.get('/plugin-state', c => {
      const requestPluginState = getPluginStateFromRequest(c as never);
      return c.json({ hasAuth: requestPluginState.has('slingshot-auth') });
    });

    const response = await app.request('/plugin-state');
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ hasAuth: true });
  });

  test('pluginState accessors fail loudly when no context is attached', () => {
    const app = new Hono();

    expect(getPluginStateOrNull(app)).toBeNull();
    expect(getAuthRuntimePeerOrNull(app)).toBeNull();
    expect(getEmbedsPeerOrNull(app)).toBeNull();
    expect(getNotificationsStateOrNull(app)).toBeNull();
    expect(getPermissionsStateOrNull(app)).toBeNull();
    expect(getPushFormatterPeerOrNull(app)).toBeNull();
    expect(getSearchPluginRuntimeOrNull(app)).toBeNull();
    expect(() => getPluginState(app)).toThrow('pluginState is not available for this app');
    expect(() => getAuthRuntimePeer(app)).toThrow(
      'auth runtime peer is not available in pluginState',
    );
    expect(() => getEmbedsPeer(app)).toThrow('embeds peer is not available in pluginState');
    expect(() => getNotificationsState(app)).toThrow(
      'notifications peer state is not available in pluginState',
    );
    expect(() => getPermissionsState(app)).toThrow(
      'permissions state is not available in pluginState',
    );
    expect(() => getPushFormatterPeer(app)).toThrow(
      'push formatter peer is not available in pluginState',
    );
    expect(() => getSearchPluginRuntime(app)).toThrow(
      'search runtime is not available in pluginState',
    );
  });

  test('route, user, cache, rate-limit, fingerprint, and email accessors read from context', async () => {
    const routeAuth = {
      userAuth: createMiddleware(),
      requireRole: () => createMiddleware(),
      bearerAuth: createMiddleware(),
    };
    const actorResolver = {
      async resolveActorId(): Promise<string | null> {
        return 'user-42';
      },
    };
    const rateLimitAdapter = {
      async trackAttempt(): Promise<boolean> {
        return true;
      },
    };
    const fingerprintBuilder = {
      async buildFingerprint(): Promise<string> {
        return 'f00dbabe1234';
      },
    };
    const cacheAdapter = createCacheAdapter();
    const template = { subject: 'Reset', html: '<p>Reset</p>' };
    const ctx = createContextFixture({
      routeAuth,
      actorResolver,
      rateLimitAdapter,
      fingerprintBuilder,
      cacheAdapters: new Map([['memory', cacheAdapter]]),
      emailTemplates: new Map([['password-reset', template]]),
    });
    const app = new Hono();

    attachContext(app, ctx as never);

    expect(getRouteAuth(ctx as never)).toBe(routeAuth);
    expect(getRouteAuthOrNull(ctx as never)).toBe(routeAuth);
    expect(getRequestActorResolver(ctx as never)).toBe(actorResolver);
    expect(getRequestActorResolverOrNull(ctx as never)).toBe(actorResolver);
    expect(getCacheAdapter(ctx as never, 'memory')).toBe(cacheAdapter);
    expect(getCacheAdapterOrNull(ctx as never, 'redis')).toBeNull();
    expect(getRateLimitAdapter(ctx as never)).toBe(rateLimitAdapter);
    expect(getFingerprintBuilder(ctx as never)).toBe(fingerprintBuilder);

    const templates = getEmailTemplates(ctx as never);
    expect(templates).toEqual({ 'password-reset': template });
    templates['password-reset'] = { subject: 'Mutated', html: '<p>Mutated</p>' };
    expect(getEmailTemplate(ctx as never, 'password-reset')).toEqual(template);
    expect(getEmailTemplate(ctx as never, 'missing')).toBeNull();

    await expect(actorResolver.resolveActorId(new Request('http://example.com'))).resolves.toBe(
      'user-42',
    );
    await expect(
      rateLimitAdapter.trackAttempt('login:127.0.0.1', { windowMs: 1000, max: 1 }),
    ).resolves.toBe(true);
    await expect(
      fingerprintBuilder.buildFingerprint(new Request('http://example.com')),
    ).resolves.toBe('f00dbabe1234');
  });

  test('throwing accessors fail loudly when the dependency was never registered', () => {
    const ctx = createContextFixture();
    const app = new Hono();

    attachContext(app, ctx as never);

    expect(() => getRouteAuth(ctx as never)).toThrow('No RouteAuthRegistry registered');
    expect(() => getRequestActorResolver(ctx as never)).toThrow(
      'No RequestActorResolver registered',
    );
    expect(() => getCacheAdapter(ctx as never, 'memory')).toThrow(
      'No CacheAdapter registered for store "memory"',
    );
    expect(() => getRateLimitAdapter(ctx as never)).toThrow('No RateLimitAdapter registered');
    expect(() => getFingerprintBuilder(ctx as never)).toThrow('No FingerprintBuilder registered');
  });
});
