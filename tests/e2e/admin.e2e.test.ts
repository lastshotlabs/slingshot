/**
 * Admin E2E tests.
 *
 * Spins up a real Bun HTTP server and exercises admin route access control
 * (auth guard, role guard) and core CRUD operations over raw fetch().
 */
import { addUserRole } from '@auth/lib/roles';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import {
  adminPlugin,
  createMemoryAuthAdapter,
  createTestPermissions,
  seedSuperAdmin,
} from '../setup';
import { type E2EServerHandle, createTestHttpServer } from '../setup-e2e';

let handle: E2EServerHandle;
let memoryAuthAdapter: ReturnType<typeof createMemoryAuthAdapter>;
let permissionsAdapter: ReturnType<typeof createTestPermissions>['adapter'];

beforeAll(async () => {
  memoryAuthAdapter = createMemoryAuthAdapter();
  const permissions = createTestPermissions();
  permissionsAdapter = permissions.adapter;
  handle = await createTestHttpServer(
    { plugins: [adminPlugin({ permissions })] },
    { auth: { adapter: memoryAuthAdapter } },
  );
});

afterAll(() => handle.stop());

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function jsonPost(body: Record<string, unknown>): RequestInit {
  return {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  };
}

function authGet(token: string): RequestInit {
  return { headers: { 'x-user-token': token } };
}

function authDelete(token: string): RequestInit {
  return { method: 'DELETE', headers: { 'x-user-token': token } };
}

let _userCounter = 0;
let _adminCounter = 0;

async function registerUser(
  email?: string,
  password = 'password123',
): Promise<{ token: string; userId: string }> {
  const e = email ?? `user${++_userCounter}@example.com`;
  const res = await fetch(`${handle.baseUrl}/auth/register`, jsonPost({ email: e, password }));
  expect(res.status).toBe(201);
  return res.json() as Promise<{ token: string; userId: string }>;
}

async function registerAdmin(email?: string): Promise<{ token: string; userId: string }> {
  const e = email ?? `admin${++_adminCounter}@example.com`;
  const { token, userId } = await registerUser(e);
  await addUserRole(userId, 'admin', undefined, memoryAuthAdapter);
  await seedSuperAdmin(permissionsAdapter, { subjectId: userId });
  return { token, userId };
}

// ---------------------------------------------------------------------------
// Auth guard — GET /admin/users
// ---------------------------------------------------------------------------

