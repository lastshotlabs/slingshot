import { createMemoryAuthAdapter } from '@auth/adapters/memoryAuth';
import { DEFAULT_AUTH_CONFIG } from '@auth/config/authConfig';
import type { AuthResolvedConfig } from '@auth/config/authConfig';
import {
  createAuthRateLimitService,
  createMemoryAuthRateLimitRepository,
} from '@auth/lib/authRateLimit';
import { signToken } from '@auth/lib/jwt';
import { createMemorySessionRepository } from '@auth/lib/session';
import { createIdentifyMiddleware } from '@auth/middleware/identify';
import { beforeEach, describe, expect, test } from 'bun:test';
import { Hono } from 'hono';
import { HttpError } from '@lastshotlabs/slingshot-core';
import {
  createM2MClient,
  createM2MRouter,
  deleteM2MClient,
  listM2MClients,
  requireScope,
} from '@lastshotlabs/slingshot-m2m';

let memoryAuthAdapter: ReturnType<typeof createMemoryAuthAdapter>;

let config: AuthResolvedConfig;
const runtimePassword = {
  hash: (plain: string) => Bun.password.hash(plain),
  verify: (plain: string, hash: string) => Bun.password.verify(plain, hash),
};

beforeEach(() => {
  memoryAuthAdapter = createMemoryAuthAdapter();
  config = { ...DEFAULT_AUTH_CONFIG, m2m: { tokenExpiry: 3600 } };
});

function buildApp() {
  const app = new Hono();
  const adapter = memoryAuthAdapter;
  const sessionRepo = createMemorySessionRepository();
  const emptyStores = {};
  const runtime = {
    adapter,
    config,
    eventBus: { emit: () => {}, on: () => {}, off: () => {} },
    stores: emptyStores as never,
    password: runtimePassword,
    signing: { secret: 'test-secret-key-must-be-at-least-32-chars!!' },
    dataEncryptionKeys: [],
    lockout: null,
    rateLimit: createAuthRateLimitService(createMemoryAuthRateLimitRepository()),
    credentialStuffing: null,
    repos: {
      session: sessionRepo,
    },
  };
  app.onError((err, c) => {
    if (err instanceof HttpError) {
      const body: Record<string, unknown> = { error: err.message };
      if (err.code) body.code = err.code;
      return c.json(body, err.status as 400 | 401 | 403 | 429 | 500);
    }
    return c.json({ error: 'Internal Server Error' }, 500);
  });
  app.use('/*', createIdentifyMiddleware(runtime as any));
  app.route('/', createM2MRouter(runtime as any));
  app.get('/protected', requireScope('read:data'), c => c.json({ ok: true }));
  return { app, runtime };
}

