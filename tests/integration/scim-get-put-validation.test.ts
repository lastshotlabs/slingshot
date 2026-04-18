/**
 * Tests for F8 (extended) — SCIM validation error format on GET and PUT routes.
 *
 * The existing scim-validation-errors.test.ts covers POST and PATCH. This file
 * covers GET (query parameter validation) and PUT (request body validation) to
 * ensure all SCIM write/read paths return RFC 7644 error format on bad input.
 *
 * Covers:
 *   - GET /scim/v2/Users?count=0 → 400 in SCIM error format (below min=1)
 *   - GET /scim/v2/Users?count=300 → 400 in SCIM error format (above max=200)
 *   - GET /scim/v2/Users?startIndex=0 → 400 in SCIM error format (below min=1)
 *   - PUT /scim/v2/Users/:id with invalid userName format → 400 in SCIM error format
 *   - DELETE /scim/v2/Users/:id with non-existent user → 404 in SCIM error format
 *   - Valid GET and PUT requests still work (smoke tests)
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

const SCIM_TOKEN = 'test-scim-bearer-token';
const SCIM_ERROR_SCHEMA = 'urn:ietf:params:scim:api:messages:2.0:Error';

let memoryAdapter: ReturnType<typeof createMemoryAuthAdapter>;
let config: AuthResolvedConfig;

beforeEach(() => {
  memoryAdapter = createMemoryAuthAdapter();
  config = { ...DEFAULT_AUTH_CONFIG, scim: { bearerTokens: SCIM_TOKEN } };
});

function buildApp(): Hono {
  const app = new Hono();
  const runtime = {
    adapter: memoryAdapter,
    config,
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

// ---------------------------------------------------------------------------
// GET /scim/v2/Users — query parameter validation
// ---------------------------------------------------------------------------

describe('SCIM GET /scim/v2/Users — query parameter validation', () => {
  test('count=0 (below min=1) returns 400 in SCIM error format', async () => {
    const app = buildApp();
    const res = await app.request('/scim/v2/Users?count=0', { headers: authHeaders });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.schemas).toContain(SCIM_ERROR_SCHEMA);
    expect(body.status).toBe('400');
    expect(typeof body.detail).toBe('string');
    expect(body.detail.length).toBeGreaterThan(0);
  });

  test('count=300 (above max=200) returns 400 in SCIM error format', async () => {
    const app = buildApp();
    const res = await app.request('/scim/v2/Users?count=300', { headers: authHeaders });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.schemas).toContain(SCIM_ERROR_SCHEMA);
    expect(body.status).toBe('400');
  });

  test('startIndex=0 (below min=1) returns 400 in SCIM error format', async () => {
    const app = buildApp();
    const res = await app.request('/scim/v2/Users?startIndex=0', { headers: authHeaders });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.schemas).toContain(SCIM_ERROR_SCHEMA);
    expect(body.status).toBe('400');
  });

  test('valid GET /scim/v2/Users returns 200 with list response (smoke test)', async () => {
    const app = buildApp();
    const res = await app.request('/scim/v2/Users?count=10', { headers: authHeaders });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.schemas).not.toContain(SCIM_ERROR_SCHEMA);
    expect(typeof body.totalResults).toBe('number');
  });
});

// ---------------------------------------------------------------------------
// PUT /scim/v2/Users/:id — body validation
// ---------------------------------------------------------------------------

describe('SCIM PUT /scim/v2/Users/:id — body validation', () => {
  test('invalid userName format returns 400 in SCIM error format', async () => {
    const { id } = await memoryAdapter.create('put-valid@example.com', 'hash');
    const app = buildApp();
    const res = await app.request(`/scim/v2/Users/${id}`, {
      method: 'PUT',
      headers: { ...authHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        schemas: ['urn:ietf:params:scim:schemas:core:2.0:User'],
        userName: 'not-a-valid-email-format', // fails z.string().email()
      }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.schemas).toContain(SCIM_ERROR_SCHEMA);
    expect(body.status).toBe('400');
    expect(typeof body.detail).toBe('string');
  });

  test('name.givenName exceeding 256 chars returns 400 in SCIM error format', async () => {
    const { id } = await memoryAdapter.create('put-long@example.com', 'hash');
    const app = buildApp();
    const res = await app.request(`/scim/v2/Users/${id}`, {
      method: 'PUT',
      headers: { ...authHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        schemas: ['urn:ietf:params:scim:schemas:core:2.0:User'],
        userName: 'put-long@example.com',
        name: { givenName: 'A'.repeat(300) }, // exceeds max(256)
      }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.schemas).toContain(SCIM_ERROR_SCHEMA);
    expect(body.status).toBe('400');
  });

  test('valid PUT returns 200 (smoke test)', async () => {
    const { id } = await memoryAdapter.create('put-ok@example.com', 'hash');
    const app = buildApp();
    const res = await app.request(`/scim/v2/Users/${id}`, {
      method: 'PUT',
      headers: { ...authHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        schemas: ['urn:ietf:params:scim:schemas:core:2.0:User'],
        userName: 'put-ok@example.com',
        displayName: 'Put OK User',
        active: true,
      }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.schemas).not.toContain(SCIM_ERROR_SCHEMA);
  });
});

// ---------------------------------------------------------------------------
// DELETE /scim/v2/Users/:id — 404 in SCIM error format
// ---------------------------------------------------------------------------

describe('SCIM DELETE /scim/v2/Users/:id — not-found response', () => {
  test('DELETE for non-existent user returns 404 in SCIM error format', async () => {
    const app = buildApp();
    const res = await app.request('/scim/v2/Users/nonexistent-user-id', {
      method: 'DELETE',
      headers: authHeaders,
    });
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.schemas).toContain(SCIM_ERROR_SCHEMA);
    expect(body.status).toBe('404');
    expect(typeof body.detail).toBe('string');
  });
});
