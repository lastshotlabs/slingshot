import { afterEach, describe, expect, test } from 'bun:test';
import type { Actor } from '@lastshotlabs/slingshot-core';
import {
  definePackage,
  domain,
  getPluginState,
  route,
} from '@lastshotlabs/slingshot-core';
import { createPermissionsPlugin } from '../../src/plugin';

const rootAppModulePath = '../../../../src/app';
const { createApp } = await import(rootAppModulePath);

type TestMiddlewareContext = {
  set(key: 'actor', value: Actor): void;
};
type TestNext = () => Promise<void>;

const baseConfig = {
  meta: { name: 'Permissions Route Guard Test App' },
  db: {
    mongo: false as const,
    redis: false,
    sessions: 'memory' as const,
    cache: 'memory' as const,
    auth: 'memory' as const,
  },
  security: {
    rateLimit: { windowMs: 60_000, max: 1000 },
    signing: {
      secret: 'test-secret-key-must-be-at-least-32-chars!!',
      sessionBinding: false as const,
    },
  },
  logging: { onLog: () => {} },
};

const userActor = (id: string, tenantId?: string): Actor =>
  Object.freeze({
    id,
    kind: 'user' as const,
    tenantId: tenantId ?? null,
    sessionId: null,
    roles: null,
    claims: Object.freeze({}),
  });

const serviceAccountActor = (id: string): Actor =>
  Object.freeze({
    id,
    kind: 'service-account' as const,
    tenantId: null,
    sessionId: null,
    roles: null,
    claims: Object.freeze({}),
  });

const createdContexts: Array<{ destroy(): Promise<void> }> = [];

afterEach(async () => {
  for (const ctx of createdContexts.splice(0)) {
    await ctx.destroy().catch(() => {});
  }
});

// Routes include `scope: { resourceType: 'post' }` so the evaluator knows which
// resource type to look up in the registry when resolving role → action mappings.
const postsPackage = definePackage({
  name: 'posts',
  domains: [
    domain({
      name: 'posts',
      basePath: '/posts',
      routes: [
        route.post({
          path: '/create',
          auth: 'none',
          permission: { requires: 'post:create', scope: { resourceType: 'post' } },
          handler: async ({ respond }) => respond.json({ created: true }, 201),
        }),
        route.get({
          path: '/public',
          auth: 'none',
          handler: async ({ respond }) => respond.json({ public: true }),
        }),
      ],
    }),
  ],
});

function setupPostRegistry(state: any) {
  state.registry.register({
    resourceType: 'post',
    actions: ['post:create', 'post:delete', 'post:moderate'],
    roles: {
      author: ['post:create', 'post:delete'],
      moderator: ['post:delete', 'post:moderate'],
    },
  });
}

