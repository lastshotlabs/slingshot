import { describe, expect, mock, test } from 'bun:test';
import { Hono } from 'hono';
import { createScimRouter } from '../src/routes/scim';

function buildRuntime(overrides: Partial<Record<string, unknown>> = {}) {
  const user = {
    id: 'user-1',
    email: 'member@example.com',
    displayName: 'Member',
    firstName: 'Member',
    lastName: 'User',
    externalId: null,
    suspended: false,
  };

  const runtime = {
    adapter: {
      findByEmail: async () => null,
      create: async () => ({ id: 'user-1' }),
      getUser: async () => user,
      updateProfile: async () => {},
      setSuspended: async () => {},
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
    ...overrides,
  };

  const app = new Hono();
  app.route('/', createScimRouter(runtime as never));
  return app;
}

describe('slingshot-scim routes', () => {
  test('uses runtime.password.hash when provisioning placeholder passwords', async () => {
    const hash = mock(async (plain: string) => `hashed:${plain}`);
    const create = mock(async (_email: string, passwordHash: string) => {
      expect(passwordHash).toMatch(/^hashed:/);
      return { id: 'user-1' };
    });
    const app = buildRuntime({
      password: {
        hash,
        verify: async () => true,
      },
      adapter: {
        findByEmail: async () => null,
        create,
        getUser: async () => ({
          email: 'member@example.com',
          displayName: 'Member',
          firstName: 'Member',
          lastName: 'User',
          externalId: null,
          suspended: false,
        }),
        updateProfile: async () => {},
        setSuspended: async () => {},
      },
    });

    const response = await app.request('/scim/v2/Users', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        Authorization: 'Bearer scim-secret',
      },
      body: JSON.stringify({
        schemas: ['urn:ietf:params:scim:schemas:core:2.0:User'],
        userName: 'member@example.com',
        active: true,
      }),
    });

    expect(response.status).toBe(201);
    expect(hash).toHaveBeenCalledTimes(1);
    expect(create).toHaveBeenCalledTimes(1);
  });

  test('rejects non-boolean active values in PATCH operations', async () => {
    const setSuspended = mock(async () => {});
    const app = buildRuntime({
      adapter: {
        findByEmail: async () => null,
        create: async () => ({ id: 'user-1' }),
        getUser: async () => ({
          email: 'member@example.com',
          displayName: 'Member',
          firstName: 'Member',
          lastName: 'User',
          externalId: null,
          suspended: false,
        }),
        updateProfile: async () => {},
        setSuspended,
      },
    });

    const response = await app.request('/scim/v2/Users/user-1', {
      method: 'PATCH',
      headers: {
        'content-type': 'application/json',
        Authorization: 'Bearer scim-secret',
      },
      body: JSON.stringify({
        schemas: ['urn:ietf:params:scim:api:messages:2.0:PatchOp'],
        Operations: [{ op: 'replace', path: 'active', value: 'yes' }],
      }),
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      schemas: ['urn:ietf:params:scim:api:messages:2.0:Error'],
      status: '400',
      detail: 'active must be a boolean',
    });
    expect(setSuspended).toHaveBeenCalledTimes(0);
  });
});
