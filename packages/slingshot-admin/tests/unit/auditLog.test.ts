import { describe, expect, mock, spyOn, test } from 'bun:test';
import { Hono } from 'hono';
import { createInProcessAdapter } from '@lastshotlabs/slingshot-core';
import { createMemoryManagedUserProvider } from '../../src/providers/memoryAccess';
import { createAdminRouter } from '../../src/routes/admin';
import type { AdminEnv } from '../../src/types/env';
import type { AuditLogProvider } from '@lastshotlabs/slingshot-core';

function buildApp(auditLog?: AuditLogProvider) {
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
      listEntries: mock(async () => ({ items: [], nextCursor: undefined })),
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
      listEntries: mock(async () => ({ items: [], nextCursor: undefined })),
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
});
