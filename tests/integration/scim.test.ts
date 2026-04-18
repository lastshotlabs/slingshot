import { createMemoryAuthAdapter } from '@auth/adapters/memoryAuth';
import { DEFAULT_AUTH_CONFIG } from '@auth/config/authConfig';
import type { AuthResolvedConfig } from '@auth/config/authConfig';
import {
  createAuthRateLimitService,
  createMemoryAuthRateLimitRepository,
} from '@auth/lib/authRateLimit';
import { beforeEach, describe, expect, test } from 'bun:test';
import { Hono } from 'hono';
import type { AuthRuntimeContext } from '@lastshotlabs/slingshot-auth';
import { HttpError } from '@lastshotlabs/slingshot-core';
import { createScimRouter } from '@lastshotlabs/slingshot-scim';

let memoryAuthAdapter: ReturnType<typeof createMemoryAuthAdapter>;

const SCIM_TOKEN = 'test-scim-token-secret';

let config: AuthResolvedConfig;
const runtimePassword = {
  hash: (plain: string) => Bun.password.hash(plain),
  verify: (plain: string, hash: string) => Bun.password.verify(plain, hash),
};

beforeEach(() => {
  memoryAuthAdapter = createMemoryAuthAdapter();
  config = { ...DEFAULT_AUTH_CONFIG, scim: { bearerTokens: SCIM_TOKEN } };
});

function buildApp() {
  const app = new Hono();
  const runtime = {
    adapter: memoryAuthAdapter,
    config,
    repos: {
      session: {
        getUserSessions: async () => [],
        deleteSession: async () => {},
      },
    },
    password: runtimePassword,
    eventBus: { emit: () => {}, on: () => {}, off: () => {} },
    lockout: null,
    rateLimit: createAuthRateLimitService(createMemoryAuthRateLimitRepository()),
    credentialStuffing: null,
  } as unknown as AuthRuntimeContext;
  app.onError((err, c) => {
    if (err instanceof HttpError) {
      return c.json({ error: err.message }, err.status as 400 | 401 | 403 | 404 | 409);
    }
    return c.json({ error: 'Internal Server Error' }, 500);
  });
  app.route('/', createScimRouter(runtime));
  return app;
}

const authHeaders = { Authorization: `Bearer ${SCIM_TOKEN}` };

describe('SCIM — authentication', () => {
  test('rejects requests without bearer token', async () => {
    const app = buildApp();
    const res = await app.request('/scim/v2/Users');
    expect(res.status).toBe(401);
  });

  test('rejects requests with wrong token', async () => {
    const app = buildApp();
    const res = await app.request('/scim/v2/Users', {
      headers: { Authorization: 'Bearer wrong-token' },
    });
    expect(res.status).toBe(401);
  });
});

describe('SCIM — user listing', () => {
  test('GET /scim/v2/Users returns empty list', async () => {
    const app = buildApp();
    const res = await app.request('/scim/v2/Users', { headers: authHeaders });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.schemas).toContain('urn:ietf:params:scim:api:messages:2.0:ListResponse');
    expect(body.totalResults).toBe(0);
    expect(body.Resources).toHaveLength(0);
  });

  test('GET /scim/v2/Users lists created users', async () => {
    await memoryAuthAdapter.create('a@example.com', 'hash');
    await memoryAuthAdapter.create('b@example.com', 'hash');

    const app = buildApp();
    const res = await app.request('/scim/v2/Users', { headers: authHeaders });
    const body = await res.json();
    expect(body.totalResults).toBe(2);
  });

  test('GET /scim/v2/Users rejects unsupported filters instead of widening to full-list reads', async () => {
    await memoryAuthAdapter.create('alpha@example.com', 'hash');
    await memoryAuthAdapter.create('beta@example.com', 'hash');

    const app = buildApp();
    const res = await app.request('/scim/v2/Users?filter=displayName%20eq%20%22Alpha%22', {
      headers: authHeaders,
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.scimType).toBe('invalidFilter');
    expect(body.detail).toContain('unsupported syntax');
  });
});

