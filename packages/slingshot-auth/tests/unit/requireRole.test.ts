import { describe, expect, test } from 'bun:test';
import { Hono } from 'hono';
import type { AppEnv, SlingshotContext } from '@lastshotlabs/slingshot-core';
import { getActor } from '@lastshotlabs/slingshot-core';
import { requireRole } from '../../src/middleware/requireRole';
import { AUTH_RUNTIME_KEY } from '../../src/runtime';
import type { AuthRuntimeContext } from '../../src/runtime';

// ---------------------------------------------------------------------------
// Mock adapter with configurable getEffectiveRoles
// ---------------------------------------------------------------------------

type RolesResolver = (userId: string, tenantId: string | null) => Promise<string[]>;

function makeMockAdapter(rolesResolver: RolesResolver) {
  return {
    getEffectiveRoles: rolesResolver,
  } as unknown as AuthRuntimeContext['adapter'];
}

// ---------------------------------------------------------------------------
// App builder
// ---------------------------------------------------------------------------

function buildApp(opts: {
  rolesResolver: RolesResolver;
  userId?: string | null;
  tenantId?: string | null;
}) {
  const { rolesResolver, userId = null, tenantId = null } = opts;
  const adapter = makeMockAdapter(rolesResolver);

  const app = new Hono<AppEnv>();

  // Inject slingshotCtx with the mock adapter as auth runtime
  app.use('*', async (c, next) => {
    const runtimePartial = { adapter };
    const runtime = runtimePartial as AuthRuntimeContext;
    const ctxPartial = {
      pluginState: new Map([[AUTH_RUNTIME_KEY, runtime]]),
    };
    c.set('slingshotCtx', ctxPartial as unknown as SlingshotContext);
    // Simulate auth context via actor
    if (userId) {
      c.set(
        'actor',
        Object.freeze({
          id: userId,
          kind: 'user' as const,
          tenantId,
          sessionId: null,
          roles: null,
          claims: {},
        }),
      );
    } else {
      c.set(
        'actor',
        Object.freeze({
          id: null,
          kind: 'anonymous' as const,
          tenantId: null,
          sessionId: null,
          roles: null,
          claims: {},
        }),
      );
    }
    await next();
  });

  return app;
}

// ---------------------------------------------------------------------------
// 1. Basic RBAC
// ---------------------------------------------------------------------------

describe('requireRole — basic RBAC', () => {
  test('user with required role gets 200', async () => {
    const app = buildApp({
      rolesResolver: async () => ['admin', 'user'],
      userId: 'user-1',
    });
    app.get('/admin', requireRole('admin'), c => c.json({ ok: true }));

    const res = await app.request('/admin');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  test('user without required role gets 403', async () => {
    const app = buildApp({
      rolesResolver: async () => ['user'],
      userId: 'user-1',
    });
    app.get('/admin', requireRole('admin'), c => c.json({ ok: true }));

    const res = await app.request('/admin');
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'Forbidden' });
  });

  test('user with no roles at all gets 403', async () => {
    const app = buildApp({
      rolesResolver: async () => [],
      userId: 'user-1',
    });
    app.get('/admin', requireRole('admin'), c => c.json({ ok: true }));

    const res = await app.request('/admin');
    expect(res.status).toBe(403);
  });
});

// ---------------------------------------------------------------------------
// 2. Multiple roles (OR logic)
// ---------------------------------------------------------------------------

describe('requireRole — multiple roles (OR logic)', () => {
  test('user with first of multiple required roles gets 200', async () => {
    const app = buildApp({
      rolesResolver: async () => ['admin'],
      userId: 'user-1',
    });
    app.get('/mod', requireRole('admin', 'moderator'), c => c.json({ ok: true }));

    const res = await app.request('/mod');
    expect(res.status).toBe(200);
  });

  test('user with second of multiple required roles gets 200', async () => {
    const app = buildApp({
      rolesResolver: async () => ['moderator'],
      userId: 'user-1',
    });
    app.get('/mod', requireRole('admin', 'moderator'), c => c.json({ ok: true }));

    const res = await app.request('/mod');
    expect(res.status).toBe(200);
  });

  test('user with none of the required roles gets 403', async () => {
    const app = buildApp({
      rolesResolver: async () => ['viewer'],
      userId: 'user-1',
    });
    app.get('/mod', requireRole('admin', 'moderator'), c => c.json({ ok: true }));

    const res = await app.request('/mod');
    expect(res.status).toBe(403);
  });
});

// ---------------------------------------------------------------------------
// 3. No actor — returns 401
// ---------------------------------------------------------------------------

