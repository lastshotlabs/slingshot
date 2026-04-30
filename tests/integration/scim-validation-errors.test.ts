/**
 * Tests for F8 — SCIM validation hook inlining.
 *
 * After F8, the SCIM validation hook is inlined (not annotated with Hook<any,...>)
 * so TypeScript properly infers types. Runtime behaviour: invalid request bodies
 * must return RFC 7644 SCIM error format ({ schemas, status, detail }) not a
 * generic Hono error shape.
 */
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

const SCIM_TOKEN = 'test-scim-token-secret';
let memoryAuthAdapter: ReturnType<typeof createMemoryAuthAdapter>;
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
    password: runtimePassword,
    eventBus: { emit: () => {}, on: () => {}, off: () => {} },
    lockout: null,
    rateLimit: createAuthRateLimitService(createMemoryAuthRateLimitRepository()),
    credentialStuffing: null,
    repos: {
      session: {
        getUserSessions: async () => [],
        deleteSession: async () => {},
      },
    },
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

// RFC 7644 §3.12 SCIM error response schema
const SCIM_ERROR_SCHEMA = 'urn:ietf:params:scim:api:messages:2.0:Error';

describe('SCIM validation errors — RFC 7644 format', () => {
  test('POST /scim/v2/Users with missing userName returns 400 in SCIM error format', async () => {
    const app = buildApp();
    const res = await app.request('/scim/v2/Users', {
      method: 'POST',
      headers: { ...authHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        // missing userName (required field)
        schemas: ['urn:ietf:params:scim:schemas:core:2.0:User'],
        name: { givenName: 'Test', familyName: 'User' },
      }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.schemas).toContain(SCIM_ERROR_SCHEMA);
    expect(body.status).toBe('400');
    expect(typeof body.detail).toBe('string');
    expect(body.detail.length).toBeGreaterThan(0);
  });

  test('PATCH /scim/v2/Users/:id with missing Operations returns 400 in SCIM error format', async () => {
    const { id } = await memoryAuthAdapter.create('patch-bad@example.com', 'hash');
    const app = buildApp();
    const res = await app.request(`/scim/v2/Users/${id}`, {
      method: 'PATCH',
      headers: { ...authHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        // Missing Operations array — required by RFC 7644 PatchOp
        schemas: ['urn:ietf:params:scim:api:messages:2.0:PatchOp'],
      }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.schemas).toContain(SCIM_ERROR_SCHEMA);
    expect(body.status).toBe('400');
    expect(typeof body.detail).toBe('string');
  });

  test('POST /scim/v2/Users with completely empty body returns 400 in SCIM error format', async () => {
    const app = buildApp();
    const res = await app.request('/scim/v2/Users', {
      method: 'POST',
      headers: { ...authHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.schemas).toContain(SCIM_ERROR_SCHEMA);
    expect(body.status).toBe('400');
  });

  test('SCIM error detail includes the offending field path', async () => {
    const app = buildApp();
    const res = await app.request('/scim/v2/Users', {
      method: 'POST',
      headers: { ...authHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        schemas: ['urn:ietf:params:scim:schemas:core:2.0:User'],
        // No userName
      }),
    });
    const body = await res.json();
    // detail should mention the missing field
    expect(body.detail).toContain('userName');
  });

  test('valid POST /scim/v2/Users still returns 201 (smoke test)', async () => {
    const app = buildApp();
    const res = await app.request('/scim/v2/Users', {
      method: 'POST',
      headers: { ...authHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        schemas: ['urn:ietf:params:scim:schemas:core:2.0:User'],
        userName: 'valid@example.com',
        name: { givenName: 'Valid', familyName: 'User' },
        displayName: 'Valid User',
      }),
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.schemas).not.toContain(SCIM_ERROR_SCHEMA);
  });

  test('PATCH with valid Operations returns 200 (smoke test)', async () => {
    const { id } = await memoryAuthAdapter.create('patch-ok@example.com', 'hash');
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
  });
});
