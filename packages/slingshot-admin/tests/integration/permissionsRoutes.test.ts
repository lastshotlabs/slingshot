import { describe, expect, test } from 'bun:test';
import { Hono } from 'hono';
import type {
  PermissionGrant,
  PermissionRegistry,
  PermissionsAdapter,
} from '@lastshotlabs/slingshot-core';
import { createPermissionsRouter } from '../../src/routes/permissions';
import type { AdminEnv } from '../../src/types/env';

// ---------------------------------------------------------------------------
// In-memory permissions adapter for testing
// ---------------------------------------------------------------------------

function createMemoryPermissionsAdapter(): PermissionsAdapter {
  const grants = new Map<string, PermissionGrant>();
  let seq = 0;

  return {
    createGrant(input: Omit<PermissionGrant, 'id' | 'grantedAt'>): Promise<string> {
      const id = `grant-${++seq}`;
      grants.set(id, { ...input, id, grantedAt: new Date() });
      return Promise.resolve(id);
    },
    revokeGrant(id: string): Promise<boolean> {
      if (!grants.has(id)) return Promise.resolve(false);
      grants.delete(id);
      return Promise.resolve(true);
    },
    getGrantsForSubject(subjectId: string): Promise<PermissionGrant[]> {
      return Promise.resolve(Array.from(grants.values()).filter(g => g.subjectId === subjectId));
    },
    getEffectiveGrantsForSubject(subjectId: string): Promise<PermissionGrant[]> {
      return Promise.resolve(
        Array.from(grants.values()).filter(g => g.subjectId === subjectId && !g.revokedAt),
      );
    },
    listGrantHistory(subjectId: string): Promise<PermissionGrant[]> {
      return Promise.resolve(Array.from(grants.values()).filter(g => g.subjectId === subjectId));
    },
    listGrantsOnResource(
      type: string,
      id: string,
      tenantId: string | null | undefined,
    ): Promise<PermissionGrant[]> {
      return Promise.resolve(
        Array.from(grants.values()).filter(
          g => g.resourceType === type && g.resourceId === id && g.tenantId === (tenantId ?? null),
        ),
      );
    },
    deleteAllGrantsForSubject(): Promise<void> {
      return Promise.resolve();
    },
  };
}

function createMemoryRegistry(): PermissionRegistry {
  type Def = { resourceType: string; actions: string[]; roles: Record<string, string[]> };
  const defs = new Map<string, Def>();
  return {
    register(def: Def) {
      defs.set(def.resourceType, def);
    },
    getDefinition(resourceType: string) {
      return defs.get(resourceType) ?? null;
    },
    listResourceTypes() {
      return Array.from(defs.values());
    },
    getActionsForRole(resourceType: string, role: string) {
      if (role === 'super-admin') return ['*'];
      const def = defs.get(resourceType);
      return def?.roles[role] ?? [];
    },
  };
}

// ---------------------------------------------------------------------------
// Test app factory
// ---------------------------------------------------------------------------

