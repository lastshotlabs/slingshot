import { describe, expect, test } from 'bun:test';
import { Hono } from 'hono';
import { createInProcessAdapter } from '@lastshotlabs/slingshot-core';
import { createMemoryManagedUserProvider } from '../../src/providers/memoryAccess';
import { createAdminRouter } from '../../src/routes/admin';
import type { AdminEnv } from '../../src/types/env';

function buildApp() {
  const managedUserProvider = createMemoryManagedUserProvider();
  const app = new Hono<AdminEnv>();

  app.use('*', async (c, next) => {
    c.set('adminPrincipal', {
      subject: 'tenant-admin',
      provider: 'memory',
      tenantId: 'tenant-a',
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

describe('tenant-scoped admin routes', () => {
  test('GET /users only returns users in the principal tenant', async () => {
    const { app, managedUserProvider } = buildApp();
    managedUserProvider.seedUser({
      id: 'user-a',
      tenantId: 'tenant-a',
      email: 'alice@example.com',
      provider: 'memory',
      status: 'active',
    });
    managedUserProvider.seedUser({
      id: 'user-b',
      tenantId: 'tenant-b',
      email: 'bob@example.com',
      provider: 'memory',
      status: 'active',
    });

    const response = await app.request('/users');
    expect(response.status).toBe(200);
    const body = (await response.json()) as { users: Array<{ id: string }> };
    expect(body.users.map(user => user.id)).toEqual(['user-a']);
  });

  test('cross-tenant user and session reads return 404', async () => {
    const { app, managedUserProvider } = buildApp();
    managedUserProvider.seedUser({
      id: 'user-b',
      tenantId: 'tenant-b',
      email: 'bob@example.com',
      provider: 'memory',
      status: 'active',
    });
    managedUserProvider.seedSession({
      sessionId: 'session-b',
      userId: 'user-b',
      createdAt: Date.now(),
      lastActiveAt: Date.now(),
      active: true,
    });

    const userResponse = await app.request('/users/user-b');
    expect(userResponse.status).toBe(404);

    const sessionResponse = await app.request('/users/user-b/sessions');
    expect(sessionResponse.status).toBe(404);
  });
});