describe('permissions route guard — HTTP level', () => {
  test('anonymous request with no actor → 403 on permission-guarded route', async () => {
    const result = await createApp({
      ...baseConfig,
      plugins: [createPermissionsPlugin()],
      packages: [postsPackage],
    });
    createdContexts.push(result.ctx);

    const res = await result.app.request('/posts/create', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(403);
  });

  test('authenticated actor without grant → 403', async () => {
    const result = await createApp({
      ...baseConfig,
      middleware: [
        async (c: TestMiddlewareContext, next: TestNext) => {
          c.set('actor', userActor('user-no-grant'));
          await next();
        },
      ],
      plugins: [createPermissionsPlugin()],
      packages: [postsPackage],
    });
    createdContexts.push(result.ctx);

    const state = getPluginState(result.app).get('slingshot:package:capabilities:slingshot-permissions') as any;
    setupPostRegistry(state);

    const res = await result.app.request('/posts/create', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(403);
  });

  test('authenticated actor with matching grant → passes through', async () => {
    const userId = 'user-with-grant';

    const result = await createApp({
      ...baseConfig,
      middleware: [
        async (c: TestMiddlewareContext, next: TestNext) => {
          c.set('actor', userActor(userId));
          await next();
        },
      ],
      plugins: [createPermissionsPlugin()],
      packages: [postsPackage],
    });
    createdContexts.push(result.ctx);

    const state = getPluginState(result.app).get('slingshot:package:capabilities:slingshot-permissions') as any;
    setupPostRegistry(state);
    await state.adapter.createGrant({
      subjectId: userId,
      subjectType: 'user',
      tenantId: null,
      resourceType: null,
      resourceId: null,
      roles: ['author'],
      effect: 'allow',
      grantedBy: 'test',
    });

    const res = await result.app.request('/posts/create', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(201);
  });

  test('or fallback — actor has fallback permission but not primary → passes through', async () => {
    const userId = 'user-moderator';

    const modPackage = definePackage({
      name: 'modposts',
      domains: [
        domain({
          name: 'modposts',
          basePath: '/modposts',
          routes: [
            route.delete({
              path: '/:id',
              auth: 'none',
              permission: {
                requires: 'post:delete',
                or: 'post:moderate',
                scope: { resourceType: 'post' },
              },
              handler: async ({ respond }) => respond.noContent(),
            }),
          ],
        }),
      ],
    });

    const result = await createApp({
      ...baseConfig,
      middleware: [
        async (c: TestMiddlewareContext, next: TestNext) => {
          c.set('actor', userActor(userId));
          await next();
        },
      ],
      plugins: [createPermissionsPlugin()],
      packages: [modPackage],
    });
    createdContexts.push(result.ctx);

    const state = getPluginState(result.app).get('slingshot:package:capabilities:slingshot-permissions') as any;
    state.registry.register({
      resourceType: 'post',
      actions: ['post:delete', 'post:moderate'],
      roles: {
        deleter: ['post:delete'],
        moderator: ['post:moderate'],
      },
    });
    // Grant moderator role only — not deleter; or-fallback should pass
    await state.adapter.createGrant({
      subjectId: userId,
      subjectType: 'user',
      tenantId: null,
      resourceType: null,
      resourceId: null,
      roles: ['moderator'],
      effect: 'allow',
      grantedBy: 'test',
    });

    const res = await result.app.request('/modposts/post-123', { method: 'DELETE' });
    expect(res.status).toBe(204);
  });

  test('unguarded route passes without an actor or permissions plugin', async () => {
    const result = await createApp({
      ...baseConfig,
      packages: [postsPackage],
    });
    createdContexts.push(result.ctx);

    const res = await result.app.request('/posts/public');
    expect(res.status).toBe(200);
  });

  test('no permissions plugin — permission field is ignored, route passes', async () => {
    // When no permissionsPlugin is registered, getPermissionsStateOrNull returns null
    // and evaluateRouteAuth skips permission enforcement entirely.
    const result = await createApp({
      ...baseConfig,
      packages: [postsPackage],
    });
    createdContexts.push(result.ctx);

    const res = await result.app.request('/posts/create', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(201);
  });

  test('deny grant overrides allow grant — actor is blocked', async () => {
    const userId = 'user-denied';

    const result = await createApp({
      ...baseConfig,
      middleware: [
        async (c: TestMiddlewareContext, next: TestNext) => {
          c.set('actor', userActor(userId));
          await next();
        },
      ],
      plugins: [createPermissionsPlugin()],
      packages: [postsPackage],
    });
    createdContexts.push(result.ctx);

    const state = getPluginState(result.app).get('slingshot:package:capabilities:slingshot-permissions') as any;
    setupPostRegistry(state);

    await state.adapter.createGrant({
      subjectId: userId,
      subjectType: 'user',
      tenantId: null,
      resourceType: null,
      resourceId: null,
      roles: ['author'],
      effect: 'allow',
      grantedBy: 'test',
    });
    // Explicit deny overrides allow
    await state.adapter.createGrant({
      subjectId: userId,
      subjectType: 'user',
      tenantId: null,
      resourceType: null,
      resourceId: null,
      roles: ['author'],
      effect: 'deny',
      grantedBy: 'admin',
    });

    const res = await result.app.request('/posts/create', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(403);
  });

  test('super-admin bypasses specific role checks', async () => {
    const userId = 'super-admin-user';

    const result = await createApp({
      ...baseConfig,
      middleware: [
        async (c: TestMiddlewareContext, next: TestNext) => {
          c.set('actor', userActor(userId));
          await next();
        },
      ],
      plugins: [createPermissionsPlugin()],
      packages: [postsPackage],
    });
    createdContexts.push(result.ctx);

    const state = getPluginState(result.app).get('slingshot:package:capabilities:slingshot-permissions') as any;
    setupPostRegistry(state);
    await state.adapter.createGrant({
      subjectId: userId,
      subjectType: 'user',
      tenantId: null,
      resourceType: null,
      resourceId: null,
      roles: ['super-admin'],
      effect: 'allow',
      grantedBy: 'bootstrap',
    });

    const res = await result.app.request('/posts/create', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(201);
  });
});
