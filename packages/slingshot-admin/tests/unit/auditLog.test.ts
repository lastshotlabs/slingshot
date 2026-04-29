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

describe('tryLogAuditEntry — audit failures do not propagate to HTTP callers', () => {
  test('route returns 200 even when auditLog.logEntry throws synchronously', async () => {
    const throwingAuditLog: AuditLogProvider = {
      logEntry: mock(() => {
        throw new Error('audit backend down');
      }),
      getLogs: mock(async () => ({ items: [], nextCursor: undefined })),
    };
    const errorSpy = spyOn(console, 'error').mockImplementation(() => {});

    const { app, managedUserProvider } = buildApp(throwingAuditLog);
    managedUserProvider.seedUser(BASE_USER);

    const res = await app.request('/users/u-1', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ displayName: 'Updated' }),
    });

    expect(res.status).toBe(200);
    expect(throwingAuditLog.logEntry).toHaveBeenCalled();
    // The error was swallowed and logged, not propagated
    expect(errorSpy).toHaveBeenCalled();

    errorSpy.mockRestore();
  });

  test('route returns 200 even when auditLog.logEntry rejects asynchronously', async () => {
    const rejectingAuditLog: AuditLogProvider = {
      logEntry: mock(() => Promise.reject(new Error('async audit failure'))),
      getLogs: mock(async () => ({ items: [], nextCursor: undefined })),
    };
    const errorSpy = spyOn(console, 'error').mockImplementation(() => {});

    const { app, managedUserProvider } = buildApp(rejectingAuditLog);
    managedUserProvider.seedUser(BASE_USER);

    const res = await app.request('/users/u-1', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ displayName: 'Updated2' }),
    });

    expect(res.status).toBe(200);
    expect(rejectingAuditLog.logEntry).toHaveBeenCalled();

    errorSpy.mockRestore();
  });

  test('route works correctly when auditLog is omitted', async () => {
    const { app, managedUserProvider } = buildApp(undefined);
    managedUserProvider.seedUser(BASE_USER);

    const res = await app.request('/users/u-1', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ displayName: 'No Audit' }),
    });

    expect(res.status).toBe(200);
  });

  test('failed sensitive operation writes an audit entry', async () => {
    const auditLog: AuditLogProvider = {
      logEntry: mock(async () => {}),
      getLogs: mock(async () => ({ items: [], nextCursor: undefined })),
    };
    const { app } = buildApp(auditLog);

    const res = await app.request('/users/missing/suspend', { method: 'POST' });

    expect(res.status).toBe(404);
    expect(auditLog.logEntry).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'admin.user.suspend',
        resourceId: 'missing',
        status: 404,
      }),
    );
  });

  test('destructive admin endpoints are rate limited', async () => {
    const auditLog: AuditLogProvider = {
      logEntry: mock(async () => {}),
      getLogs: mock(async () => ({ items: [], nextCursor: undefined })),
    };
    const { app, managedUserProvider } = buildApp(auditLog, {
      destructiveRateLimit: { max: 1, windowMs: 60_000 },
    });
    managedUserProvider.seedUser(BASE_USER);

    const first = await app.request('/users/u-1/suspend', { method: 'POST' });
    const second = await app.request('/users/u-1/suspend', { method: 'POST' });

    expect(first.status).toBe(200);
    expect(second.status).toBe(429);
    expect(second.headers.get('Retry-After')).toBeTruthy();
    expect(auditLog.logEntry).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'admin.user.suspend',
        status: 429,
      }),
    );
  });

  test('GET /audit-log user filter is tenant scoped before querying audit backend', async () => {
    const auditLog: AuditLogProvider = {
      logEntry: mock(async () => {}),
      getLogs: mock(async () => ({ items: [], nextCursor: undefined })),
    };
    const { app } = buildApp(auditLog);

    const res = await app.request('/audit-log?userId=outside-tenant');

    expect(res.status).toBe(404);
    expect(auditLog.getLogs).not.toHaveBeenCalled();
  });

  // P-ADMIN-6: every audit-log entry produced by this package fits the
  // 256-char cap on `action`, `resource`, and `resourceId`. We sample a few
  // representative routes; the cap is enforced at write time inside
  // `auditEntry()` so any future caller that tries to log a 100MB string is
  // truncated transparently rather than landing in the audit store.
  test('audit-log entries respect a 256-char cap on action/resource/resourceId', async () => {
    const captured: Parameters<AuditLogProvider['logEntry']>[0][] = [];
    const auditLog: AuditLogProvider = {
      logEntry: mock(async (entry) => {
        captured.push(entry);
      }),
      getLogs: mock(async () => ({ items: [], nextCursor: undefined })),
    };
    const { app, managedUserProvider } = buildApp(auditLog);
    managedUserProvider.seedUser(BASE_USER);

    await app.request('/users/u-1/suspend', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ reason: 'tos' }),
    });
    await app.request('/users/u-1', { method: 'DELETE' });

    expect(captured.length).toBeGreaterThan(0);
    for (const entry of captured) {
      if (entry.action) expect(entry.action.length).toBeLessThanOrEqual(256);
      if (entry.resource) expect(entry.resource.length).toBeLessThanOrEqual(256);
      if (entry.resourceId) expect(entry.resourceId.length).toBeLessThanOrEqual(256);
    }
  });
});
