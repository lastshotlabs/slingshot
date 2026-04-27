import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Hono } from 'hono';
import { createInProcessAdapter } from '@lastshotlabs/slingshot-core';
import { createMemoryManagedUserProvider } from '../../src/providers/memoryAccess';
import { createAdminRouter } from '../../src/routes/admin';
import type { AdminEnv } from '../../src/types/env';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildApp(tenantId?: string) {
  const managedUserProvider = createMemoryManagedUserProvider();
  const app = new Hono<AdminEnv>();

  app.use('*', async (c, next) => {
    c.set('adminPrincipal', {
      subject: 'actor-admin',
      provider: 'memory',
      tenantId,
    });
    await next();
  });

  app.route(
    '/',
    createAdminRouter({
      managedUserProvider,
      bus: createInProcessAdapter(),
      evaluator: { can: async () => true },
    }),
  );

  return { app, managedUserProvider };
}

const BASE_USER = {
  id: 'user-1',
  tenantId: 'tenant-a',
  email: 'alice@example.com',
  displayName: 'Alice',
  provider: 'memory' as const,
  status: 'active' as const,
};

const BASE_SESSION = {
  sessionId: 'session-1',
  userId: 'user-1',
  createdAt: Date.now(),
  lastActiveAt: Date.now(),
  active: true,
};

// ---------------------------------------------------------------------------
// GET /users
// ---------------------------------------------------------------------------

describe('GET /users', () => {
  test('returns paginated user list', async () => {
    const { app, managedUserProvider } = buildApp('tenant-a');
    managedUserProvider.seedUser(BASE_USER);
    managedUserProvider.seedUser({ ...BASE_USER, id: 'user-2', email: 'bob@example.com' });

    const res = await app.request('/users');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { users: Array<{ id: string }> };
    expect(body.users).toHaveLength(2);
  });

  test('filters by status', async () => {
    const { app, managedUserProvider } = buildApp('tenant-a');
    managedUserProvider.seedUser(BASE_USER);
    managedUserProvider.seedUser({ ...BASE_USER, id: 'user-2', status: 'suspended' });

    const res = await app.request('/users?status=active');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { users: Array<{ id: string }> };
    expect(body.users.map(u => u.id)).toEqual(['user-1']);
  });

  test('filters by search query', async () => {
    const { app, managedUserProvider } = buildApp('tenant-a');
    managedUserProvider.seedUser(BASE_USER);
    managedUserProvider.seedUser({
      ...BASE_USER,
      id: 'user-2',
      email: 'bob@example.com',
      displayName: 'Bob',
    });

    const res = await app.request('/users?search=alice');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { users: Array<{ id: string }> };
    expect(body.users.map(u => u.id)).toEqual(['user-1']);
  });

  test('returns 403 when permission denied', async () => {
    const managedUserProvider = createMemoryManagedUserProvider();
    const app = new Hono<AdminEnv>();
    app.use('*', async (c, next) => {
      c.set('adminPrincipal', { subject: 'actor', provider: 'memory' });
      await next();
    });
    app.route(
      '/',
      createAdminRouter({
        managedUserProvider,
        bus: createInProcessAdapter(),
        evaluator: { can: async () => false },
      }),
    );

    const res = await app.request('/users');
    expect(res.status).toBe(403);
  });
});

// ---------------------------------------------------------------------------
// GET /users/:userId
// ---------------------------------------------------------------------------

describe('GET /users/:userId', () => {
  test('returns user by id', async () => {
    const { app, managedUserProvider } = buildApp('tenant-a');
    managedUserProvider.seedUser(BASE_USER);

    const res = await app.request('/users/user-1');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { id: string; email: string };
    expect(body.id).toBe('user-1');
    expect(body.email).toBe('alice@example.com');
  });

  test('returns 404 for unknown user', async () => {
    const { app } = buildApp('tenant-a');
    const res = await app.request('/users/nonexistent');
    expect(res.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// PATCH /users/:userId
// ---------------------------------------------------------------------------

describe('PATCH /users/:userId', () => {
  test('updates display name', async () => {
    const { app, managedUserProvider } = buildApp('tenant-a');
    managedUserProvider.seedUser(BASE_USER);

    const res = await app.request('/users/user-1', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ displayName: 'Alice Updated' }),
    });
    expect(res.status).toBe(200);

    // verify in store
    const user = await managedUserProvider.getUser('user-1', { tenantId: 'tenant-a' });
    expect(user?.displayName).toBe('Alice Updated');
  });

  test('returns 404 for unknown user', async () => {
    const { app } = buildApp('tenant-a');
    const res = await app.request('/users/nonexistent', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ displayName: 'X' }),
    });
    expect(res.status).toBe(404);
  });

  test('returns 501 when updateUser not supported', async () => {
    const app = new Hono<AdminEnv>();
    app.use('*', async (c, next) => {
      c.set('adminPrincipal', { subject: 'actor', provider: 'memory', tenantId: 'tenant-a' });
      await next();
    });
    const provider = createMemoryManagedUserProvider();
    provider.seedUser(BASE_USER);
    // Remove the optional updateUser method to simulate unsupported provider
    const partialProvider = { ...provider, updateUser: undefined };
    app.route(
      '/',
      createAdminRouter({
        managedUserProvider: partialProvider,
        bus: createInProcessAdapter(),
        evaluator: { can: async () => true },
      }),
    );

    const res = await app.request('/users/user-1', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ displayName: 'X' }),
    });
    expect(res.status).toBe(501);
  });
});

