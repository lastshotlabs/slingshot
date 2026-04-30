import { describe, expect, mock, test } from 'bun:test';
import { Hono } from 'hono';
import { createScimRouter } from '../src/routes/scim';

const defaultUser = {
  id: 'user-1',
  email: 'member@example.com',
  displayName: 'Member',
  firstName: 'Member',
  lastName: 'User',
  externalId: 'ext-1',
  suspended: false,
};

function buildRuntime(overrides: Partial<Record<string, unknown>> = {}) {
  const sessions: Array<{ sessionId: string }> = [];

  const runtime = {
    adapter: {
      findByEmail: async () => null,
      create: async () => ({ id: 'user-1' }),
      getUser: async () => ({ ...defaultUser }),
      updateProfile: async () => {},
      setSuspended: async () => {},
      deleteUser: async () => {},
      listUsers: async (query: Record<string, unknown>) => ({
        users: [defaultUser],
        totalResults: 1,
      }),
    },
    config: {
      scim: {
        bearerTokens: ['scim-secret'],
        userMapping: {},
      },
    },
    password: {
      hash: async (plain: string) => `hashed:${plain}`,
      verify: async () => true,
    },
    rateLimit: {
      trackAttempt: async () => false,
    },
    repos: {
      session: {
        getUserSessions: async () => sessions,
        deleteSession: async () => {},
      },
    },
    ...overrides,
  };

  const app = new Hono();
  app.route('/', createScimRouter(runtime as never));
  return { app, sessions };
}

const authHeaders = {
  'content-type': 'application/json',
  Authorization: 'Bearer scim-secret',
};

// ---------------------------------------------------------------------------
// GET /scim/v2/Users — list with pagination
// ---------------------------------------------------------------------------

describe('GET /scim/v2/Users — list with pagination', () => {
  test('returns a ListResponse with correct envelope', async () => {
    const users = [
      { ...defaultUser, id: 'u-1' },
      { ...defaultUser, id: 'u-2', email: 'user2@example.com' },
    ];
    const listUsers = mock(async () => ({ users, totalResults: 5 }));
    const { app } = buildRuntime({
      adapter: {
        findByEmail: async () => null,
        create: async () => ({ id: 'user-1' }),
        getUser: async () => defaultUser,
        updateProfile: async () => {},
        setSuspended: async () => {},
        listUsers,
      },
    });

    const res = await app.request('/scim/v2/Users?startIndex=1&count=2', {
      headers: { Authorization: 'Bearer scim-secret' },
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.schemas).toEqual(['urn:ietf:params:scim:api:messages:2.0:ListResponse']);
    expect(body.totalResults).toBe(5);
    expect(body.startIndex).toBe(1);
    expect(body.itemsPerPage).toBe(2);
    expect(body.Resources).toHaveLength(2);
    expect(body.Resources[0].id).toBe('u-1');
    expect(body.Resources[1].id).toBe('u-2');
  });

  test('passes filter parameters through to the adapter', async () => {
    const listUsers = mock(async (_query: Record<string, unknown>) => ({
      users: [],
      totalResults: 0,
    }));
    const { app } = buildRuntime({
      adapter: {
        findByEmail: async () => null,
        create: async () => ({ id: 'user-1' }),
        getUser: async () => defaultUser,
        updateProfile: async () => {},
        setSuspended: async () => {},
        listUsers,
      },
    });

    const res = await app.request(
      '/scim/v2/Users?filter=' + encodeURIComponent('userName eq "alice@test.com"'),
      { headers: { Authorization: 'Bearer scim-secret' } },
    );

    expect(res.status).toBe(200);
    expect(listUsers).toHaveBeenCalledTimes(1);
    const query = listUsers.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(query.email).toBe('alice@test.com');
  });

  test('returns 400 for compound filter expressions', async () => {
    const listUsers = mock(async () => ({ users: [], totalResults: 0 }));
    const { app } = buildRuntime({
      adapter: {
        findByEmail: async () => null,
        create: async () => ({ id: 'user-1' }),
        getUser: async () => defaultUser,
        updateProfile: async () => {},
        setSuspended: async () => {},
        listUsers,
      },
    });

    const res = await app.request(
      '/scim/v2/Users?filter=' + encodeURIComponent('userName eq "a" AND active eq "true"'),
      { headers: { Authorization: 'Bearer scim-secret' } },
    );

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.scimType).toBe('invalidFilter');
    expect(listUsers).not.toHaveBeenCalled();
  });

  test('returns 501 when adapter does not support listUsers', async () => {
    const { app } = buildRuntime({
      adapter: {
        findByEmail: async () => null,
        create: async () => ({ id: 'user-1' }),
        getUser: async () => defaultUser,
        updateProfile: async () => {},
        setSuspended: async () => {},
        // no listUsers
      },
    });

    const res = await app.request('/scim/v2/Users', {
      headers: { Authorization: 'Bearer scim-secret' },
    });

    expect(res.status).toBe(501);
  });
});