describe('SCIM — user CRUD', () => {
  test('POST /scim/v2/Users creates a user', async () => {
    const app = buildApp();
    const res = await app.request('/scim/v2/Users', {
      method: 'POST',
      headers: { ...authHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        schemas: ['urn:ietf:params:scim:schemas:core:2.0:User'],
        userName: 'newuser@example.com',
        name: { givenName: 'New', familyName: 'User' },
        displayName: 'New User',
      }),
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.id).toBeTruthy();
    expect(body.userName).toBe('newuser@example.com');
    expect(body.active).toBe(true);
  });

  test('DELETE /scim/v2/Users/:id suspends user by default', async () => {
    const { id } = await memoryAuthAdapter.create('del@example.com', 'hash');

    const app = buildApp();
    const res = await app.request(`/scim/v2/Users/${id}`, {
      method: 'DELETE',
      headers: authHeaders,
    });
    expect(res.status).toBe(204);

    const status = await memoryAuthAdapter.getSuspended!(id);
    expect(status?.suspended).toBe(true);
  });

  test('DELETE /scim/v2/Users/:id returns 501 when suspend deprovisioning is unsupported', async () => {
    const { id } = await memoryAuthAdapter.create('no-suspend@example.com', 'hash');
    const adapterWithoutSuspension = {
      ...memoryAuthAdapter,
      setSuspended: undefined,
    };
    const app = new Hono();
    const runtime = {
      adapter: adapterWithoutSuspension,
      config,
      repos: {
        session: {
          getUserSessions: async () => [],
          deleteSession: async () => {},
        },
      },
      password: runtimePassword,
      eventBus: { emit: () => {}, on: () => {}, off: () => {} },
      lockout: null,
      rateLimit: createAuthRateLimitService(createMemoryAuthRateLimitRepository()),
      credentialStuffing: null,
    } as unknown as AuthRuntimeContext;
    app.onError((err, c) => {
      if (err instanceof HttpError) {
        return c.json({ error: err.message }, err.status as 400 | 401 | 403 | 404 | 409 | 501);
      }
      return c.json({ error: 'Internal Server Error' }, 500);
    });
    app.route('/', createScimRouter(runtime));

    const res = await app.request(`/scim/v2/Users/${id}`, {
      method: 'DELETE',
      headers: authHeaders,
    });
    expect(res.status).toBe(501);
  });

  test('DELETE /scim/v2/Users/:id returns 501 when delete deprovisioning is unsupported', async () => {
    const { id } = await memoryAuthAdapter.create('no-delete@example.com', 'hash');
    const adapterWithoutDelete = {
      ...memoryAuthAdapter,
      deleteUser: undefined,
    };
    const app = new Hono();
    const runtime = {
      adapter: adapterWithoutDelete,
      config: {
        ...config,
        scim: { ...(config.scim ?? { bearerTokens: SCIM_TOKEN }), onDeprovision: 'delete' },
      },
      repos: {
        session: {
          getUserSessions: async () => [],
          deleteSession: async () => {},
        },
      },
      password: runtimePassword,
      eventBus: { emit: () => {}, on: () => {}, off: () => {} },
      lockout: null,
      rateLimit: createAuthRateLimitService(createMemoryAuthRateLimitRepository()),
      credentialStuffing: null,
    } as unknown as AuthRuntimeContext;
    app.onError((err, c) => {
      if (err instanceof HttpError) {
        return c.json({ error: err.message }, err.status as 400 | 401 | 403 | 404 | 409 | 501);
      }
      return c.json({ error: 'Internal Server Error' }, 500);
    });
    app.route('/', createScimRouter(runtime));

    const res = await app.request(`/scim/v2/Users/${id}`, {
      method: 'DELETE',
      headers: authHeaders,
    });
    expect(res.status).toBe(501);
  });

  test('PATCH /scim/v2/Users/:id deactivates user', async () => {
    const { id } = await memoryAuthAdapter.create('patch@example.com', 'hash');

    const app = buildApp();
    const res = await app.request(`/scim/v2/Users/${id}`, {
      method: 'PATCH',
      headers: { ...authHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        schemas: ['urn:ietf:params:scim:api:messages:2.0:PatchOp'],
        Operations: [{ op: 'replace', path: 'active', value: false }],
      }),
    });
    expect(res.status).toBe(200);

    const status = await memoryAuthAdapter.getSuspended!(id);
    expect(status?.suspended).toBe(true);
  });

  test('PATCH /scim/v2/Users/:id returns 404 before attempting adapter writes for unknown users', async () => {
    const updateProfile = async () => {
      throw new Error('updateProfile should not be called for unknown users');
    };
    const setSuspended = async () => {
      throw new Error('setSuspended should not be called for unknown users');
    };
    const guardedAdapter = {
      ...memoryAuthAdapter,
      updateProfile,
      setSuspended,
    };
    const app = new Hono();
    const runtime = {
      adapter: guardedAdapter,
      config,
      repos: {
        session: {
          getUserSessions: async () => [],
          deleteSession: async () => {},
        },
      },
      password: runtimePassword,
      eventBus: { emit: () => {}, on: () => {}, off: () => {} },
      lockout: null,
      rateLimit: createAuthRateLimitService(createMemoryAuthRateLimitRepository()),
      credentialStuffing: null,
    } as unknown as AuthRuntimeContext;
    app.onError((err, c) => {
      if (err instanceof HttpError) {
        return c.json({ error: err.message }, err.status as 400 | 401 | 403 | 404 | 409 | 501);
      }
      return c.json({ error: 'Internal Server Error' }, 500);
    });
    app.route('/', createScimRouter(runtime));

    const res = await app.request('/scim/v2/Users/missing-user', {
      method: 'PATCH',
      headers: { ...authHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        schemas: ['urn:ietf:params:scim:api:messages:2.0:PatchOp'],
        Operations: [{ op: 'replace', path: 'active', value: false }],
      }),
    });

    expect(res.status).toBe(404);
  });
});

describe('SCIM — discovery', () => {
  test('GET /scim/v2/ServiceProviderConfig returns config', async () => {
    const app = buildApp();
    const res = await app.request('/scim/v2/ServiceProviderConfig', { headers: authHeaders });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.patch.supported).toBe(true);
  });
});

describe('parseScimFilter', () => {
  test('parses userName eq filter', async () => {
    const { parseScimFilter } = await import('@lastshotlabs/slingshot-scim');
    const query = parseScimFilter('userName eq "test@example.com"');
    expect(query!.email).toBe('test@example.com');
  });

  test('parses active eq filter', async () => {
    const { parseScimFilter } = await import('@lastshotlabs/slingshot-scim');
    const query = parseScimFilter('active eq false');
    expect(query!.suspended).toBe(true); // active=false → suspended=true
  });

  test('returns null for unsupported filter attributes', async () => {
    const { parseScimFilter } = await import('@lastshotlabs/slingshot-scim');
    expect(parseScimFilter('displayName eq "Alpha"')).toBeNull();
  });

  test('returns null for invalid active filter values', async () => {
    const { parseScimFilter } = await import('@lastshotlabs/slingshot-scim');
    expect(parseScimFilter('active eq maybe')).toBeNull();
  });
});