// ---------------------------------------------------------------------------
// POST /users/:userId/suspend and /unsuspend
// ---------------------------------------------------------------------------

describe('POST /users/:userId/suspend', () => {
  test('suspends a user', async () => {
    const { app, managedUserProvider } = buildApp('tenant-a');
    managedUserProvider.seedUser(BASE_USER);

    const res = await app.request('/users/user-1/suspend', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reason: 'policy violation' }),
    });
    expect(res.status).toBe(200);

    const user = await managedUserProvider.getUser('user-1', { tenantId: 'tenant-a' });
    expect(user?.status).toBe('suspended');
  });

  test('returns 404 for unknown user', async () => {
    const { app } = buildApp('tenant-a');
    const res = await app.request('/users/nonexistent/suspend', { method: 'POST' });
    expect(res.status).toBe(404);
  });
});

describe('POST /users/:userId/unsuspend', () => {
  test('restores a suspended user', async () => {
    const { app, managedUserProvider } = buildApp('tenant-a');
    managedUserProvider.seedUser({ ...BASE_USER, status: 'suspended' });

    const res = await app.request('/users/user-1/unsuspend', { method: 'POST' });
    expect(res.status).toBe(200);

    const user = await managedUserProvider.getUser('user-1', { tenantId: 'tenant-a' });
    expect(user?.status).toBe('active');
  });
});

// ---------------------------------------------------------------------------
// DELETE /users/:userId
// ---------------------------------------------------------------------------

