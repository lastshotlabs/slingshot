/**
 * Shared test harness for community plugin integration tests.
 *
 * Extracted to avoid duplicating the large setup block across files.
 * The `createCommunityHarness` factory in configDrivenPlugin.test.ts
 * is intentionally left independent; this file serves the new Phase 14 tests.
 */
import { Hono } from 'hono';
import { InProcessAdapter, attachContext } from '@lastshotlabs/slingshot-core';
import { createMemoryStoreInfra } from '@lastshotlabs/slingshot-core/testing';
import { createNotificationsTestAdapters } from '@lastshotlabs/slingshot-notifications/testing';
import { createCommunityPlugin } from '../../src/plugin';

export function createEvaluator() {
  const allowed = new Set();
  return {
    async can(_s, action) {
      return allowed.has(action);
    },
    grant(action) {
      allowed.add(action);
    },
    revoke(action) {
      allowed.delete(action);
    },
    clear() {
      allowed.clear();
    },
  };
}
function createRegistry() {
  const defs = new Map();
  return {
    register(def) {
      defs.set(def.resourceType, def);
    },
    getActionsForRole() {
      return [];
    },
    getDefinition(rt) {
      return defs.get(rt) ?? null;
    },
    listResourceTypes() {
      return Array.from(defs.values());
    },
  };
}
function createPermAdapter() {
  const grants = [];
  return {
    grants,
    async createGrant(grant) {
      const id = `g${grants.length + 1}`;
      grants.push({ ...grant, id, grantedAt: new Date() });
      return id;
    },
    async revokeGrant(grantId, revokedBy, tenantScope) {
      const grant = grants.find(c => c.id === grantId);
      if (!grant) return false;
      if (tenantScope !== undefined && grant.tenantId !== tenantScope) return false;
      grant.revokedAt = new Date();
      grant.revokedBy = revokedBy;
      return true;
    },
    async getGrantsForSubject(subjectId, subjectType, scope) {
      return grants.filter(
        g =>
          g.subjectId === subjectId &&
          (subjectType === undefined || g.subjectType === subjectType) &&
          (scope?.tenantId === undefined || g.tenantId === scope.tenantId) &&
          (scope?.resourceType === undefined || g.resourceType === scope.resourceType) &&
          (scope?.resourceId === undefined || g.resourceId === scope.resourceId),
      );
    },
    async getEffectiveGrantsForSubject() {
      return grants.filter(g => !g.revokedAt);
    },
    async listGrantHistory() {
      return grants;
    },
    async listGrantsOnResource(resourceType, resourceId, tenantId) {
      return grants.filter(
        g =>
          g.resourceType === resourceType &&
          g.resourceId === resourceId &&
          (tenantId === undefined || g.tenantId === tenantId),
      );
    },
    async deleteAllGrantsForSubject() {
      /* noop */
    },
  };
}
function createFrameworkConfig() {
  const registeredEntities = [];
  const entityRegistry = {
    register(c) {
      registeredEntities.push(c);
    },
    getAll() {
      return registeredEntities;
    },
    filter(predicate) {
      return registeredEntities.filter(predicate);
    },
  };
  const registrar = {
    registerRouteAuth() {},
    build() {
      return { routeAuth: null, permissions: null };
    },
  };
  return {
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
    registrar,
    entityRegistry,
    password: Bun.password,
    registeredEntities,
  };
}
export async function createHarness(opts) {
  const userId = opts?.userId ?? 'user-1';
  const evaluator = createEvaluator();
  const registry = createRegistry();
  const permAdapter = createPermAdapter();
  const notifications = createNotificationsTestAdapters();
  const bus = new InProcessAdapter();
  const frameworkConfig = createFrameworkConfig();
  const plugin = createCommunityPlugin({
    containerCreation: opts?.containerCreation ?? 'user',
    permissions: { evaluator, registry, adapter: permAdapter },
  });
  const app = new Hono();
  attachContext(app, {
    app,
    pluginState: new Map([
      [
        'slingshot-notifications',
        {
          config: Object.freeze({
            mountPath: '/notifications',
            sseEnabled: true,
            ssePath: '/notifications/sse',
            dispatcher: { enabled: true, intervalMs: 30_000, maxPerTick: 500 },
            rateLimit: {
              perSourcePerUserPerWindow: 100,
              windowMs: 3_600_000,
              backend: 'memory',
            },
            defaultPreferences: {
              pushEnabled: true,
              emailEnabled: true,
              inAppEnabled: true,
            },
          }),
          notifications: notifications.notifications,
          preferences: notifications.preferences,
          dispatcher: {
            start() {},
            stop() {},
            async tick() {
              return 0;
            },
          },
          createBuilder: ({ source }) => notifications.createBuilder(source),
          registerDeliveryAdapter() {},
        },
      ],
    ]),
    ws: null,
    wsEndpoints: {},
    wsPublish: null,
    bus,
  });
  const routeAuth = {
    userAuth: async (c, next) => {
      const uid = c.req.header('x-test-user') ?? userId;
      c.set('authUserId', uid);
      await next();
    },
    requireRole: () => async (_c, next) => next(),
  };
  app.use('*', async (c, next) => {
    const uid = c.req.header('x-test-user') ?? userId;
    c.set('authUserId', uid);
    c.set('slingshotCtx', { routeAuth });
    await next();
  });
  await plugin.setupMiddleware?.({ app, config: frameworkConfig, bus });
  await plugin.setupRoutes?.({ app, config: frameworkConfig, bus });
  await plugin.setupPost?.({ app, config: frameworkConfig, bus });
  if (opts?.grantAll) {
    for (const action of [
      'community:container.write',
      'community:container.read',
      'community:container.delete',
      'community:container.delete-content',
      'community:container.pin',
      'community:container.lock',
      'community:container.manage-members',
      'community:container.manage-moderators',
      'community:container.manage-owners',
      'community:container.apply-ban',
      'community:container.lift-ban',
      'community:container.review-report',
      'community:tag.write',
    ]) {
      evaluator.grant(action);
    }
  }
  return {
    app,
    bus,
    evaluator,
    notifications: notifications.notifications,
    async teardown() {
      await notifications.clear();
      await plugin.teardown?.();
    },
  };
}
/** JSON POST helper */
export function post(app, path, body, userId = 'user-1') {
  return app.request(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-test-user': userId },
    body: JSON.stringify(body),
  });
}
/** JSON PATCH helper */
export function patch(app, path, body, userId = 'user-1') {
  return app.request(path, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', 'x-test-user': userId },
    body: JSON.stringify(body),
  });
}
/** GET helper */
export function get(app, path, userId) {
  const headers = {};
  if (userId) headers['x-test-user'] = userId;
  return app.request(path, { method: 'GET', headers });
}
/** DELETE helper */
export function del(app, path, userId = 'user-1') {
  return app.request(path, {
    method: 'DELETE',
    headers: { 'x-test-user': userId },
  });
}
