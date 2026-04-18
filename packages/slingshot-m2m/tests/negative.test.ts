import { describe, expect, mock, test } from 'bun:test';
import { Hono } from 'hono';
import { createM2MRouter } from '../src/routes/m2m';

function buildApp(overrides: Partial<Record<string, unknown>> = {}) {
  const runtime = {
    adapter: {
      getM2MClient: async () => null,
    },
    config: {
      m2m: {
        tokenExpiry: 3600,
        scopes: ['read'],
      },
    },
    rateLimit: {
      trackAttempt: async () => false,
    },
    password: {
      hash: async () => 'unused',
      verify: async () => false,
    },
    signing: {},
    ...overrides,
  };

  const app = new Hono();
  app.route('/', createM2MRouter(runtime as never));
  return app;
}

describe('slingshot-m2m negative branches', () => {
  test('returns invalid_request for malformed JSON bodies', async () => {
    const app = buildApp();
    const response = await app.request('/oauth/token', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{',
    });

    expect(response.status).toBe(400);
    expect(await response.text()).toContain('Malformed JSON');
  });

  test('returns unsupported_grant_type for non-client-credentials grants', async () => {
    const app = buildApp();
    const response = await app.request('/oauth/token', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'password',
        client_id: 'client-1',
        client_secret: 'secret-1',
      }),
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: 'unsupported_grant_type',
      error_description: 'Unsupported grant type',
    });
  });

  test('returns invalid_client when the client does not exist', async () => {
    const app = buildApp();
    const response = await app.request('/oauth/token', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'client_credentials',
        client_id: 'missing-client',
        client_secret: 'secret-1',
      }),
    });

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({
      error: 'invalid_client',
      error_description: 'Invalid client credentials',
    });
  });

  test('uses runtime.password.verify for client secret validation', async () => {
    const verify = mock(async () => false);
    const app = buildApp({
      adapter: {
        getM2MClient: async () => ({
          id: 'client-1',
          clientId: 'client-1',
          clientSecretHash: 'stored-hash',
          name: 'Client One',
          scopes: ['read'],
          active: true,
        }),
      },
      password: {
        hash: async () => 'unused',
        verify,
      },
    });
    const response = await app.request('/oauth/token', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'client_credentials',
        client_id: 'client-1',
        client_secret: 'secret-1',
      }),
    });

    expect(response.status).toBe(401);
    expect(verify).toHaveBeenCalledWith('secret-1', 'stored-hash');
  });

  test('returns rate_limit_exceeded before parsing the request body when throttled', async () => {
    const app = buildApp({
      rateLimit: {
        trackAttempt: async () => true,
      },
    });
    const response = await app.request('/oauth/token', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'client_credentials',
        client_id: 'client-1',
        client_secret: 'secret-1',
      }),
    });

    expect(response.status).toBe(429);
    expect(await response.json()).toEqual({
      error: 'rate_limit_exceeded',
      error_description: 'Too many token requests. Try again later.',
    });
  });
});
