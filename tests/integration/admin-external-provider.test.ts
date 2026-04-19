import type { OpenAPIHono } from '@hono/zod-openapi';
import { beforeEach, describe, expect, test } from 'bun:test';
import { createAdminPlugin } from '@lastshotlabs/slingshot-admin';
import type {
  AdminAccessProvider,
  AdminPrincipal,
  ManagedUserProvider,
} from '@lastshotlabs/slingshot-core';
import { createTestApp, createTestPermissions, seedSuperAdmin } from '../setup';

const MOCK_PRINCIPAL: AdminPrincipal = {
  subject: 'mock-admin-id',
  provider: 'mock',
  email: 'admin@mock.example.com',
  displayName: 'Mock Admin',
  roles: ['admin'],
};

function createMockAccessProvider(
  allowAll = true,
): AdminAccessProvider & { lastRequest: { verified: boolean } } {
  const state = { lastRequest: { verified: true } };
  const provider: AdminAccessProvider & { lastRequest: { verified: boolean } } = {
    name: 'mock',
    lastRequest: state.lastRequest,
    async verifyRequest() {
      return allowAll ? MOCK_PRINCIPAL : null;
    },
  };
  return provider;
}

function createMockManagedUserProvider(): ManagedUserProvider {
  return {
    name: 'mock-users',
    async listUsers() {
      return { items: [], total: 0 };
    },
    async getUser() {
      return null;
    },
    async getCapabilities() {
      return {
        canListUsers: true,
        canSearchUsers: false,
        canViewUser: true,
        canSuspendUsers: false,
        canDeleteUsers: false,
        canViewSessions: false,
        canRevokeSessions: false,
        canManageRoles: false,
      };
    },
  };
}

describe('admin plugin — external providers', () => {
  let app: OpenAPIHono<any>;
  let permissions: ReturnType<typeof createTestPermissions>;

  beforeEach(async () => {
    permissions = createTestPermissions();
    await seedSuperAdmin(permissions.adapter, { subjectId: 'mock-admin-id' });

    const mockAccess = createMockAccessProvider(true);
    const mockUsers = createMockManagedUserProvider();
    const plugin = createAdminPlugin({
      accessProvider: mockAccess,
      managedUserProvider: mockUsers,
      permissions,
    });
    app = await createTestApp({ plugins: [plugin] });
  });

  test('GET /admin/capabilities returns degraded capabilities', async () => {
    const res = await app.request('/admin/capabilities');
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.canListUsers).toBe(true);
    expect(body.canSuspendUsers).toBe(false);
    expect(body.canDeleteUsers).toBe(false);
    expect(body.canRevokeSessions).toBe(false);
    expect(body.canManageRoles).toBe(false);
    expect(body.managedUserProvider).toBe('mock-users');
  });

  test('plugin.dependencies does not include slingshot-auth when both providers are supplied', () => {
    const mockAccess = createMockAccessProvider(true);
    const mockUsers = createMockManagedUserProvider();
    const plugin = createAdminPlugin({
      accessProvider: mockAccess,
      managedUserProvider: mockUsers,
      permissions,
    });
    expect(plugin.dependencies).not.toContain('slingshot-auth');
    expect(plugin.dependencies?.length).toBe(0);
  });

  test('guard returns 401 when mock access provider verifyRequest returns null', async () => {
    const rejectingAccess = createMockAccessProvider(false);
    const mockUsers = createMockManagedUserProvider();
    const plugin = createAdminPlugin({
      accessProvider: rejectingAccess,
      managedUserProvider: mockUsers,
      permissions,
    });
    const testApp = await createTestApp({ plugins: [plugin] });

    const res = await testApp.request('/admin/capabilities');
    expect(res.status).toBe(401);
  });
});

describe('admin plugin — 501 for unsupported operations', () => {
  let limitedApp: OpenAPIHono<any>;
  let limitedPermissions: ReturnType<typeof createTestPermissions>;

  beforeEach(async () => {
    limitedPermissions = createTestPermissions();
    await seedSuperAdmin(limitedPermissions.adapter, { subjectId: 'mock-admin-id' });

    const mockAccess = createMockAccessProvider(true);
    const mockUsers = createMockManagedUserProvider();
    const plugin = createAdminPlugin({
      accessProvider: mockAccess,
      managedUserProvider: mockUsers,
      permissions: limitedPermissions,
    });
    limitedApp = await createTestApp({ plugins: [plugin] });
  });

  test('POST /admin/users/:userId/suspend returns 501 when suspendUser not supported', async () => {
    const res = await limitedApp.request('/admin/users/any-user-id/suspend', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reason: 'test' }),
    });
    expect(res.status).toBe(501);
    const body = (await res.json()) as any;
    expect(body.error).toContain('not supported');
  });

  test('POST /admin/users/:userId/unsuspend returns 501 when unsuspendUser not supported', async () => {
    const res = await limitedApp.request('/admin/users/any-user-id/unsuspend', {
      method: 'POST',
    });
    expect(res.status).toBe(501);
  });

  test('PUT /admin/users/:userId/roles returns 501 when setRoles not supported', async () => {
    const res = await limitedApp.request('/admin/users/any-user-id/roles', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ roles: ['editor'] }),
    });
    expect(res.status).toBe(501);
  });

  test('DELETE /admin/users/:userId/sessions returns 501 when revokeAllSessions not supported', async () => {
    const res = await limitedApp.request('/admin/users/any-user-id/sessions', {
      method: 'DELETE',
    });
    expect(res.status).toBe(501);
  });

  test('DELETE /admin/users/:userId/sessions/:sessionId returns 501 when revokeSession not supported', async () => {
    const res = await limitedApp.request('/admin/users/any-user-id/sessions/some-session-id', {
      method: 'DELETE',
    });
    expect(res.status).toBe(501);
  });

  test('DELETE /admin/users/:userId returns 501 when deleteUser not supported', async () => {
    const res = await limitedApp.request('/admin/users/any-user-id', {
      method: 'DELETE',
    });
    expect(res.status).toBe(501);
  });

  test('PATCH /admin/users/:userId returns 501 when updateUser not supported', async () => {
    const res = await limitedApp.request('/admin/users/any-user-id', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ displayName: 'Test' }),
    });
    expect(res.status).toBe(501);
  });
});
