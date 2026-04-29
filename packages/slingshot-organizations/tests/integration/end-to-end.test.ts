/**
 * End-to-end integration test for the organizations plugin.
 *
 * Exercises CRUD, invite flow, and delete cascade through the full HTTP surface
 * using the in-memory entity adapter. The in-memory adapter implements the same
 * `EntityAdapter` contract as the SQLite adapter, so all plugin-level code paths
 * (middleware, routes, runtime helpers) are exercised identically.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Hono } from 'hono';
import {
  type AuthRuntimeContext,
  createAuthResolvedConfig,
  getAuthRuntimeContext,
} from '@lastshotlabs/slingshot-auth';
import {
  createAuthRateLimitService,
  createCredentialStuffingService,
  createLockoutService,
  createMemoryAuthAdapter,
  createMemoryAuthRateLimitRepository,
  createMemoryCredentialStuffingRepository,
  createMemoryDeletionCancelTokenRepository,
  createMemoryLockoutRepository,
  createMemoryMagicLinkRepository,
  createMemoryMfaChallengeRepository,
  createMemoryOAuthCodeRepository,
  createMemoryOAuthReauthRepository,
  createMemoryOAuthStateStore,
  createMemoryResetTokenRepository,
  createMemorySamlRequestIdRepository,
  createMemorySessionRepository,
  createMemoryVerificationTokenRepository,
} from '@lastshotlabs/slingshot-auth/testing';
import {
  InProcessAdapter,
  RESOLVE_ENTITY_FACTORIES,
  type SlingshotContext,
  type SlingshotResolvedConfig,
  attachContext,
  createDefaultIdentityResolver,
  createEntityRegistry,
  getActor,
} from '@lastshotlabs/slingshot-core';
import type {
  AppEnv,
  PluginSetupContext,
  ResolvedEntityConfig,
  RouteAuthRegistry,
  SlingshotFrameworkConfig,
  StoreType,
} from '@lastshotlabs/slingshot-core';
import { createMemoryStoreInfra } from '@lastshotlabs/slingshot-core/testing';
import { createEntityFactories } from '@lastshotlabs/slingshot-entity';
import { organizationsManifest } from '../../src/manifest/organizationsManifest';
import { getOrganizationsOrgServiceOrNull } from '../../src/orgService';
import { createOrganizationsPlugin } from '../../src/plugin';
import { getOrganizationsReconcileOrNull } from '../../src/reconcile';

function createFrameworkConfig(): SlingshotFrameworkConfig & {
  registeredEntities: ResolvedEntityConfig[];
} {
  const registeredEntities: ResolvedEntityConfig[] = [];
  const entityRegistry = createEntityRegistry();
  const storeInfra = createMemoryStoreInfra();
  Reflect.set(storeInfra as object, RESOLVE_ENTITY_FACTORIES, createEntityFactories);

  const originalRegister = entityRegistry.register.bind(entityRegistry);
  entityRegistry.register = (config: ResolvedEntityConfig) => {
    registeredEntities.push(config);
    return originalRegister(config);
  };

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
    registrar: {
      setIdentityResolver() {},
      setRouteAuth() {},
      setRequestActorResolver() {},
      setRateLimitAdapter() {},
      setFingerprintBuilder() {},
      addCacheAdapter() {},
      addEmailTemplates() {},
    },
    entityRegistry,
    storeInfra,
    password: Bun.password,
    registeredEntities,
  };
}

async function createTestAuthRuntime(
  bus: InProcessAdapter,
  stores: SlingshotFrameworkConfig['resolvedStores'],
): Promise<{
  runtime: AuthRuntimeContext;
  adminId: string;
  memberId: string;
}> {
  const adapter = createMemoryAuthAdapter(() =>
    createAuthResolvedConfig({
      emailVerification: { required: false },
    }),
  );
  const admin = await adapter.create('admin@example.com', 'hash');
  const member = await adapter.create('member@example.com', 'hash');
  if (!adapter.addRole || !adapter.setEmailVerified) {
    throw new Error('memory auth adapter is missing required test helpers');
  }
  await adapter.addRole(admin.id, 'admin');
  await adapter.setEmailVerified(admin.id, true);
  await adapter.setEmailVerified(member.id, true);

  const runtime: AuthRuntimeContext = {
    adapter,
    eventBus: bus,
    config: createAuthResolvedConfig({
      emailVerification: { required: false },
    }),
    stores,
    password: Bun.password,
    getDummyHash: async () => 'dummy-hash',
    signing: null,
    dataEncryptionKeys: [],
    oauth: {
      providers: {},
      stateStore: createMemoryOAuthStateStore(),
    },
    lockout: createLockoutService(
      {
        maxAttempts: 5,
        lockoutDuration: 60,
        resetOnSuccess: true,
      },
      createMemoryLockoutRepository(),
    ),
    rateLimit: createAuthRateLimitService(createMemoryAuthRateLimitRepository()),
    credentialStuffing: createCredentialStuffingService(
      {
        maxAccountsPerIp: { count: 20, windowMs: 60_000 },
        maxIpsPerAccount: { count: 20, windowMs: 60_000 },
      },
      createMemoryCredentialStuffingRepository(),
    ),
    securityGate: {
      preAuthCheck: async () => ({ allowed: true }),
      lockoutCheck: async () => ({ allowed: true }),
      recordLoginFailure: async () => ({ stuffingNowBlocked: false }),
      recordLoginSuccess: async () => {},
    },
    queueFactory: null,
    repos: {
      oauthCode: createMemoryOAuthCodeRepository(),
      oauthReauth: createMemoryOAuthReauthRepository(),
      magicLink: createMemoryMagicLinkRepository(),
      deletionCancelToken: createMemoryDeletionCancelTokenRepository(),
      mfaChallenge: createMemoryMfaChallengeRepository(),
      samlRequestId: createMemorySamlRequestIdRepository(),
      verificationToken: createMemoryVerificationTokenRepository(),
      resetToken: createMemoryResetTokenRepository(),
      session: createMemorySessionRepository(),
    },
  };

  return { runtime, adminId: admin.id, memberId: member.id };
}

function createRouteAuth(adminId: string): RouteAuthRegistry {
  return {
    userAuth: async (c, next) => {
      const userId = c.req.header('x-user-id');
      if (!userId) {
        return c.json({ error: 'Unauthorized' }, 401);
      }
      const roles = userId === adminId ? ['admin'] : ['member'];
      c.set(
        'actor',
        Object.freeze({
          id: userId,
          kind: 'user' as const,
          tenantId: c.req.header('x-tenant-id') ?? null,
          sessionId: null,
          roles,
          claims: {},
        }),
      );
      return next();
    },
    bearerAuth: undefined,
    requireRole:
      (...requiredRoles: string[]) =>
      async (c, next) => {
        const actor = getActor(c);
        const roles = Array.isArray(actor.roles)
          ? actor.roles.filter((role): role is string => typeof role === 'string')
          : [];
        if (requiredRoles.some(role => roles.includes(role))) {
          return next();
        }
        return c.json({ error: 'Forbidden' }, 403);
      },
  };
}

function createPersistence(): SlingshotContext['persistence'] {
  const roomConfigs = new Map<string, { maxCount: number; ttlSeconds: number }>();
  let defaults = { maxCount: 100, ttlSeconds: 86_400 };

  return {
    uploadRegistry: {
      async register() {},
      async get() { return null; },
      async delete() { return false; },
    },
    idempotency: {
      async get() { return null; },
      async set() {},
      async clear() {},
    },
    wsMessages: {
      async persist(message) { return message; },
      async getHistory() { return []; },
      async clear() {},
    },
    auditLog: {
      async logEntry() {},
      async getLogs() { return { items: [] }; },
    },
    cronRegistry: {
      async getAll() { return new Set<string>(); },
      async save() {},
    },
    configureRoom(endpoint, room, options) {
      roomConfigs.set(`${endpoint}:${room}`, {
        maxCount: options.maxCount ?? defaults.maxCount,
        ttlSeconds: options.ttlSeconds ?? defaults.ttlSeconds,
      });
    },
    getRoomConfig(endpoint, room) {
      return roomConfigs.get(`${endpoint}:${room}`) ?? null;
    },
    setDefaults(nextDefaults) {
      defaults = {
        maxCount: nextDefaults.maxCount ?? defaults.maxCount,
        ttlSeconds: nextDefaults.ttlSeconds ?? defaults.ttlSeconds,
      };
    },
  };
}

function createSecretsRepository(): SlingshotContext['secrets'] {
  return {
    name: 'test-secrets',
    async get() { return null; },
    async getMany() { return new Map<string, string>(); },
  };
}

function createMetricsState(): SlingshotContext['metrics'] {
  return {
    counters: new Map(),
    histograms: new Map(),
    gaugeCallbacks: new Map(),
    queues: null,
  };
}

function createTestContext(args: {
  app: Hono<AppEnv>;
  appName: string;
  bus: InProcessAdapter;
  frameworkConfig: SlingshotFrameworkConfig;
  pluginState: Map<string, unknown>;
  routeAuth: RouteAuthRegistry;
}): SlingshotContext {
  const config: SlingshotResolvedConfig = {
    appName: args.appName,
    resolvedStores: args.frameworkConfig.resolvedStores,
    security: args.frameworkConfig.security,
    signing: args.frameworkConfig.signing,
    dataEncryptionKeys: args.frameworkConfig.dataEncryptionKeys,
    redis: args.frameworkConfig.redis,
    mongo: args.frameworkConfig.mongo,
    captcha: args.frameworkConfig.captcha,
  };

  return {
    app: args.app,
    appName: args.appName,
    config,
    redis: null,
    mongo: null,
    sqlite: null,
    sqliteDb: null,
    signing: null,
    dataEncryptionKeys: [],
    ws: null,
    wsEndpoints: null,
    wsPublish: null,
    persistence: createPersistence(),
    pluginState: args.pluginState,
    publicPaths: new Set<string>(),
    plugins: [],
    bus: args.bus,
    routeAuth: args.routeAuth,
    actorResolver: null,
    identityResolver: createDefaultIdentityResolver(),
    rateLimitAdapter: null,
    fingerprintBuilder: null,
    cacheAdapters: new Map(),
    emailTemplates: new Map(),
    trustProxy: false,
    upload: null,
    metrics: createMetricsState(),
    secrets: createSecretsRepository(),
    resolvedSecrets: Object.freeze({}),
    async clear() { args.pluginState.clear(); },
    async destroy() { args.pluginState.clear(); },
  };
}

describe('organizations end-to-end integration', () => {
  let app: Hono<AppEnv>;
  let bus: InProcessAdapter;
  let frameworkConfig: SlingshotFrameworkConfig;
  let setupContext: PluginSetupContext;
  let pluginState: Map<string, unknown>;
  let adminId: string;
  let memberId: string;
  let plugin: ReturnType<typeof createOrganizationsPlugin>;

  beforeEach(async () => {
    app = new Hono<AppEnv>();
    bus = new InProcessAdapter();
    frameworkConfig = createFrameworkConfig();
    const authRuntime = await createTestAuthRuntime(bus, frameworkConfig.resolvedStores);
    adminId = authRuntime.adminId;
    memberId = authRuntime.memberId;

    pluginState = new Map<string, unknown>();
    pluginState.set('slingshot-auth', authRuntime.runtime);

    const routeAuth = createRouteAuth(adminId);
    attachContext(
      app,
      createTestContext({
        app,
        appName: 'organizations-e2e',
        bus,
        frameworkConfig,
        pluginState,
        routeAuth,
      }),
    );

    plugin = createOrganizationsPlugin({
      organizations: { enabled: true, invitationTtlSeconds: 3600 },
      groups: { managementRoutes: true },
    });
    setupContext = { app, bus, config: frameworkConfig };
    await plugin.setupMiddleware?.(setupContext);
    await plugin.setupRoutes?.(setupContext);
    await plugin.setupPost?.(setupContext);
  });

  afterEach(async () => {
    await plugin.teardown?.();
  });

  // ── CRUD ──────────────────────────────────────────────────────────────

  test('full CRUD: create, read, update, list, delete an organization', async () => {
    // CREATE
    const createRes = await app.request('/orgs', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-user-id': adminId },
      body: JSON.stringify({ name: 'CRUD Org', slug: 'crud-org', description: 'E2E test org' }),
    });
    expect(createRes.status).toBe(201);
    const org = (await createRes.json()) as { id: string; name: string; slug: string };
    expect(org.id).toBeString();
    expect(org.slug).toBe('crud-org');

    // READ by slug (the `get` route is disabled; use getBySlug instead)
    const getRes = await app.request(`/orgs/by-slug/${org.slug}`, {
      headers: { 'x-user-id': adminId },
    });
    expect(getRes.status).toBe(200);
    const fetched = (await getRes.json()) as { id: string; name: string };
    expect(fetched.id).toBe(org.id);

    // UPDATE
    const updateRes = await app.request(`/orgs/${org.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', 'x-user-id': adminId },
      body: JSON.stringify({ name: 'CRUD Org Updated' }),
    });
    expect(updateRes.status).toBe(200);
    const updated = (await updateRes.json()) as { name: string };
    expect(updated.name).toBe('CRUD Org Updated');

    // LIST
    const listRes = await app.request('/orgs', {
      headers: { 'x-user-id': adminId },
    });
    expect(listRes.status).toBe(200);
    const list = (await listRes.json()) as { items: Array<{ id: string }> };
    expect(list.items.some(o => o.id === org.id)).toBe(true);

    // DELETE
    const deleteRes = await app.request(`/orgs/${org.id}`, {
      method: 'DELETE',
      headers: { 'x-user-id': adminId },
    });
    expect(deleteRes.status).toBe(204);
  });

  // ── Invite flow ───────────────────────────────────────────────────────

  test('full invite flow: create invite, lookup, redeem, then list membership', async () => {
    // Create an org
    const createOrg = await app.request('/orgs', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-user-id': adminId },
      body: JSON.stringify({ name: 'Invite Org', slug: 'invite-org' }),
    });
    expect(createOrg.status).toBe(201);
    const org = (await createOrg.json()) as { id: string };

    // CREATE INVITE (link-based, no email)
    const createInvite = await app.request(`/orgs/${org.id}/invitations`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-user-id': adminId },
      body: JSON.stringify({ role: 'member' }),
    });
    expect(createInvite.status).toBe(201);
    const invite = (await createInvite.json()) as { id: string; token: string };
    expect(invite.token).toBeString();
    expect(invite.token.length).toBeGreaterThan(0);

    // LOOKUP invite (unauthenticated POST with token)
    const lookup = await app.request(`/orgs/${org.id}/invitations/lookup`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: invite.token }),
    });
    expect(lookup.status).toBe(200);
    const lookedUp = (await lookup.json()) as { orgId: string; role: string };
    expect(lookedUp.orgId).toBe(org.id);
    expect(lookedUp.role).toBe('member');

    // REDEEM invite
    const redeem = await app.request(`/orgs/${org.id}/invitations/redeem`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-user-id': memberId },
      body: JSON.stringify({ token: invite.token }),
    });
    expect(redeem.status).toBe(200);
    const redeemed = (await redeem.json()) as {
      organization: { id: string } | null;
      membership: { role: string };
      alreadyMember: boolean;
    };
    expect(redeemed.organization?.id).toBe(org.id);
    expect(redeemed.membership.role).toBe('member');
    expect(redeemed.alreadyMember).toBe(false);

    // VERIFY membership appears in listMine
    const mine = await app.request('/orgs/mine', {
      headers: { 'x-user-id': memberId },
    });
    expect(mine.status).toBe(200);
    const mineBody = (await mine.json()) as { items: Array<{ id: string }> };
    expect(mineBody.items.some(entry => entry.id === org.id)).toBe(true);
  });

  // ── Delete cascade ────────────────────────────────────────────────────

  test('delete cascade: org deletion removes members, invites, and groups', async () => {
    // Create org
    const createOrg = await app.request('/orgs', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-user-id': adminId },
      body: JSON.stringify({ name: 'Cascade Org', slug: 'cascade-org' }),
    });
    expect(createOrg.status).toBe(201);
    const org = (await createOrg.json()) as { id: string };

    // Add member
    const addMember = await app.request(`/orgs/${org.id}/members`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-user-id': adminId },
      body: JSON.stringify({ userId: memberId, role: 'member' }),
    });
    expect(addMember.status).toBe(201);

    // Create invite
    const createInvite = await app.request(`/orgs/${org.id}/invitations`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-user-id': adminId },
      body: JSON.stringify({ role: 'admin' }),
    });
    expect(createInvite.status).toBe(201);

    // Create group
    const createGroup = await app.request('/groups', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-user-id': adminId },
      body: JSON.stringify({ name: 'Cascade Team', slug: 'cascade-team', orgId: org.id }),
    });
    expect(createGroup.status).toBe(201);
    const group = (await createGroup.json()) as { id: string };

    // Add group membership
    const addGroupMember = await app.request(`/groups/${group.id}/members`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-user-id': adminId },
      body: JSON.stringify({ userId: memberId, role: 'member' }),
    });
    expect(addGroupMember.status).toBe(201);

    // DELETE org — should cascade to all dependents
    const deleteOrg = await app.request(`/orgs/${org.id}`, {
      method: 'DELETE',
      headers: { 'x-user-id': adminId },
    });
    expect(deleteOrg.status).toBe(204);

    // Verify org is gone
    const getOrg = await app.request(`/orgs/${org.id}`, {
      headers: { 'x-user-id': adminId },
    });
    expect(getOrg.status).toBe(404);

    // Verify reconcile service reports no orphans
    const reconcile = getOrganizationsReconcileOrNull(pluginState);
    expect(reconcile).not.toBeNull();
  });

  // ── Groups CRUD ───────────────────────────────────────────────────────

  test('groups CRUD: create, list members, delete group within an org', async () => {
    // Create org
    const createOrg = await app.request('/orgs', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-user-id': adminId },
      body: JSON.stringify({ name: 'Group Org', slug: 'group-org' }),
    });
    expect(createOrg.status).toBe(201);
    const org = (await createOrg.json()) as { id: string };

    // Create group
    const createGroup = await app.request('/groups', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-user-id': adminId },
      body: JSON.stringify({ name: 'Engineering', slug: 'engineering', orgId: org.id }),
    });
    expect(createGroup.status).toBe(201);
    const group = (await createGroup.json()) as { id: string; name: string };
    expect(group.name).toBe('Engineering');

    // Add group member
    const addMember = await app.request(`/groups/${group.id}/members`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-user-id': adminId },
      body: JSON.stringify({ userId: memberId, role: 'member' }),
    });
    expect(addMember.status).toBe(201);

    // List group members
    const listMembers = await app.request(`/groups/${group.id}/members`, {
      headers: { 'x-user-id': adminId },
    });
    expect(listMembers.status).toBe(200);
    const members = (await listMembers.json()) as { items: Array<{ userId: string }> };
    expect(members.items.some((m: { userId: string }) => m.userId === memberId)).toBe(true);

    // Delete group
    const deleteGroup = await app.request(`/groups/${group.id}`, {
      method: 'DELETE',
      headers: { 'x-user-id': adminId },
    });
    expect(deleteGroup.status).toBe(204);
  });

  // ── Slug validation ───────────────────────────────────────────────────

  test('slug uniqueness is enforced: duplicate slug returns 409', async () => {
    const createOrg = await app.request('/orgs', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-user-id': adminId },
      body: JSON.stringify({ name: 'First', slug: 'duplicate' }),
    });
    expect(createOrg.status).toBe(201);

    const createDup = await app.request('/orgs', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-user-id': adminId },
      body: JSON.stringify({ name: 'Second', slug: 'duplicate' }),
    });
    expect(createDup.status).toBe(409);
  });

  // ── Org service ───────────────────────────────────────────────────────

  test('org service is published and functional for programmatic access', async () => {
    const orgService = getOrganizationsOrgServiceOrNull(pluginState);
    expect(orgService).not.toBeNull();
    if (!orgService) throw new Error('org service not available');

    // Create org programmatically
    const created = await orgService.createOrg({ name: 'Svc Org', slug: 'svc-org' });
    expect(created.id).toBeString();

    // Look up by slug
    const found = await orgService.getOrgBySlug('svc-org');
    expect(found?.id).toBe(created.id);

    // Add member
    await expect(
      orgService.addOrgMember(created.id, memberId, ['admin'], adminId),
    ).resolves.toBeDefined();
  });

  // ── Tenant isolation ──────────────────────────────────────────────────

  test('getOrgBySlug filters by tenantId when provided', async () => {
    const orgService = getOrganizationsOrgServiceOrNull(pluginState);
    if (!orgService) throw new Error('org service not available');

    // Create an org with a specific tenant scope
    await orgService.createOrg({ name: 'Tenant Scoped Org', slug: 'scoped-org', tenantId: 'tenant-a' });

    // Lookup with matching tenantId returns the org
    const found = await orgService.getOrgBySlug('scoped-org', 'tenant-a');
    expect(found).not.toBeNull();

    // Lookup with different tenantId returns null (no cross-tenant leak)
    const crossTenant = await orgService.getOrgBySlug('scoped-org', 'tenant-b');
    expect(crossTenant).toBeNull();

    // Lookup without tenantId still finds it (backward-compatible)
    const noFilter = await orgService.getOrgBySlug('scoped-org');
    expect(noFilter).not.toBeNull();
  });

  // ── Reconcile service ─────────────────────────────────────────────────

  test('reconcile service is published and callable', async () => {
    const reconcile = getOrganizationsReconcileOrNull(pluginState);
    expect(reconcile).not.toBeNull();
    if (!reconcile) throw new Error('reconcile service not available');

    // Should resolve without error for a non-existent org
    const result = await reconcile.reconcileOrphanedOrgRecords('nonexistent-org-id');
    expect(result).toBeDefined();
  });
});
