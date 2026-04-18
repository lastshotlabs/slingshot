import { beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { Hono } from 'hono';
import type { AppEnv } from '@lastshotlabs/slingshot-core';
import { createM2MRouter } from '@lastshotlabs/slingshot-m2m';
import type { AuthRuntimeContext } from '../../src/runtime';
import { makeTestRuntime, wrapWithRuntime } from '../helpers/runtime';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const CLIENT_SECRET = 'hunter2-supersecret';
let clientSecretHash: string;

beforeAll(async () => {
  clientSecretHash = await Bun.password.hash(CLIENT_SECRET);
});

function buildApp(runtime: AuthRuntimeContext): Hono<AppEnv> {
  const app = wrapWithRuntime(runtime);
  const router = createM2MRouter(runtime);
  app.route('/', router);
  return app;
}

async function tokenRequest(
  app: Hono<AppEnv>,
  body: Record<string, string>,
): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await app.fetch(
    new Request('http://localhost/oauth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
  );
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('M2M client_credentials scope validation', () => {
  let runtime: AuthRuntimeContext;

  beforeEach(() => {
    runtime = makeTestRuntime({ m2m: { tokenExpiry: 3600 } });
  });

  test('valid credentials with a subset of scopes — only the requested scopes are granted', async () => {
    await runtime.adapter.createM2MClient!({
      clientId: 'svc-a',
      clientSecretHash,
      name: 'Service A',
      scopes: ['read:users', 'write:users', 'read:orders'],
    });
    const app = buildApp(runtime);

    const { status, json } = await tokenRequest(app, {
      grant_type: 'client_credentials',
      client_id: 'svc-a',
      client_secret: CLIENT_SECRET,
      scope: 'read:users read:orders',
    });

    expect(status).toBe(200);
    expect(json.token_type).toBe('Bearer');
    expect(typeof json.access_token).toBe('string');
    const granted = (json.scope as string).split(' ');
    expect(granted.sort()).toEqual(['read:orders', 'read:users']);
    expect(granted).not.toContain('write:users');
  });

  test('empty scope field — all client scopes are granted', async () => {
    await runtime.adapter.createM2MClient!({
      clientId: 'svc-b',
      clientSecretHash,
      name: 'Service B',
      scopes: ['read:items', 'write:items'],
    });
    const app = buildApp(runtime);

    const { status, json } = await tokenRequest(app, {
      grant_type: 'client_credentials',
      client_id: 'svc-b',
      client_secret: CLIENT_SECRET,
      // No scope field → grant all
    });

    expect(status).toBe(200);
    const granted = (json.scope as string).split(' ');
    expect(granted.sort()).toEqual(['read:items', 'write:items']);
  });

  test('requesting a scope not in the client allowlist returns 400 invalid_scope', async () => {
    await runtime.adapter.createM2MClient!({
      clientId: 'svc-c',
      clientSecretHash,
      name: 'Service C',
      scopes: ['read:items'],
    });
    const app = buildApp(runtime);

    const { status, json } = await tokenRequest(app, {
      grant_type: 'client_credentials',
      client_id: 'svc-c',
      client_secret: CLIENT_SECRET,
      scope: 'read:items delete:everything', // delete:everything not allowed
    });

    expect(status).toBe(400);
    expect(json.error).toBe('invalid_scope');
  });

  test('unsupported grant_type returns 400 unsupported_grant_type', async () => {
    const app = buildApp(runtime);

    const { status, json } = await tokenRequest(app, {
      grant_type: 'authorization_code',
      client_id: 'any',
      client_secret: 'any',
    });

    expect(status).toBe(400);
    expect(json.error).toBe('unsupported_grant_type');
  });
});
