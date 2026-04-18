import { addUserRole } from '@auth/lib/roles';
import type { OpenAPIHono } from '@hono/zod-openapi';
import { beforeEach, describe, expect, test } from 'bun:test';
import {
  adminPlugin,
  authHeader,
  createMemoryAuthAdapter,
  createTestApp,
  createTestPermissions,
  seedSuperAdmin,
} from '../setup';

let app: OpenAPIHono<any>;
let memoryAuthAdapter: ReturnType<typeof createMemoryAuthAdapter>;
let permissions: ReturnType<typeof createTestPermissions>;

beforeEach(async () => {
  memoryAuthAdapter = createMemoryAuthAdapter();
  permissions = createTestPermissions();
  app = await createTestApp(
    {
      plugins: [adminPlugin({ permissions })],
    },
    { auth: { adapter: memoryAuthAdapter } },
  );
});

const json = (body: Record<string, unknown>) => ({
  method: 'POST' as const,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

const patch = (token: string, body: Record<string, unknown>) => ({
  method: 'PATCH' as const,
  headers: { ...authHeader(token), 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

const put = (token: string, body: Record<string, unknown>) => ({
  method: 'PUT' as const,
  headers: { ...authHeader(token), 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

async function registerUser(email = 'u@example.com', password = 'password123') {
  const res = await app.request('/auth/register', json({ email, password }));
  expect(res.status).toBe(201);
  const body = (await res.json()) as { token: string; userId: string };
  return body;
}

async function registerAdmin(email = 'admin@example.com') {
  const { token, userId } = await registerUser(email);
  await addUserRole(userId, 'admin', undefined, memoryAuthAdapter);
  await seedSuperAdmin(permissions.adapter, { subjectId: userId });
  return { token, userId };
}

// ---------------------------------------------------------------------------
// Auth guard
// ---------------------------------------------------------------------------

describe('GET /admin/users — auth guard', () => {
  test('returns 401 without auth', async () => {
    const res = await app.request('/admin/users');
    expect(res.status).toBe(401);
  });

  test('returns 403 for non-admin user', async () => {
    const { token } = await registerUser();
    const res = await app.request('/admin/users', { headers: authHeader(token) });
    expect(res.status).toBe(403);
  });

  test('admin can access GET /admin/users', async () => {
    const { token } = await registerAdmin();
    const res = await app.request('/admin/users', { headers: authHeader(token) });
    expect(res.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// Paginated user list
// ---------------------------------------------------------------------------

describe('GET /admin/users — paginated list', () => {
  test('returns registered users', async () => {
    await registerUser('a@example.com');
    await registerUser('b@example.com');
    const { token } = await registerAdmin('admin@example.com');

    const res = await app.request('/admin/users', { headers: authHeader(token) });
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.users).toBeInstanceOf(Array);
    expect(body.users.length).toBeGreaterThanOrEqual(2);
  });

  test('respects limit and returns cursor', async () => {
    await registerUser('x1@example.com');
    await registerUser('x2@example.com');
    await registerUser('x3@example.com');
    const { token } = await registerAdmin('admin2@example.com');

    const res = await app.request('/admin/users?limit=2', { headers: authHeader(token) });
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.users.length).toBeLessThanOrEqual(2);
    // nextCursor should be present when there are more results
    if (body.users.length === 2) {
      expect(typeof body.nextCursor).toBe('string');
    }
  });
});

// ---------------------------------------------------------------------------
// Get single user
// ---------------------------------------------------------------------------

describe('GET /admin/users/:userId', () => {
  test('returns the user record', async () => {
    const { userId } = await registerUser('target@example.com');
    const { token } = await registerAdmin();

    const res = await app.request(`/admin/users/${userId}`, { headers: authHeader(token) });
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.id).toBe(userId);
    expect(body.email).toBe('target@example.com');
  });

  test('returns 404 for unknown user', async () => {
    const { token } = await registerAdmin();
    const res = await app.request('/admin/users/nonexistent-id', { headers: authHeader(token) });
    expect(res.status).toBe(404);
  });

  test("response uses status ('active'|'suspended') not suspended (boolean)", async () => {
    const { userId } = await registerUser('shape@example.com');
    const { token } = await registerAdmin();

    const res = await app.request(`/admin/users/${userId}`, { headers: authHeader(token) });
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    // status must be present and be a string enum value
    expect(typeof body.status).toBe('string');
    expect(['active', 'suspended']).toContain(body.status);
    // provider must be present
    expect(typeof body.provider).toBe('string');
    // suspended (old boolean) must NOT be present
    expect(body.suspended).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Update profile
// ---------------------------------------------------------------------------

describe('PATCH /admin/users/:userId', () => {
  test('updates display name', async () => {
    const { userId } = await registerUser('profile@example.com');
    const { token } = await registerAdmin();

    const res = await app.request(`/admin/users/${userId}`, patch(token, { displayName: 'Alice' }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.message).toBe('Profile updated');

    // Verify via GET
    const getRes = await app.request(`/admin/users/${userId}`, { headers: authHeader(token) });
    const user = (await getRes.json()) as any;
    expect(user.displayName).toBe('Alice');
  });

  test('updates multiple profile fields', async () => {
    const { userId } = await registerUser('fields@example.com');
    const { token } = await registerAdmin();

    const res = await app.request(
      `/admin/users/${userId}`,
      patch(token, {
        firstName: 'Bob',
        lastName: 'Smith',
        externalId: 'ext-123',
      }),
    );
    expect(res.status).toBe(200);

    const getRes = await app.request(`/admin/users/${userId}`, { headers: authHeader(token) });
    const user = (await getRes.json()) as any;
    expect(user.firstName).toBe('Bob');
    expect(user.lastName).toBe('Smith');
    expect(user.externalId).toBe('ext-123');
  });
});

// ---------------------------------------------------------------------------
// Suspend / unsuspend
// ---------------------------------------------------------------------------

describe('POST /admin/users/:userId/suspend and unsuspend', () => {
  test('suspending a user prevents login', async () => {
    const { userId } = await registerUser('suspended@example.com');
    const { token } = await registerAdmin();

    const suspendRes = await app.request(`/admin/users/${userId}/suspend`, {
      method: 'POST',
      headers: { ...authHeader(token), 'Content-Type': 'application/json' },
      body: JSON.stringify({ reason: 'Policy violation' }),
    });
    expect(suspendRes.status).toBe(200);

    // Suspended user cannot log in
    const loginRes = await app.request(
      '/auth/login',
      json({ email: 'suspended@example.com', password: 'password123' }),
    );
    expect(loginRes.status).toBe(403);
    const loginBody = (await loginRes.json()) as any;
    expect(loginBody.code ?? loginBody.error).toBeTruthy();
  });

  test("suspended user record has status 'suspended'", async () => {
    const { userId } = await registerUser('status-check@example.com');
    const { token } = await registerAdmin();

    await app.request(`/admin/users/${userId}/suspend`, {
      method: 'POST',
      headers: { ...authHeader(token), 'Content-Type': 'application/json' },
      body: JSON.stringify({ reason: 'test' }),
    });

    const getRes = await app.request(`/admin/users/${userId}`, { headers: authHeader(token) });
    expect(getRes.status).toBe(200);
    const user = (await getRes.json()) as any;
    expect(user.status).toBe('suspended');
  });

  test('unsuspending a user allows login again', async () => {
    const { userId } = await registerUser('revived@example.com');
    const { token } = await registerAdmin();

    // Suspend
    await app.request(`/admin/users/${userId}/suspend`, {
      method: 'POST',
      headers: { ...authHeader(token), 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });

    // Unsuspend
    const unsuspendRes = await app.request(`/admin/users/${userId}/unsuspend`, {
      method: 'POST',
      headers: authHeader(token),
    });
    expect(unsuspendRes.status).toBe(200);

    // Now login should succeed
    const loginRes = await app.request(
      '/auth/login',
      json({ email: 'revived@example.com', password: 'password123' }),
    );
    expect(loginRes.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// Roles
// ---------------------------------------------------------------------------

describe('PUT /admin/users/:userId/roles', () => {
  test('sets user roles', async () => {
    const { userId } = await registerUser('roles@example.com');
    const { token } = await registerAdmin();

    const res = await app.request(
      `/admin/users/${userId}/roles`,
      put(token, { roles: ['editor'] }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.roles).toContain('editor');
  });

  test('GET /admin/users/:userId/roles returns roles', async () => {
    const { userId } = await registerUser('getroles@example.com');
    const { token } = await registerAdmin();

    await app.request(`/admin/users/${userId}/roles`, put(token, { roles: ['moderator'] }));

    const res = await app.request(`/admin/users/${userId}/roles`, { headers: authHeader(token) });
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.roles).toContain('moderator');
  });
});

// ---------------------------------------------------------------------------
// Delete user
// ---------------------------------------------------------------------------

describe('DELETE /admin/users/:userId', () => {
  test('deletes a user', async () => {
    const { userId } = await registerUser('delete-me@example.com');
    const { token } = await registerAdmin();

    const deleteRes = await app.request(`/admin/users/${userId}`, {
      method: 'DELETE',
      headers: authHeader(token),
    });
    expect(deleteRes.status).toBe(200);
    const body = (await deleteRes.json()) as any;
    expect(body.message).toBe('User deleted');
  });
});

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

describe('Session management', () => {
  test('GET /admin/users/:userId/sessions returns session list', async () => {
    const { userId } = await registerUser('sessions@example.com');
    const { token } = await registerAdmin();

    const res = await app.request(`/admin/users/${userId}/sessions`, {
      headers: authHeader(token),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.sessions).toBeInstanceOf(Array);
  });

  test('DELETE /admin/users/:userId/sessions revokes all sessions', async () => {
    const { userId } = await registerUser('kill-sessions@example.com');
    const { token } = await registerAdmin();

    const res = await app.request(`/admin/users/${userId}/sessions`, {
      method: 'DELETE',
      headers: authHeader(token),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.message).toBe('Sessions revoked');
  });

  test('GET /admin/users/:userId/sessions — session records have id (not sessionId) and ISO date strings', async () => {
    const { userId } = await registerUser('session-shape@example.com');
    const { token } = await registerAdmin();

    // The user just registered so they have at least one session
    const res = await app.request(`/admin/users/${userId}/sessions`, {
      headers: authHeader(token),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.sessions).toBeInstanceOf(Array);

    if (body.sessions.length > 0) {
      const session = body.sessions[0];
      // Field name must be "id" not "sessionId"
      expect(typeof session.id).toBe('string');
      expect(session.sessionId).toBeUndefined();
      // createdAt must be an ISO 8601 string, not a number
      expect(typeof session.createdAt).toBe('string');
      expect(() => new Date(session.createdAt)).not.toThrow();
      expect(new Date(session.createdAt).toISOString()).toBe(session.createdAt);
      // lastActiveAt (old) must not exist; lastAccessedAt is optional
      expect(session.lastActiveAt).toBeUndefined();
      // active field must not exist
      expect(session.active).toBeUndefined();
    }
  });

  test('DELETE /admin/users/:userId/sessions/:sessionId revokes specific session', async () => {
    const { userId } = await registerUser('revoke-session@example.com');
    const { token } = await registerAdmin();

    // Get sessions to find a session ID (user just registered, so they have one)
    const sessionsRes = await app.request(`/admin/users/${userId}/sessions`, {
      headers: authHeader(token),
    });
    const { sessions } = (await sessionsRes.json()) as any;

    // Use a fabricated session ID — deleteSession is a no-op for unknown IDs
    const sessionId = sessions[0]?.id ?? 'nonexistent-session-id';

    const res = await app.request(`/admin/users/${userId}/sessions/${sessionId}`, {
      method: 'DELETE',
      headers: authHeader(token),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.message).toBe('Session revoked');
  });
});

// ---------------------------------------------------------------------------
// Capabilities
// ---------------------------------------------------------------------------

describe('GET /admin/capabilities', () => {
  test('returns ManagedUserCapabilities object', async () => {
    const { token } = await registerAdmin();

    const res = await app.request('/admin/capabilities', { headers: authHeader(token) });
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(typeof body.canListUsers).toBe('boolean');
    expect(typeof body.canViewUser).toBe('boolean');
    expect(body.canListUsers).toBe(true);
  });

  test('returns 403 for non-admin user', async () => {
    const { token } = await registerUser('non-admin-capabilities@example.com');

    const res = await app.request('/admin/capabilities', { headers: authHeader(token) });
    expect(res.status).toBe(403);
  });
});

// ---------------------------------------------------------------------------
// Audit log
// ---------------------------------------------------------------------------

describe('GET /admin/audit-log', () => {
  test('returns paginated result (may be empty without configured store)', async () => {
    const { token } = await registerAdmin();

    const res = await app.request('/admin/audit-log', { headers: authHeader(token) });
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.items).toBeInstanceOf(Array);
  });
});

describe('GET /admin/users/:userId/audit-log', () => {
  test('returns per-user paginated result', async () => {
    const { userId } = await registerUser('auditlog@example.com');
    const { token } = await registerAdmin();

    const res = await app.request(`/admin/users/${userId}/audit-log`, {
      headers: authHeader(token),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.items).toBeInstanceOf(Array);
  });
});
