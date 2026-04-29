import { describe, expect, mock, spyOn, test } from 'bun:test';
import { Hono } from 'hono';
import { createInProcessAdapter } from '@lastshotlabs/slingshot-core';
import type { AuditLogProvider } from '@lastshotlabs/slingshot-core';
import { createMemoryManagedUserProvider } from '../../src/providers/memoryAccess';
import { createAdminRouter } from '../../src/routes/admin';
import type { AdminEnv } from '../../src/types/env';

function buildApp(
  auditLog?: AuditLogProvider,
  overrides: Partial<Parameters<typeof createAdminRouter>[0]> = {},
) {
  const managedUserProvider = createMemoryManagedUserProvider();
  const app = new Hono<AdminEnv>();

  app.use('*', async (c, next) => {
    c.set('adminPrincipal', { subject: 'admin', provider: 'memory', tenantId: 'tenant-1' });
    await next();
  });

  app.route(
    '/',
    createAdminRouter({
      managedUserProvider,
      bus: createInProcessAdapter(),
      evaluator: { can: async () => true },
      auditLog,
      ...overrides,
    }),
  );

  return { app, managedUserProvider };
}

const BASE_USER = {
  id: 'u-1',
  tenantId: 'tenant-1',
  email: 'test@example.com',
  displayName: 'Test',
  provider: 'memory' as const,
  status: 'active' as const,
};

const BASE_SESSION = {
  sessionId: 's-1',
  userId: 'u-1',
  createdAt: Date.now(),
  lastActiveAt: Date.now(),
  active: true,
};