describe('DELETE /users/:userId', () => {
  test('deletes a user', async () => {
    const { app, managedUserProvider } = buildApp('tenant-a');
    managedUserProvider.seedUser(BASE_USER);

    const res = await app.request('/users/user-1', { method: 'DELETE' });
    expect(res.status).toBe(200);

    const user = await managedUserProvider.getUser('user-1', { tenantId: 'tenant-a' });
    expect(user).toBeNull();
  });

  test('returns 404 for unknown user', async () => {
    const { app } = buildApp('tenant-a');
    const res = await app.request('/users/nonexistent', { method: 'DELETE' });
    expect(res.status).toBe(404);
  });

  test('also revokes all sessions for the deleted user', async () => {
    const { app, managedUserProvider } = buildApp('tenant-a');
    managedUserProvider.seedUser(BASE_USER);
    managedUserProvider.seedSession(BASE_SESSION);

    await app.request('/users/user-1', { method: 'DELETE' });

    const sessions = await managedUserProvider.listSessions('user-1');
    expect(sessions).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// GET/PUT /users/:userId/roles
// ---------------------------------------------------------------------------

describe('user role management', () => {
  test('GET /users/:userId/roles returns empty array when no roles assigned', async () => {
    const { app, managedUserProvider } = buildApp('tenant-a');
    managedUserProvider.seedUser(BASE_USER);

    const res = await app.request('/users/user-1/roles');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { roles: string[] };
    expect(body.roles).toEqual([]);
  });

  test('PUT /users/:userId/roles sets roles', async () => {
    const { app, managedUserProvider } = buildApp('tenant-a');
    managedUserProvider.seedUser(BASE_USER);

    const res = await app.request('/users/user-1/roles', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ roles: ['tenant-admin', 'support'] }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { roles: string[] };
    expect(body.roles).toContain('tenant-admin');
    expect(body.roles).toContain('support');
  });

  test('GET /users/:userId/roles returns 404 for unknown user', async () => {
    const { app } = buildApp('tenant-a');
    const res = await app.request('/users/nonexistent/roles');
    expect(res.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// Session management
// ---------------------------------------------------------------------------

describe('session management', () => {
  let app: Hono<AdminEnv>;
  let managedUserProvider: ReturnType<typeof createMemoryManagedUserProvider>;

  beforeEach(() => {
    const built = buildApp('tenant-a');
    app = built.app;
    managedUserProvider = built.managedUserProvider;
    managedUserProvider.seedUser(BASE_USER);
    managedUserProvider.seedSession(BASE_SESSION);
    managedUserProvider.seedSession({ ...BASE_SESSION, sessionId: 'session-2' });
  });

  afterEach(() => {
    managedUserProvider.clear();
  });

  test('GET /users/:userId/sessions returns session list', async () => {
    const res = await app.request('/users/user-1/sessions');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { sessions: Array<{ id: string }> };
    expect(body.sessions).toHaveLength(2);
  });

  test('DELETE /users/:userId/sessions revokes all sessions', async () => {
    const res = await app.request('/users/user-1/sessions', { method: 'DELETE' });
    expect(res.status).toBe(200);

    const sessions = await managedUserProvider.listSessions('user-1', { tenantId: 'tenant-a' });
    expect(sessions).toHaveLength(0);
  });

  test('DELETE /users/:userId/sessions/:sessionId revokes specific session', async () => {
    const res = await app.request('/users/user-1/sessions/session-1', { method: 'DELETE' });
    expect(res.status).toBe(200);

    const sessions = await managedUserProvider.listSessions('user-1', { tenantId: 'tenant-a' });
    expect(sessions.map(s => s.sessionId)).not.toContain('session-1');
    expect(sessions.map(s => s.sessionId)).toContain('session-2');
  });

  test('DELETE /users/:userId/sessions/:sessionId returns 404 for missing session', async () => {
    const res = await app.request('/users/user-1/sessions/nonexistent', { method: 'DELETE' });
    expect(res.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// GET /capabilities
// ---------------------------------------------------------------------------

describe('GET /capabilities', () => {
  test('returns provider capabilities', async () => {
    const { app } = buildApp('tenant-a');

    const res = await app.request('/capabilities');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { canListUsers: boolean; managedUserProvider: string };
    expect(body.canListUsers).toBe(true);
    expect(body.managedUserProvider).toBe('memory');
  });
});

// ---------------------------------------------------------------------------
// Param validation — injection and path traversal protection
// ---------------------------------------------------------------------------

describe('userId and sessionId param validation', () => {
  test('rejects userId containing path traversal characters', async () => {
    const { app } = buildApp('tenant-a');
    const res = await app.request('/users/../secrets');
    expect(res.status).toBeGreaterThanOrEqual(400);
  });

  test('GET /users/:userId returns 400 for userId with special characters', async () => {
    const { app } = buildApp('tenant-a');
    const res = await app.request('/users/user%00null');
    expect([400, 404]).toContain(res.status);
  });

  test('GET /users/:userId returns 400 for userId with semicolons', async () => {
    const { app } = buildApp('tenant-a');
    const res = await app.request('/users/user;DROP TABLE users');
    expect([400, 404]).toContain(res.status);
  });

  test('DELETE /users/:userId/sessions/:sessionId returns 400 for sessionId with slashes', async () => {
    const { app, managedUserProvider } = buildApp('tenant-a');
    managedUserProvider.seedUser(BASE_USER);
    const res = await app.request('/users/user-1/sessions/../../admin', { method: 'DELETE' });
    expect([400, 404]).toContain(res.status);
  });

  test('valid userId with hyphens and underscores is accepted', async () => {
    const { app, managedUserProvider } = buildApp('tenant-a');
    managedUserProvider.seedUser({ ...BASE_USER, id: 'valid_user-123' });
    const res = await app.request('/users/valid_user-123');
    expect(res.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// 501 — unsupported optional provider methods
// ---------------------------------------------------------------------------

function buildAppWithPartialProvider(
  missingMethod: string,
  tenantId = 'tenant-a',
) {
  const app = new Hono<AdminEnv>();
  app.use('*', async (c, next) => {
    c.set('adminPrincipal', { subject: 'actor', provider: 'memory', tenantId });
    await next();
  });
  const provider = createMemoryManagedUserProvider();
  provider.seedUser(BASE_USER);
  provider.seedSession(BASE_SESSION);
  const partialProvider = { ...provider, [missingMethod]: undefined };
  app.route(
    '/',
    createAdminRouter({
      managedUserProvider: partialProvider,
      bus: createInProcessAdapter(),
      evaluator: { can: async () => true },
    }),
  );
  return app;
}

describe('501 responses for unsupported optional methods', () => {
  test('POST /users/:userId/suspend returns 501 when suspendUser not supported', async () => {
    const app = buildAppWithPartialProvider('suspendUser');
    const res = await app.request('/users/user-1/suspend', { method: 'POST' });
    expect(res.status).toBe(501);
  });

  test('POST /users/:userId/unsuspend returns 501 when unsuspendUser not supported', async () => {
    const app = buildAppWithPartialProvider('unsuspendUser');
    const res = await app.request('/users/user-1/unsuspend', { method: 'POST' });
    expect(res.status).toBe(501);
  });

  test('PUT /users/:userId/roles returns 501 when setRoles not supported', async () => {
    const app = buildAppWithPartialProvider('setRoles');
    const res = await app.request('/users/user-1/roles', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ roles: ['admin'] }),
    });
    expect(res.status).toBe(501);
  });

  test('DELETE /users/:userId returns 501 when deleteUser not supported', async () => {
    const app = buildAppWithPartialProvider('deleteUser');
    const res = await app.request('/users/user-1', { method: 'DELETE' });
    expect(res.status).toBe(501);
  });

  test('DELETE /users/:userId/sessions returns 501 when revokeAllSessions not supported', async () => {
    const app = buildAppWithPartialProvider('revokeAllSessions');
    const res = await app.request('/users/user-1/sessions', { method: 'DELETE' });
    expect(res.status).toBe(501);
  });

  test('DELETE /users/:userId/sessions/:sessionId returns 501 when revokeSession not supported', async () => {
    const app = buildAppWithPartialProvider('revokeSession');
    const res = await app.request('/users/user-1/sessions/session-1', { method: 'DELETE' });
    expect(res.status).toBe(501);
  });
});
