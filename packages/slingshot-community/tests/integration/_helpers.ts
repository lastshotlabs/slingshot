/**
 * Shared test harness for community plugin integration tests.
 *
 * Extracted to avoid duplicating the large setup block across files.
 * The `createCommunityHarness` factory in configDrivenPlugin.test.ts
 * is intentionally left independent; this file serves the new Phase 14 tests.
 */
import { Hono } from 'hono';
import type { MiddlewareHandler } from 'hono';
import {
  InProcessAdapter,
  PERMISSIONS_STATE_KEY,
  RESOLVE_ENTITY_FACTORIES,
  attachContext,
} from '@lastshotlabs/slingshot-core';
import type {
  CoreRegistrar,
  EntityRegistry,
  PermissionEvaluator,
  PermissionGrant,
  PermissionRegistry,
  PermissionsAdapter,
  ResolvedEntityConfig,
  ResourceTypeDefinition,
  RouteAuthRegistry,
  SlingshotFrameworkConfig,
  StoreType,
  SubjectRef,
} from '@lastshotlabs/slingshot-core';
import { createMemoryStoreInfra } from '@lastshotlabs/slingshot-core/testing';
import { createEntityFactories } from '@lastshotlabs/slingshot-entity';
import { createNotificationsTestAdapters } from '@lastshotlabs/slingshot-notifications/testing';
import { createCommunityPlugin } from '../../src/plugin';

// ---------------------------------------------------------------------------
// Permission helpers
// ---------------------------------------------------------------------------

export interface PermissionMatrix {
  grant(action: string): void;
  revoke(action: string): void;
  clear(): void;
}

export function createEvaluator(): PermissionEvaluator & PermissionMatrix {
  const allowed = new Set<string>();
  return {
    async can(_s: SubjectRef, action: string): Promise<boolean> {
      return allowed.has(action);
    },
    grant(action: string) {
      allowed.add(action);
    },
    revoke(action: string) {
      allowed.delete(action);
    },
    clear() {
      allowed.clear();
    },
  };
}

function createRegistry(): PermissionRegistry {
  const defs = new Map<string, ResourceTypeDefinition>();
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

function createPermAdapter(): PermissionsAdapter & { grants: PermissionGrant[] } {
  const grants: PermissionGrant[] = [];
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

function createFrameworkConfig(): SlingshotFrameworkConfig & {
  registeredEntities: ResolvedEntityConfig[];
} {
  const registeredEntities: ResolvedEntityConfig[] = [];
  const entityRegistry: EntityRegistry = {
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
    trustProxy: false,
    storeInfra: (() => {
      const storeInfra = createMemoryStoreInfra();
      Reflect.set(storeInfra as object, RESOLVE_ENTITY_FACTORIES, createEntityFactories);
      return storeInfra;
    })(),
    registrar,
    entityRegistry,
    password: Bun.password,
    registeredEntities,
  };
}

// ---------------------------------------------------------------------------
// Harness type + factory
// ---------------------------------------------------------------------------

export interface CommunityHarness {
  app: PluginApp;
  bus: InProcessAdapter;
  evaluator: PermissionEvaluator & PermissionMatrix;
  notifications: ReturnType<typeof createNotificationsTestAdapters>['notifications'];
  teardown(): Promise<void>;
}

type PluginApp = Parameters<
  NonNullable<ReturnType<typeof createCommunityPlugin>['setupMiddleware']>
>[0]['app'];
type RequestApp = Pick<PluginApp, 'request'>;

export async function createHarness(opts?: {
  userId?: string;
  containerCreation?: 'admin' | 'user';
  grantAll?: boolean;
  usePluginStatePermissions?: boolean;
}): Promise<CommunityHarness> {
  const userId = opts?.userId ?? 'user-1';
  const evaluator = createEvaluator();
  const registry = createRegistry();
  const permAdapter = createPermAdapter();
  const notifications = createNotificationsTestAdapters();
  const bus = new InProcessAdapter();
  const frameworkConfig = createFrameworkConfig();

  const permissionsState = { evaluator, registry, adapter: permAdapter };
  const plugin = createCommunityPlugin({
    containerCreation: opts?.containerCreation ?? 'user',
  });

  const app = new Hono() as unknown as PluginApp;

  attachContext(app, {
    app,
    pluginState: new Map<string, unknown>([
      [PERMISSIONS_STATE_KEY, permissionsState] as const,
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
          createBuilder: ({ source }: { source: string }) => notifications.createBuilder(source),
          registerDeliveryAdapter() {},
        },
      ],
    ]),
    ws: null,
    wsEndpoints: {},
    wsPublish: null,
    bus,
  } as unknown as Parameters<typeof attachContext>[1]);

  const routeAuth: RouteAuthRegistry = {
    userAuth: (async (c, next) => {
      const uid = c.req.header('x-test-user') ?? userId;
      (c as unknown as { set(k: string, v: unknown): void }).set('authUserId', uid);
      await next();
    }) as MiddlewareHandler,
    requireRole: () => async (_c, next) => next(),
  };

  app.use('*', async (c, next) => {
    const uid = c.req.header('x-test-user') ?? userId;
    (c as unknown as { set(k: string, v: unknown): void }).set('authUserId', uid);
    (c as unknown as { set(k: string, v: unknown): void }).set('slingshotCtx', { routeAuth });
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
export function post(app: RequestApp, path: string, body: unknown, userId = 'user-1') {
  return app.request(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-test-user': userId },
    body: JSON.stringify(body),
  });
}

/** JSON PATCH helper */
export function patch(app: RequestApp, path: string, body: unknown, userId = 'user-1') {
  return app.request(path, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', 'x-test-user': userId },
    body: JSON.stringify(body),
  });
}

/** GET helper */
export function get(app: RequestApp, path: string, userId?: string) {
  const headers: Record<string, string> = {};
  if (userId) headers['x-test-user'] = userId;
  return app.request(path, { method: 'GET', headers });
}

/** DELETE helper */
export function del(app: RequestApp, path: string, userId = 'user-1') {
  return app.request(path, {
    method: 'DELETE',
    headers: { 'x-test-user': userId },
  });
}