// ---------------------------------------------------------------------------
// GET /scim/v2/Users/:id — get single user
// ---------------------------------------------------------------------------

describe('GET /scim/v2/Users/:id — get single user', () => {
  test('returns a single user in SCIM format', async () => {
    const { app } = buildRuntime();

    const res = await app.request('/scim/v2/Users/user-1', {
      headers: { Authorization: 'Bearer scim-secret' },
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.schemas).toEqual(['urn:ietf:params:scim:schemas:core:2.0:User']);
    expect(body.id).toBe('user-1');
    expect(body.userName).toBe('member@example.com');
    expect(body.active).toBe(true);
    expect(body.emails).toEqual([{ value: 'member@example.com', primary: true }]);
  });

  test('returns 404 when user does not exist', async () => {
    const { app } = buildRuntime({
      adapter: {
        findByEmail: async () => null,
        create: async () => ({ id: 'user-1' }),
        getUser: async () => null,
        updateProfile: async () => {},
        setSuspended: async () => {},
      },
    });

    const res = await app.request('/scim/v2/Users/nonexistent', {
      headers: { Authorization: 'Bearer scim-secret' },
    });

    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.detail).toBe('User not found');
  });

  test('returns 501 when adapter does not support getUser', async () => {
    const { app } = buildRuntime({
      adapter: {
        findByEmail: async () => null,
        create: async () => ({ id: 'user-1' }),
        // no getUser
        updateProfile: async () => {},
        setSuspended: async () => {},
      },
    });

    const res = await app.request('/scim/v2/Users/user-1', {
      headers: { Authorization: 'Bearer scim-secret' },
    });

    expect(res.status).toBe(501);
  });
});

// ---------------------------------------------------------------------------
// PUT /scim/v2/Users/:id — replace user
// ---------------------------------------------------------------------------

