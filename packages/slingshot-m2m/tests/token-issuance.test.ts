import { describe, expect, mock, test } from 'bun:test';
import { Hono } from 'hono';
import { createM2MRouter } from '../src/routes/m2m';

const activeClient = {
  id: 'client-1',
  clientId: 'billing-svc',
  clientSecretHash: 'stored-hash',
  name: 'Billing Service',
  scopes: ['read:invoices', 'write:invoices'],
  active: true,
};

function buildApp(overrides: Partial<Record<string, unknown>> = {}) {
  const runtime = {
    adapter: {
      getM2MClient: async (clientId: string) => (clientId === 'billing-svc' ? activeClient : null),
    },
    config: {
      m2m: {
        tokenExpiry: 3600,
        scopes: ['read:invoices', 'write:invoices', 'admin:billing'],
      },
    },
    rateLimit: {
      trackAttempt: async () => false,
    },
    password: {
      hash: async () => 'unused',
      verify: async (plain: string, hash: string) => hash === 'stored-hash',
    },
    getDummyHash: async () => 'dummy-hash',
    signing: { secret: 'test-signing-secret-32-chars-ok!' },
    ...overrides,
  };

  const app = new Hono();
  app.route('/', createM2MRouter(runtime as never));
  return app;
}

// ---------------------------------------------------------------------------
// Happy path: successful client_credentials grant
// ---------------------------------------------------------------------------

describe('M2M token issuance — happy path', () => {
  test('successful client_credentials grant returns a valid token response', async () => {
    const app = buildApp();

    const res = await app.request('/oauth/token', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'client_credentials',
        client_id: 'billing-svc',
        client_secret: 'my-secret',
      }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.access_token).toBeString();
    expect(body.access_token.length).toBeGreaterThan(0);
    expect(body.token_type).toBe('Bearer');
    expect(body.expires_in).toBe(3600);
    expect(body.scope).toBe('read:invoices write:invoices');
  });

  test('token response includes correct scope when specific scopes are requested', async () => {
    const app = buildApp();

    const res = await app.request('/oauth/token', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'client_credentials',
        client_id: 'billing-svc',
        client_secret: 'my-secret',
        scope: 'read:invoices',
      }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.scope).toBe('read:invoices');
    expect(body.token_type).toBe('Bearer');
    expect(body.expires_in).toBe(3600);
  });

  test('custom tokenExpiry is reflected in the response', async () => {
    const app = buildApp({
      config: {
        m2m: {
          tokenExpiry: 7200,
          scopes: ['read:invoices', 'write:invoices'],
        },
      },
    });

    const res = await app.request('/oauth/token', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'client_credentials',
        client_id: 'billing-svc',
        client_secret: 'my-secret',
      }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.expires_in).toBe(7200);
  });
});

// ---------------------------------------------------------------------------
// Form-urlencoded body parsing
// ---------------------------------------------------------------------------

describe('M2M token issuance — form-urlencoded', () => {
  test('accepts application/x-www-form-urlencoded request bodies', async () => {
    const app = buildApp();

    const body = new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: 'billing-svc',
      client_secret: 'my-secret',
    });

    const res = await app.request('/oauth/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.access_token).toBeString();
    expect(json.token_type).toBe('Bearer');
    expect(json.scope).toBe('read:invoices write:invoices');
  });

  test('form-urlencoded with specific scope grants only requested scopes', async () => {
    const app = buildApp();

    const body = new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: 'billing-svc',
      client_secret: 'my-secret',
      scope: 'read:invoices',
    });

    const res = await app.request('/oauth/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.scope).toBe('read:invoices');
  });
});

// ---------------------------------------------------------------------------
// Server-configured scope enforcement
// ---------------------------------------------------------------------------

describe('M2M token issuance — server scope enforcement', () => {
  test('rejects requested scope that is not in the client scope list', async () => {
    const app = buildApp();

    const res = await app.request('/oauth/token', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'client_credentials',
        client_id: 'billing-svc',
        client_secret: 'my-secret',
        scope: 'admin:billing',
      }),
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('invalid_scope');
    expect(body.error_description).toContain('admin:billing');
  });

  test('rejects when client scopes include scopes not in server config', async () => {
    const app = buildApp({
      adapter: {
        getM2MClient: async () => ({
          ...activeClient,
          scopes: ['read:invoices', 'secret:admin'],
        }),
      },
      config: {
        m2m: {
          tokenExpiry: 3600,
          scopes: ['read:invoices', 'write:invoices'],
        },
      },
    });

    const res = await app.request('/oauth/token', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'client_credentials',
        client_id: 'billing-svc',
        client_secret: 'my-secret',
      }),
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('invalid_scope');
    expect(body.error_description).toContain('not allowed by server');
  });

  test('grants all client scopes when no scope is requested and scopes are within server config', async () => {
    const app = buildApp();

    const res = await app.request('/oauth/token', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'client_credentials',
        client_id: 'billing-svc',
        client_secret: 'my-secret',
      }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    // All client scopes should be granted
    const grantedScopes = body.scope.split(' ');
    expect(grantedScopes).toContain('read:invoices');
    expect(grantedScopes).toContain('write:invoices');
  });

  test('server without configured scopes grants all client scopes', async () => {
    const app = buildApp({
      config: {
        m2m: {
          tokenExpiry: 3600,
          // No scopes configured at server level
        },
      },
    });

    const res = await app.request('/oauth/token', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'client_credentials',
        client_id: 'billing-svc',
        client_secret: 'my-secret',
      }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.scope).toBe('read:invoices write:invoices');
  });

  test('rejects requested scope not allowed by server config even if client has it', async () => {
    // Client has read:invoices and write:invoices, server only allows read:invoices
    const app = buildApp({
      config: {
        m2m: {
          tokenExpiry: 3600,
          scopes: ['read:invoices'],
        },
      },
      adapter: {
        getM2MClient: async () => ({
          ...activeClient,
          scopes: ['read:invoices'],
        }),
      },
    });

    const res = await app.request('/oauth/token', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'client_credentials',
        client_id: 'billing-svc',
        client_secret: 'my-secret',
        scope: 'read:invoices write:invoices',
      }),
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('invalid_scope');
  });
});