describe('admin E2E — auth guard', () => {
  test('returns 401 without auth token', async () => {
    const res = await fetch(`${handle.baseUrl}/admin/users`);
    expect(res.status).toBe(401);
  });

  test('returns 403 for non-admin user', async () => {
    const { token } = await registerUser();
    const res = await fetch(`${handle.baseUrl}/admin/users`, authGet(token));
    expect(res.status).toBe(403);
  });

  test('admin can access GET /admin/users', async () => {
    const { token } = await registerAdmin();
    const res = await fetch(`${handle.baseUrl}/admin/users`, authGet(token));
    expect(res.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// User list
// ---------------------------------------------------------------------------

describe('admin E2E — GET /admin/users', () => {
  test('returns a list of users with pagination metadata', async () => {
    await registerUser('a@example.com');
    await registerUser('b@example.com');
    const { token } = await registerAdmin('admin@example.com');

    const res = await fetch(`${handle.baseUrl}/admin/users`, authGet(token));
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.users).toBeInstanceOf(Array);
    expect(body.users.length).toBeGreaterThanOrEqual(2);
  });

  test('respects limit query param (cursor pagination)', async () => {
    await registerUser('x1@example.com');
    await registerUser('x2@example.com');
    await registerUser('x3@example.com');
    const { token } = await registerAdmin('adminpag@example.com');

    const res = await fetch(`${handle.baseUrl}/admin/users?limit=2`, authGet(token));
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.users.length).toBeLessThanOrEqual(2);
  });
});

// ---------------------------------------------------------------------------
// Single user
// ---------------------------------------------------------------------------

describe('admin E2E — GET /admin/users/:userId', () => {
  test('returns the user record by ID', async () => {
    const { userId } = await registerUser('target@example.com');
    const { token } = await registerAdmin();

    const res = await fetch(`${handle.baseUrl}/admin/users/${userId}`, authGet(token));
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.id).toBe(userId);
    expect(body.email).toBe('target@example.com');
  });

  test('returns 404 for unknown userId', async () => {
    const { token } = await registerAdmin();
    const res = await fetch(`${handle.baseUrl}/admin/users/nonexistent-id`, authGet(token));
    expect(res.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// Delete user
// ---------------------------------------------------------------------------

describe('admin E2E — DELETE /admin/users/:userId', () => {
  test('admin can delete a user', async () => {
    const { userId } = await registerUser('delete-me@example.com');
    const { token } = await registerAdmin();

    const res = await fetch(`${handle.baseUrl}/admin/users/${userId}`, authDelete(token));
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.message).toBe('User deleted');
  });

  test('non-admin cannot delete a user', async () => {
    const { userId } = await registerUser('del-target@example.com');
    const { token: nonAdminToken } = await registerUser('non-admin@example.com');

    const res = await fetch(`${handle.baseUrl}/admin/users/${userId}`, {
      method: 'DELETE',
      headers: { 'x-user-token': nonAdminToken },
    });
    expect(res.status).toBe(403);
  });
});

// ---------------------------------------------------------------------------
// Suspend / unsuspend
// ---------------------------------------------------------------------------

describe('admin E2E — suspend and unsuspend', () => {
  test('admin can suspend a user, preventing login', async () => {
    const { userId } = await registerUser('suspended@example.com');
    const { token } = await registerAdmin();

    const suspendRes = await fetch(`${handle.baseUrl}/admin/users/${userId}/suspend`, {
      method: 'POST',
      headers: { 'x-user-token': token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ reason: 'Policy violation' }),
    });
    expect(suspendRes.status).toBe(200);

    const loginRes = await fetch(
      `${handle.baseUrl}/auth/login`,
      jsonPost({
        email: 'suspended@example.com',
        password: 'password123',
      }),
    );
    expect(loginRes.status).toBe(403);
  });

  test('admin can unsuspend a user, restoring login', async () => {
    const { userId } = await registerUser('revived@example.com');
    const { token } = await registerAdmin();

    // Suspend
    await fetch(`${handle.baseUrl}/admin/users/${userId}/suspend`, {
      method: 'POST',
      headers: { 'x-user-token': token, 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });

    // Unsuspend
    const unsuspendRes = await fetch(`${handle.baseUrl}/admin/users/${userId}/unsuspend`, {
      method: 'POST',
      headers: { 'x-user-token': token },
    });
    expect(unsuspendRes.status).toBe(200);

    // Login should succeed
    const loginRes = await fetch(
      `${handle.baseUrl}/auth/login`,
      jsonPost({
        email: 'revived@example.com',
        password: 'password123',
      }),
    );
    expect(loginRes.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// Capabilities
// ---------------------------------------------------------------------------

describe('admin E2E — GET /admin/capabilities', () => {
  test('returns capability flags for admin user', async () => {
    const { token } = await registerAdmin();
    const res = await fetch(`${handle.baseUrl}/admin/capabilities`, authGet(token));
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(typeof body.canListUsers).toBe('boolean');
    expect(typeof body.canViewUser).toBe('boolean');
    expect(body.canListUsers).toBe(true);
  });

  test('returns 403 for non-admin user', async () => {
    const { token } = await registerUser('non-admin-capabilities@example.com');
    const res = await fetch(`${handle.baseUrl}/admin/capabilities`, authGet(token));
    expect(res.status).toBe(403);
  });
});

// ---------------------------------------------------------------------------
// Session management
// ---------------------------------------------------------------------------

describe('admin E2E — session management', () => {
  test('GET /admin/users/:userId/sessions returns session list', async () => {
    const { userId } = await registerUser('sessions@example.com');
    const { token } = await registerAdmin();

    const res = await fetch(`${handle.baseUrl}/admin/users/${userId}/sessions`, authGet(token));
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.sessions).toBeInstanceOf(Array);
  });

  test('DELETE /admin/users/:userId/sessions revokes all sessions', async () => {
    const { userId } = await registerUser('kill-sessions@example.com');
    const { token } = await registerAdmin();

    const res = await fetch(`${handle.baseUrl}/admin/users/${userId}/sessions`, authDelete(token));
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.message).toBe('Sessions revoked');
  });
});