describe('requireAuditEntry — destructive verbs fail-closed when audit log is unavailable', () => {
  test('POST /users/:id/suspend returns 503 when audit log throws synchronously', async () => {
    const auditLog: AuditLogProvider = {
      logEntry: mock(() => {
        throw new Error('audit backend down');
      }),
      getLogs: mock(async () => ({ items: [], nextCursor: undefined })),
    };
    const errorSpy = spyOn(console, 'error').mockImplementation(() => {});

    const { app, managedUserProvider } = buildApp(auditLog);
    managedUserProvider.seedUser(BASE_USER);

    const res = await app.request('/users/u-1/suspend', { method: 'POST' });

    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('audit-log-unavailable');
    const user = await managedUserProvider.getUser('u-1', { tenantId: 'tenant-1' });
    expect(user?.status).toBe('active');
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  test('POST /users/:id/unsuspend returns 503 when audit log rejects asynchronously', async () => {
    const auditLog: AuditLogProvider = {
      logEntry: mock(() => Promise.reject(new Error('async audit failure'))),
      getLogs: mock(async () => ({ items: [], nextCursor: undefined })),
    };
    const errorSpy = spyOn(console, 'error').mockImplementation(() => {});

    const { app, managedUserProvider } = buildApp(auditLog);
    managedUserProvider.seedUser({ ...BASE_USER, status: 'suspended' });

    const res = await app.request('/users/u-1/unsuspend', { method: 'POST' });

    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('audit-log-unavailable');
    const user = await managedUserProvider.getUser('u-1', { tenantId: 'tenant-1' });
    expect(user?.status).toBe('suspended');
    errorSpy.mockRestore();
  });

  test('DELETE /users/:id returns 503 when audit log fails before deletion', async () => {
    const auditLog: AuditLogProvider = {
      logEntry: mock(() => Promise.reject(new Error('audit down'))),
      getLogs: mock(async () => ({ items: [], nextCursor: undefined })),
    };
    const errorSpy = spyOn(console, 'error').mockImplementation(() => {});

    const { app, managedUserProvider } = buildApp(auditLog);
    managedUserProvider.seedUser(BASE_USER);

    const res = await app.request('/users/u-1', { method: 'DELETE' });

    expect(res.status).toBe(503);
    const user = await managedUserProvider.getUser('u-1', { tenantId: 'tenant-1' });
    expect(user).not.toBeNull();
    errorSpy.mockRestore();
  });

  test('PUT /users/:id/roles returns 503 when audit log fails', async () => {
    const auditLog: AuditLogProvider = {
      logEntry: mock(() => Promise.reject(new Error('audit unavailable'))),
      getLogs: mock(async () => ({ items: [], nextCursor: undefined })),
    };
    const errorSpy = spyOn(console, 'error').mockImplementation(() => {});

    const { app, managedUserProvider } = buildApp(auditLog);
    managedUserProvider.seedUser(BASE_USER);

    const res = await app.request('/users/u-1/roles', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ roles: ['editor'] }),
    });

    expect(res.status).toBe(503);
    await expect(managedUserProvider.getRoles('u-1', { tenantId: 'tenant-1' })).resolves.toEqual(
      [],
    );
    errorSpy.mockRestore();
  });

  test('DELETE /users/:id/sessions returns 503 when audit log fails', async () => {
    const auditLog: AuditLogProvider = {
      logEntry: mock(() => Promise.reject(new Error('audit unavailable'))),
      getLogs: mock(async () => ({ items: [], nextCursor: undefined })),
    };
    const errorSpy = spyOn(console, 'error').mockImplementation(() => {});

    const { app, managedUserProvider } = buildApp(auditLog);
    managedUserProvider.seedUser(BASE_USER);
    managedUserProvider.seedSession(BASE_SESSION);

    const res = await app.request('/users/u-1/sessions', { method: 'DELETE' });

    expect(res.status).toBe(503);
    await expect(
      managedUserProvider.listSessions('u-1', { tenantId: 'tenant-1' }),
    ).resolves.toHaveLength(1);
    errorSpy.mockRestore();
  });

  test('DELETE /users/:id/sessions/:sessionId returns 503 when audit log fails before revocation', async () => {
    const auditLog: AuditLogProvider = {
      logEntry: mock(() => Promise.reject(new Error('audit unavailable'))),
      getLogs: mock(async () => ({ items: [], nextCursor: undefined })),
    };
    const errorSpy = spyOn(console, 'error').mockImplementation(() => {});

    const { app, managedUserProvider } = buildApp(auditLog);
    managedUserProvider.seedUser(BASE_USER);
    managedUserProvider.seedSession(BASE_SESSION);

    const res = await app.request('/users/u-1/sessions/s-1', { method: 'DELETE' });

    expect(res.status).toBe(503);
    await expect(
      managedUserProvider.listSessions('u-1', { tenantId: 'tenant-1' }),
    ).resolves.toHaveLength(1);
    errorSpy.mockRestore();
  });

  test('read-only verb (GET /users) still returns 200 when audit fails', async () => {
    // GET /users does not write audit entries at all, so failing audit must
    // not affect read paths.
    const auditLog: AuditLogProvider = {
      logEntry: mock(() => Promise.reject(new Error('audit down'))),
      getLogs: mock(async () => ({ items: [], nextCursor: undefined })),
    };
    const errorSpy = spyOn(console, 'error').mockImplementation(() => {});

    const { app, managedUserProvider } = buildApp(auditLog);
    managedUserProvider.seedUser(BASE_USER);

    const res = await app.request('/users');

    expect(res.status).toBe(200);
    expect(auditLog.logEntry).not.toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  test('PATCH /users/:id (non-destructive update) still returns 200 with console.error when audit fails', async () => {
    // PATCH update is treated as a write but not destructive in the spec —
    // it remains best-effort audit so an audit outage cannot freeze profile
    // updates.
    const auditLog: AuditLogProvider = {
      logEntry: mock(() => Promise.reject(new Error('async audit failure'))),
      getLogs: mock(async () => ({ items: [], nextCursor: undefined })),
    };
    const errorSpy = spyOn(console, 'error').mockImplementation(() => {});

    const { app, managedUserProvider } = buildApp(auditLog);
    managedUserProvider.seedUser(BASE_USER);

    const res = await app.request('/users/u-1', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ displayName: 'Updated' }),
    });

    expect(res.status).toBe(200);
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  test('successful destructive verb returns 200 when audit log writes succeed', async () => {
    const auditLog: AuditLogProvider = {
      logEntry: mock(async () => {}),
      getLogs: mock(async () => ({ items: [], nextCursor: undefined })),
    };
    const { app, managedUserProvider } = buildApp(auditLog);
    managedUserProvider.seedUser(BASE_USER);

    const res = await app.request('/users/u-1/suspend', { method: 'POST' });

    expect(res.status).toBe(200);
    expect(auditLog.logEntry).toHaveBeenCalled();
  });
});