describe('M2M client credentials', () => {
  test('exchange valid credentials for token', async () => {
    const { clientId, clientSecret } = await createM2MClient({
      adapter: memoryAuthAdapter,
      clientId: 'service-a',
      name: 'Service A',
      password: runtimePassword,
      scopes: ['read:data', 'write:data'],
    });

    const { app } = buildApp();
    const res = await app.request('/oauth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'client_credentials',
        client_id: clientId,
        client_secret: clientSecret,
      }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.access_token).toBeTruthy();
    expect(body.token_type).toBe('Bearer');
    expect(body.expires_in).toBe(3600);
  });

  test('rejects invalid client_secret', async () => {
    await createM2MClient({
      adapter: memoryAuthAdapter,
      clientId: 'service-b',
      name: 'B',
      password: runtimePassword,
      scopes: [],
    });
    const { app } = buildApp();
    const res = await app.request('/oauth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'client_credentials',
        client_id: 'service-b',
        client_secret: 'wrong-secret',
      }),
    });
    expect(res.status).toBe(401);
  });

  test('rejects unsupported grant_type', async () => {
    const { app } = buildApp();
    const res = await app.request('/oauth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'authorization_code',
        client_id: 'test',
        client_secret: 'test',
      }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('unsupported_grant_type');
    expect(body.error_description).toBe('Unsupported grant type');
  });

  test('requireScope allows M2M token with correct scope', async () => {
    const { clientId, clientSecret } = await createM2MClient({
      adapter: memoryAuthAdapter,
      clientId: 'reader',
      name: 'Reader',
      password: runtimePassword,
      scopes: ['read:data'],
    });

    const { app } = buildApp();

    // Get token
    const tokenRes = await app.request('/oauth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'client_credentials',
        client_id: clientId,
        client_secret: clientSecret,
      }),
    });
    const { access_token: accessToken } = await tokenRes.json();

    // Use token
    const res = await app.request('/protected', {
      headers: { 'x-user-token': accessToken },
    });
    expect(res.status).toBe(200);
  });

  test('requireScope blocks token with wrong scope', async () => {
    const { clientId, clientSecret } = await createM2MClient({
      adapter: memoryAuthAdapter,
      clientId: 'writer',
      name: 'Writer',
      password: runtimePassword,
      scopes: ['write:data'], // has write but not read
    });

    const { app } = buildApp();
    const tokenRes = await app.request('/oauth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'client_credentials',
        client_id: clientId,
        client_secret: clientSecret,
      }),
    });
    const { access_token: accessToken } = await tokenRes.json();

    const res = await app.request('/protected', {
      headers: { 'x-user-token': accessToken },
    });
    expect(res.status).toBe(403);
  });

  test('requireScope rejects user session token even when it carries a scope claim', async () => {
    const { app, runtime } = buildApp();
    const { id: userId } = await memoryAuthAdapter.create('scoped-user@example.com', 'hash');
    const sessionId = 'sess-user-scope-1';
    const token = await signToken(
      { sub: userId, sid: sessionId, scope: 'read:data' },
      3600,
      config,
      runtime.signing,
    );
    await runtime.repos.session.createSession(userId, token, sessionId, undefined, config);

    const res = await app.request('/protected', {
      headers: { 'x-user-token': token },
    });
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ code: 'M2M_REQUIRED' });
  });

  test('rejects token issuance when requested scope is not allowed by server configuration', async () => {
    config = { ...DEFAULT_AUTH_CONFIG, m2m: { tokenExpiry: 3600, scopes: ['read:data'] } };
    const { clientId, clientSecret } = await createM2MClient({
      adapter: memoryAuthAdapter,
      clientId: 'server-scope-reject',
      name: 'Server Scope Reject',
      password: runtimePassword,
      scopes: ['read:data', 'write:data'],
    });

    const { app } = buildApp();
    const res = await app.request('/oauth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'client_credentials',
        client_id: clientId,
        client_secret: clientSecret,
        scope: 'write:data',
      }),
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('invalid_scope');
  });

  test('rejects token issuance when client carries scopes not allowed by server configuration', async () => {
    config = { ...DEFAULT_AUTH_CONFIG, m2m: { tokenExpiry: 3600, scopes: ['read:data'] } };
    const { clientId, clientSecret } = await createM2MClient({
      adapter: memoryAuthAdapter,
      clientId: 'misconfigured-client',
      name: 'Misconfigured Client',
      password: runtimePassword,
      scopes: ['read:data', 'write:data'],
    });

    const { app } = buildApp();
    const res = await app.request('/oauth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'client_credentials',
        client_id: clientId,
        client_secret: clientSecret,
      }),
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('invalid_scope');
  });

  test('issues token when client scopes are inside server configuration allowlist', async () => {
    config = {
      ...DEFAULT_AUTH_CONFIG,
      m2m: { tokenExpiry: 3600, scopes: ['read:data', 'write:data'] },
    };
    const { clientId, clientSecret } = await createM2MClient({
      adapter: memoryAuthAdapter,
      clientId: 'allowed-client',
      name: 'Allowed Client',
      password: runtimePassword,
      scopes: ['read:data'],
    });

    const { app } = buildApp();
    const res = await app.request('/oauth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'client_credentials',
        client_id: clientId,
        client_secret: clientSecret,
      }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.scope).toBe('read:data');
  });
});

describe('M2M management helpers', () => {
  test('createM2MClient rejects duplicate clientId values', async () => {
    await createM2MClient({
      adapter: memoryAuthAdapter,
      clientId: 'duplicate-client',
      name: 'Duplicate Client',
      password: runtimePassword,
      scopes: [],
    });

    await expect(
      createM2MClient({
        adapter: memoryAuthAdapter,
        clientId: 'duplicate-client',
        name: 'Duplicate Client 2',
        password: runtimePassword,
        scopes: [],
      }),
    ).rejects.toThrow(/already exists|duplicate/i);
  });

  test('listM2MClients returns created clients', async () => {
    await createM2MClient({
      adapter: memoryAuthAdapter,
      clientId: 'c1',
      name: 'C1',
      password: runtimePassword,
      scopes: [],
    });
    await createM2MClient({
      adapter: memoryAuthAdapter,
      clientId: 'c2',
      name: 'C2',
      password: runtimePassword,
      scopes: [],
    });
    const clients = await listM2MClients(memoryAuthAdapter);
    expect(clients.length).toBe(2);
  });

  test('deleteM2MClient removes client', async () => {
    await createM2MClient({
      adapter: memoryAuthAdapter,
      clientId: 'temp',
      name: 'Temp',
      password: runtimePassword,
      scopes: [],
    });
    await deleteM2MClient(memoryAuthAdapter, 'temp');
    const clients = await listM2MClients(memoryAuthAdapter);
    expect(clients.length).toBe(0);
  });
});