describe('requireRole — unauthenticated', () => {
  test('no actor returns 401', async () => {
    const app = buildApp({
      rolesResolver: async () => ['admin'],
      userId: null,
    });
    app.get('/admin', requireRole('admin'), c => c.json({ ok: true }));

    const res = await app.request('/admin');
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'Unauthorized' });
  });

  test('empty string actor id returns 401', async () => {
    const app = buildApp({
      rolesResolver: async () => ['admin'],
      userId: '',
    });
    app.get('/admin', requireRole('admin'), c => c.json({ ok: true }));

    const res = await app.request('/admin');
    // Empty string is falsy, so requireRole should return 401
    expect(res.status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// 4. Tenant-scoped — passes tenantId to adapter
// ---------------------------------------------------------------------------

describe('requireRole — tenant-scoped', () => {
  test('passes tenantId from context to getEffectiveRoles', async () => {
    let capturedTenantId: string | null | undefined;
    const app = buildApp({
      rolesResolver: async (_userId, tenantId) => {
        capturedTenantId = tenantId;
        return ['admin'];
      },
      userId: 'user-1',
      tenantId: 'tenant-42',
    });
    app.get('/admin', requireRole('admin'), c => c.json({ ok: true }));

    const res = await app.request('/admin');
    expect(res.status).toBe(200);
    expect(capturedTenantId).toBe('tenant-42');
  });

  test('passes null tenantId when no tenant context', async () => {
    let capturedTenantId: string | null | undefined;
    const app = buildApp({
      rolesResolver: async (_userId, tenantId) => {
        capturedTenantId = tenantId;
        return ['admin'];
      },
      userId: 'user-1',
      tenantId: null,
    });
    app.get('/admin', requireRole('admin'), c => c.json({ ok: true }));

    await app.request('/admin');
    expect(capturedTenantId).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 5. requireRole.global() — ignores tenant context
// ---------------------------------------------------------------------------

describe('requireRole.global', () => {
  test('always passes null tenantId to adapter regardless of context', async () => {
    let capturedTenantId: string | null | undefined;
    const app = buildApp({
      rolesResolver: async (_userId, tenantId) => {
        capturedTenantId = tenantId;
        return ['superadmin'];
      },
      userId: 'user-1',
      tenantId: 'tenant-99',
    });
    app.get('/super', requireRole.global('superadmin'), c => c.json({ ok: true }));

    const res = await app.request('/super');
    expect(res.status).toBe(200);
    expect(capturedTenantId).toBeNull();
  });

  test('user without global role gets 403', async () => {
    const app = buildApp({
      rolesResolver: async () => ['user'],
      userId: 'user-1',
      tenantId: 'tenant-99',
    });
    app.get('/super', requireRole.global('superadmin'), c => c.json({ ok: true }));

    const res = await app.request('/super');
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'Forbidden' });
  });

  test('unauthenticated user gets 401 from global()', async () => {
    const app = buildApp({
      rolesResolver: async () => ['superadmin'],
      userId: null,
    });
    app.get('/super', requireRole.global('superadmin'), c => c.json({ ok: true }));

    const res = await app.request('/super');
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'Unauthorized' });
  });
});

// ---------------------------------------------------------------------------
// 6. Effective roles are set on context
// ---------------------------------------------------------------------------

describe('requireRole — sets roles on context', () => {
  test('effective roles are available to downstream handlers', async () => {
    const app = buildApp({
      rolesResolver: async () => ['admin', 'editor'],
      userId: 'user-1',
    });
    app.get('/check', requireRole('admin'), c => {
      const roles = getActor(c).roles;
      return c.json({ roles });
    });

    const res = await app.request('/check');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.roles).toEqual(['admin', 'editor']);
  });
});

// ---------------------------------------------------------------------------
// 7. Adapter missing getEffectiveRoles
// ---------------------------------------------------------------------------

describe('requireRole — adapter missing getEffectiveRoles', () => {
  test('throws error when adapter lacks getEffectiveRoles', async () => {
    const app = new Hono<AppEnv>();
    const emptyAdapter = {};
    const adapter = emptyAdapter as AuthRuntimeContext['adapter'];
    app.use('*', async (c, next) => {
      const runtimePartial = { adapter };
      const runtime = runtimePartial as AuthRuntimeContext;
      const ctxPartial = {
        pluginState: new Map([[AUTH_RUNTIME_KEY, runtime]]),
      };
      c.set('slingshotCtx', ctxPartial as unknown as SlingshotContext);
      c.set(
        'actor',
        Object.freeze({
          id: 'user-1',
          kind: 'user' as const,
          tenantId: null,
          sessionId: null,
          roles: null,
          claims: {},
        }),
      );
      await next();
    });
    app.onError((err, c) => c.json({ error: err.message }, 500));
    app.get('/admin', requireRole('admin'), c => c.json({ ok: true }));

    const res = await app.request('/admin');
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe('Auth adapter does not implement getEffectiveRoles');
  });
});