describe('PUT /scim/v2/Users/:id — replace user', () => {
  test('replaces user profile fields and returns updated user', async () => {
    const updateProfile = mock(async () => {});
    const updatedUser = {
      ...defaultUser,
      displayName: 'Updated Name',
      firstName: 'Updated',
      lastName: 'Name',
    };
    let callCount = 0;
    const { app } = buildRuntime({
      adapter: {
        findByEmail: async () => null,
        create: async () => ({ id: 'user-1' }),
        getUser: async () => {
          callCount++;
          // First call returns original, second returns updated
          return callCount > 1 ? updatedUser : defaultUser;
        },
        updateProfile,
        setSuspended: async () => {},
      },
    });

    const res = await app.request('/scim/v2/Users/user-1', {
      method: 'PUT',
      headers: authHeaders,
      body: JSON.stringify({
        schemas: ['urn:ietf:params:scim:schemas:core:2.0:User'],
        userName: 'member@example.com',
        displayName: 'Updated Name',
        name: { givenName: 'Updated', familyName: 'Name' },
      }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.displayName).toBe('Updated Name');
    expect(updateProfile).toHaveBeenCalledTimes(1);
    const profileCall = updateProfile.mock.calls[0] as unknown as [string, Record<string, string>];
    expect(profileCall[0]).toBe('user-1');
    expect(profileCall[1]).toMatchObject({
      displayName: 'Updated Name',
      firstName: 'Updated',
      lastName: 'Name',
    });
  });

  test('suspends user and revokes sessions when active=false', async () => {
    const setSuspended = mock(async () => {});
    const deletedSessions: string[] = [];
    const { app } = buildRuntime({
      adapter: {
        findByEmail: async () => null,
        create: async () => ({ id: 'user-1' }),
        getUser: async () => defaultUser,
        updateProfile: async () => {},
        setSuspended,
      },
      repos: {
        session: {
          getUserSessions: async () => [{ sessionId: 'sess-1' }, { sessionId: 'sess-2' }],
          deleteSession: async (id: string) => {
            deletedSessions.push(id);
          },
        },
      },
    });

    const res = await app.request('/scim/v2/Users/user-1', {
      method: 'PUT',
      headers: authHeaders,
      body: JSON.stringify({
        schemas: ['urn:ietf:params:scim:schemas:core:2.0:User'],
        userName: 'member@example.com',
        active: false,
      }),
    });

    expect(res.status).toBe(200);
    expect(setSuspended).toHaveBeenCalledWith('user-1', true);
    expect(deletedSessions).toEqual(['sess-1', 'sess-2']);
  });

  test('returns 404 when the user does not exist', async () => {
    const { app } = buildRuntime({
      adapter: {
        findByEmail: async () => null,
        create: async () => ({ id: 'user-1' }),
        getUser: async () => null,
        updateProfile: async () => {},
        setSuspended: async () => {},
      },
    });

    const res = await app.request('/scim/v2/Users/nonexistent', {
      method: 'PUT',
      headers: authHeaders,
      body: JSON.stringify({
        schemas: ['urn:ietf:params:scim:schemas:core:2.0:User'],
        userName: 'member@example.com',
      }),
    });

    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.detail).toBe('User not found');
  });

  test('returns 400 when body id does not match path param', async () => {
    const { app } = buildRuntime();

    const res = await app.request('/scim/v2/Users/user-1', {
      method: 'PUT',
      headers: authHeaders,
      body: JSON.stringify({
        schemas: ['urn:ietf:params:scim:schemas:core:2.0:User'],
        id: 'user-999',
        userName: 'member@example.com',
      }),
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.detail).toBe('id in body does not match path parameter');
  });

  test('returns 501 when active is requested but adapter lacks setSuspended', async () => {
    const { app } = buildRuntime({
      adapter: {
        findByEmail: async () => null,
        create: async () => ({ id: 'user-1' }),
        getUser: async () => defaultUser,
        updateProfile: async () => {},
        // no setSuspended
      },
    });

    const res = await app.request('/scim/v2/Users/user-1', {
      method: 'PUT',
      headers: authHeaders,
      body: JSON.stringify({
        schemas: ['urn:ietf:params:scim:schemas:core:2.0:User'],
        userName: 'member@example.com',
        active: false,
      }),
    });

    expect(res.status).toBe(501);
  });
});

// ---------------------------------------------------------------------------
// DELETE /scim/v2/Users/:id — deprovision modes
// ---------------------------------------------------------------------------

describe('DELETE /scim/v2/Users/:id — deprovision', () => {
  test('suspend mode (default) suspends the user and revokes sessions', async () => {
    const setSuspended = mock(async () => {});
    const deletedSessions: string[] = [];
    const { app } = buildRuntime({
      adapter: {
        findByEmail: async () => null,
        create: async () => ({ id: 'user-1' }),
        getUser: async () => defaultUser,
        updateProfile: async () => {},
        setSuspended,
      },
      repos: {
        session: {
          getUserSessions: async () => [{ sessionId: 'sess-1' }],
          deleteSession: async (id: string) => {
            deletedSessions.push(id);
          },
        },
      },
    });

    const res = await app.request('/scim/v2/Users/user-1', {
      method: 'DELETE',
      headers: { Authorization: 'Bearer scim-secret' },
    });

    expect(res.status).toBe(204);
    expect(setSuspended).toHaveBeenCalledWith('user-1', true, 'SCIM deprovisioned');
    expect(deletedSessions).toEqual(['sess-1']);
  });

  test('delete mode deletes the user and revokes sessions', async () => {
    const deleteUser = mock(async () => {});
    const deletedSessions: string[] = [];
    const { app } = buildRuntime({
      adapter: {
        findByEmail: async () => null,
        create: async () => ({ id: 'user-1' }),
        getUser: async () => defaultUser,
        updateProfile: async () => {},
        setSuspended: async () => {},
        deleteUser,
      },
      config: {
        scim: {
          bearerTokens: ['scim-secret'],
          userMapping: {},
          onDeprovision: 'delete',
        },
      },
      repos: {
        session: {
          getUserSessions: async () => [{ sessionId: 'sess-del' }],
          deleteSession: async (id: string) => {
            deletedSessions.push(id);
          },
        },
      },
    });

    const res = await app.request('/scim/v2/Users/user-1', {
      method: 'DELETE',
      headers: { Authorization: 'Bearer scim-secret' },
    });

    expect(res.status).toBe(204);
    expect(deleteUser).toHaveBeenCalledWith('user-1');
    expect(deletedSessions).toEqual(['sess-del']);
  });

  test('custom deprovision function is called and sessions are revoked', async () => {
    const customHandler = mock(async () => {});
    const deletedSessions: string[] = [];
    const { app } = buildRuntime({
      config: {
        scim: {
          bearerTokens: ['scim-secret'],
          userMapping: {},
          onDeprovision: customHandler,
        },
      },
      repos: {
        session: {
          getUserSessions: async () => [{ sessionId: 'sess-custom' }],
          deleteSession: async (id: string) => {
            deletedSessions.push(id);
          },
        },
      },
    });

    const res = await app.request('/scim/v2/Users/user-1', {
      method: 'DELETE',
      headers: { Authorization: 'Bearer scim-secret' },
    });

    expect(res.status).toBe(204);
    expect(customHandler).toHaveBeenCalledWith('user-1');
    expect(deletedSessions).toEqual(['sess-custom']);
  });

  test('returns 404 when user does not exist', async () => {
    const { app } = buildRuntime({
      adapter: {
        findByEmail: async () => null,
        create: async () => ({ id: 'user-1' }),
        getUser: async () => null,
        updateProfile: async () => {},
        setSuspended: async () => {},
      },
    });

    const res = await app.request('/scim/v2/Users/nonexistent', {
      method: 'DELETE',
      headers: { Authorization: 'Bearer scim-secret' },
    });

    expect(res.status).toBe(404);
  });

  test('returns 501 when delete mode is set but adapter lacks deleteUser', async () => {
    const { app } = buildRuntime({
      adapter: {
        findByEmail: async () => null,
        create: async () => ({ id: 'user-1' }),
        getUser: async () => defaultUser,
        updateProfile: async () => {},
        setSuspended: async () => {},
        // no deleteUser
      },
      config: {
        scim: {
          bearerTokens: ['scim-secret'],
          userMapping: {},
          onDeprovision: 'delete',
        },
      },
    });

    const res = await app.request('/scim/v2/Users/user-1', {
      method: 'DELETE',
      headers: { Authorization: 'Bearer scim-secret' },
    });

    expect(res.status).toBe(501);
  });

  test('returns 501 when suspend mode but adapter lacks setSuspended', async () => {
    const { app } = buildRuntime({
      adapter: {
        findByEmail: async () => null,
        create: async () => ({ id: 'user-1' }),
        getUser: async () => defaultUser,
        updateProfile: async () => {},
        // no setSuspended
      },
    });

    const res = await app.request('/scim/v2/Users/user-1', {
      method: 'DELETE',
      headers: { Authorization: 'Bearer scim-secret' },
    });

    expect(res.status).toBe(501);
  });
});

// ---------------------------------------------------------------------------
// ServiceProviderConfig endpoint
// ---------------------------------------------------------------------------

describe('GET /scim/v2/ServiceProviderConfig', () => {
  test('returns the service provider configuration', async () => {
    const { app } = buildRuntime();

    const res = await app.request('/scim/v2/ServiceProviderConfig', {
      headers: { Authorization: 'Bearer scim-secret' },
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.schemas).toEqual(['urn:ietf:params:scim:schemas:core:2.0:ServiceProviderConfig']);
    expect(body.patch).toEqual({ supported: true });
    expect(body.bulk).toEqual({ supported: false, maxOperations: 0, maxPayloadSize: 0 });
    expect(body.filter).toEqual({ supported: true, maxResults: 200 });
    expect(body.changePassword).toEqual({ supported: false });
    expect(body.sort).toEqual({ supported: false });
    expect(body.etag).toEqual({ supported: false });
  });
});

// ---------------------------------------------------------------------------
// ResourceTypes endpoint
// ---------------------------------------------------------------------------

describe('GET /scim/v2/ResourceTypes', () => {
  test('returns the resource types list with User', async () => {
    const { app } = buildRuntime();

    const res = await app.request('/scim/v2/ResourceTypes', {
      headers: { Authorization: 'Bearer scim-secret' },
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.schemas).toEqual(['urn:ietf:params:scim:api:messages:2.0:ListResponse']);
    expect(body.totalResults).toBe(1);
    expect(body.Resources).toHaveLength(1);
    expect(body.Resources[0]).toEqual({
      schemas: ['urn:ietf:params:scim:schemas:core:2.0:ResourceType'],
      id: 'User',
      name: 'User',
      endpoint: '/scim/v2/Users',
      schema: 'urn:ietf:params:scim:schemas:core:2.0:User',
    });
  });
});

// ---------------------------------------------------------------------------
// Rate limiting behavior
// ---------------------------------------------------------------------------

describe('SCIM rate limiting', () => {
  test('returns 429 when read rate limit is exceeded', async () => {
    const { app } = buildRuntime({
      rateLimit: {
        trackAttempt: async (key: string) => key.startsWith('scim-read:'),
      },
    });

    const res = await app.request('/scim/v2/Users/user-1', {
      headers: { Authorization: 'Bearer scim-secret' },
    });

    expect(res.status).toBe(429);
    const body = await res.json();
    expect(body.detail).toBe('Too many requests');
  });

  test('returns 429 when write rate limit is exceeded', async () => {
    const { app } = buildRuntime({
      rateLimit: {
        trackAttempt: async (key: string) => key.startsWith('scim-write:'),
      },
    });

    const res = await app.request('/scim/v2/Users/user-1', {
      method: 'PUT',
      headers: authHeaders,
      body: JSON.stringify({
        schemas: ['urn:ietf:params:scim:schemas:core:2.0:User'],
        userName: 'member@example.com',
      }),
    });

    expect(res.status).toBe(429);
  });

  test('returns 429 when DELETE rate limit is exceeded', async () => {
    const { app } = buildRuntime({
      rateLimit: {
        trackAttempt: async (key: string) => key.startsWith('scim-write:'),
      },
    });

    const res = await app.request('/scim/v2/Users/user-1', {
      method: 'DELETE',
      headers: { Authorization: 'Bearer scim-secret' },
    });

    expect(res.status).toBe(429);
  });
});

// ---------------------------------------------------------------------------
// Session revocation on suspension via PATCH
// ---------------------------------------------------------------------------

describe('Session revocation on suspension', () => {
  test('PATCH setting active=false revokes all user sessions', async () => {
    const setSuspended = mock(async () => {});
    const deletedSessions: string[] = [];
    const { app } = buildRuntime({
      adapter: {
        findByEmail: async () => null,
        create: async () => ({ id: 'user-1' }),
        getUser: async () => defaultUser,
        updateProfile: async () => {},
        setSuspended,
      },
      repos: {
        session: {
          getUserSessions: async () => [{ sessionId: 's1' }, { sessionId: 's2' }],
          deleteSession: async (id: string) => {
            deletedSessions.push(id);
          },
        },
      },
    });

    const res = await app.request('/scim/v2/Users/user-1', {
      method: 'PATCH',
      headers: authHeaders,
      body: JSON.stringify({
        schemas: ['urn:ietf:params:scim:api:messages:2.0:PatchOp'],
        Operations: [{ op: 'replace', path: 'active', value: false }],
      }),
    });

    expect(res.status).toBe(200);
    expect(setSuspended).toHaveBeenCalledWith('user-1', true);
    expect(deletedSessions).toContain('s1');
    expect(deletedSessions).toContain('s2');
  });

  test('PATCH removing active revokes sessions (treated as suspend)', async () => {
    const setSuspended = mock(async () => {});
    const deletedSessions: string[] = [];
    const { app } = buildRuntime({
      adapter: {
        findByEmail: async () => null,
        create: async () => ({ id: 'user-1' }),
        getUser: async () => defaultUser,
        updateProfile: async () => {},
        setSuspended,
      },
      repos: {
        session: {
          getUserSessions: async () => [{ sessionId: 's3' }],
          deleteSession: async (id: string) => {
            deletedSessions.push(id);
          },
        },
      },
    });

    const res = await app.request('/scim/v2/Users/user-1', {
      method: 'PATCH',
      headers: authHeaders,
      body: JSON.stringify({
        schemas: ['urn:ietf:params:scim:api:messages:2.0:PatchOp'],
        Operations: [{ op: 'remove', path: 'active' }],
      }),
    });

    expect(res.status).toBe(200);
    expect(setSuspended).toHaveBeenCalledWith('user-1', true);
    expect(deletedSessions).toContain('s3');
  });

  test('PATCH setting active=true does not revoke sessions', async () => {
    const setSuspended = mock(async () => {});
    const deletedSessions: string[] = [];
    const { app } = buildRuntime({
      adapter: {
        findByEmail: async () => null,
        create: async () => ({ id: 'user-1' }),
        getUser: async () => ({ ...defaultUser, suspended: true }),
        updateProfile: async () => {},
        setSuspended,
      },
      repos: {
        session: {
          getUserSessions: async () => [{ sessionId: 's4' }],
          deleteSession: async (id: string) => {
            deletedSessions.push(id);
          },
        },
      },
    });

    const res = await app.request('/scim/v2/Users/user-1', {
      method: 'PATCH',
      headers: authHeaders,
      body: JSON.stringify({
        schemas: ['urn:ietf:params:scim:api:messages:2.0:PatchOp'],
        Operations: [{ op: 'replace', path: 'active', value: true }],
      }),
    });

    expect(res.status).toBe(200);
    expect(setSuspended).toHaveBeenCalledWith('user-1', false);
    expect(deletedSessions).toHaveLength(0);
  });
});