function createApp(options?: {
  tenantId?: string;
  globalAdmin?: boolean;
  canPermission?: boolean;
}) {
  const app = new Hono<AdminEnv>();
  const tenantId = options?.globalAdmin ? undefined : (options?.tenantId ?? 'tenant-a');
  const canPermission = options?.canPermission ?? true;

  app.use('*', async (c, next) => {
    c.set('adminPrincipal', {
      subject: 'actor-admin',
      provider: 'memory',
      tenantId,
    });
    await next();
  });

  const adapter = createMemoryPermissionsAdapter();
  const registry = createMemoryRegistry();
  registry.register({
    resourceType: 'admin:permission',
    actions: ['read', 'write'],
    roles: { 'tenant-admin': ['read', 'write'] },
  });

  app.route(
    '/',
    createPermissionsRouter({
      evaluator: { can: async () => canPermission },
      adapter,
      registry,
    }),
  );

  return { app, adapter, registry };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('POST /grants — create permission grant', () => {
  test('creates a grant and returns id', async () => {
    const { app } = createApp();

    const res = await app.request('/grants', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        subjectId: 'user-x',
        subjectType: 'user',
        tenantId: 'tenant-a',
        roles: ['tenant-admin'],
      }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { id: string };
    expect(typeof body.id).toBe('string');
  });

  test('returns 403 when permission denied', async () => {
    const { app } = createApp({ canPermission: false });

    const res = await app.request('/grants', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        subjectId: 'user-x',
        subjectType: 'user',
        roles: ['tenant-admin'],
      }),
    });
    expect(res.status).toBe(403);
  });

  test('non-global admin cannot create global grant (tenantId=null)', async () => {
    const { app } = createApp({ tenantId: 'tenant-a' });

    const res = await app.request('/grants', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        subjectId: 'user-x',
        subjectType: 'user',
        tenantId: null,
        roles: ['tenant-admin'],
      }),
    });
    // assertPermissionsScope fires first (null !== 'tenant-a'), returning 403 before
    // the explicit global-admin check. Either path correctly rejects the request.
    expect(res.status).toBe(403);
  });

  test('non-global admin cannot grant super-admin role', async () => {
    const { app } = createApp({ tenantId: 'tenant-a' });

    const res = await app.request('/grants', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        subjectId: 'user-x',
        subjectType: 'user',
        tenantId: 'tenant-a',
        roles: ['super-admin'],
      }),
    });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain('super-admin');
  });

  test('global admin can create global grant', async () => {
    const { app } = createApp({ globalAdmin: true });

    const res = await app.request('/grants', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        subjectId: 'user-x',
        subjectType: 'user',
        tenantId: null,
        roles: ['tenant-admin'],
      }),
    });
    expect(res.status).toBe(201);
  });
});

describe('DELETE /grants/:grantId — revoke grant', () => {
  test('revokes an existing grant', async () => {
    const { app, adapter } = createApp();

    const grantId = await adapter.createGrant({
      subjectId: 'user-x',
      subjectType: 'user',
      tenantId: 'tenant-a',
      resourceType: null,
      resourceId: null,
      roles: ['tenant-admin'],
      effect: 'allow',
      grantedBy: 'actor',
    });

    const res = await app.request(`/grants/${grantId}`, { method: 'DELETE' });
    expect(res.status).toBe(200);
  });

  test('returns 404 for nonexistent grant', async () => {
    const { app } = createApp();
    const res = await app.request('/grants/nonexistent', { method: 'DELETE' });
    expect(res.status).toBe(404);
  });
});

describe('GET /subjects/:subjectType/:subjectId/grants', () => {
  test('returns grants for subject', async () => {
    const { app, adapter } = createApp();

    await adapter.createGrant({
      subjectId: 'user-x',
      subjectType: 'user',
      tenantId: 'tenant-a',
      resourceType: null,
      resourceId: null,
      roles: ['tenant-admin'],
      effect: 'allow',
      grantedBy: 'actor',
    });

    const res = await app.request('/subjects/user/user-x/grants');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { grants: unknown[] };
    expect(body.grants).toHaveLength(1);
  });

  test('non-global admin only sees grants for their tenant', async () => {
    const { app, adapter } = createApp({ tenantId: 'tenant-a' });

    await adapter.createGrant({
      subjectId: 'user-x',
      subjectType: 'user',
      tenantId: 'tenant-b',
      resourceType: null,
      resourceId: null,
      roles: ['tenant-admin'],
      effect: 'allow',
      grantedBy: 'actor',
    });

    const res = await app.request('/subjects/user/user-x/grants');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { grants: unknown[] };
    // tenant-b grant is filtered out for tenant-a admin
    expect(body.grants).toHaveLength(0);
  });
});

describe('GET /resources — list resource types', () => {
  test('returns registered resource types', async () => {
    const { app } = createApp();

    const res = await app.request('/resources');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { resourceTypes: Array<{ resourceType: string }> };
    expect(body.resourceTypes.map(r => r.resourceType)).toContain('admin:permission');
  });

  test('returns 403 when permission denied', async () => {
    const { app } = createApp({ canPermission: false });
    const res = await app.request('/resources');
    expect(res.status).toBe(403);
  });
});
