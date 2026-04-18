import type { OpenAPIHono } from '@hono/zod-openapi';
import { beforeEach, describe, expect, test } from 'bun:test';
import { authHeader, createMemoryAuthAdapter, createTestApp } from '../setup';

let app: OpenAPIHono<any>;
let memoryAuthAdapter: ReturnType<typeof createMemoryAuthAdapter>;

beforeEach(async () => {
  memoryAuthAdapter = createMemoryAuthAdapter();
  app = await createTestApp({}, { auth: { adapter: memoryAuthAdapter } });
});

const json = (body: Record<string, unknown>) => ({
  method: 'POST' as const,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

async function registerAndLogin(email = 'meta@example.com', password = 'password123!') {
  const res = await app.request('/auth/register', json({ email, password }));
  const body = (await res.json()) as { token: string; userId: string };
  return body;
}

// ---------------------------------------------------------------------------
// GET /auth/me — userMetadata field
// ---------------------------------------------------------------------------

describe('GET /auth/me — userMetadata', () => {
  test('includes userMetadata as empty object for new user', async () => {
    const { token } = await registerAndLogin();
    const res = await app.request('/auth/me', { headers: authHeader(token) });
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.userMetadata).toEqual({});
  });

  test('does NOT include appMetadata in response', async () => {
    const { token } = await registerAndLogin();
    const res = await app.request('/auth/me', { headers: authHeader(token) });
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.appMetadata).toBeUndefined();
  });

  test('reflects userMetadata after it has been set', async () => {
    const { token, userId } = await registerAndLogin();
    await memoryAuthAdapter.setUserMetadata!(userId, { theme: 'dark', lang: 'en' });
    const res = await app.request('/auth/me', { headers: authHeader(token) });
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.userMetadata).toEqual({ theme: 'dark', lang: 'en' });
  });
});

// ---------------------------------------------------------------------------
// PATCH /auth/me — userMetadata update
// ---------------------------------------------------------------------------

describe('PATCH /auth/me — userMetadata update', () => {
  test('updates userMetadata via PATCH', async () => {
    const { token } = await registerAndLogin();
    const patchRes = await app.request('/auth/me', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', ...authHeader(token) },
      body: JSON.stringify({ userMetadata: { color: 'blue', count: 42 } }),
    });
    expect(patchRes.status).toBe(200);

    const meRes = await app.request('/auth/me', { headers: authHeader(token) });
    const body = (await meRes.json()) as any;
    expect(body.userMetadata).toEqual({ color: 'blue', count: 42 });
  });

  test('replaces existing userMetadata on subsequent PATCH', async () => {
    const { token } = await registerAndLogin();
    await app.request('/auth/me', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', ...authHeader(token) },
      body: JSON.stringify({ userMetadata: { old: 'value' } }),
    });
    await app.request('/auth/me', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', ...authHeader(token) },
      body: JSON.stringify({ userMetadata: { new: 'data' } }),
    });
    const meRes = await app.request('/auth/me', { headers: authHeader(token) });
    const body = (await meRes.json()) as any;
    expect(body.userMetadata).toEqual({ new: 'data' });
    expect(body.userMetadata.old).toBeUndefined();
  });

  test('returns 401 without auth', async () => {
    const res = await app.request('/auth/me', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userMetadata: {} }),
    });
    expect(res.status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// Memory adapter — direct adapter tests (all 3 metadata methods)
// ---------------------------------------------------------------------------

describe('memoryAuthAdapter — metadata methods', () => {
  test('getUserMetadata returns empty for new user', async () => {
    const { id } = await memoryAuthAdapter.create('m1@example.com', 'hash');
    const result = await memoryAuthAdapter.getUserMetadata!(id);
    expect(result.userMetadata).toBeUndefined();
    expect(result.appMetadata).toBeUndefined();
  });

  test('setUserMetadata stores and retrieves user metadata', async () => {
    const { id } = await memoryAuthAdapter.create('m2@example.com', 'hash');
    await memoryAuthAdapter.setUserMetadata!(id, { plan: 'pro', onboarded: true });
    const result = await memoryAuthAdapter.getUserMetadata!(id);
    expect(result.userMetadata).toEqual({ plan: 'pro', onboarded: true });
  });

  test('setAppMetadata stores and retrieves app metadata', async () => {
    const { id } = await memoryAuthAdapter.create('m3@example.com', 'hash');
    await memoryAuthAdapter.setAppMetadata!(id, { tier: 'enterprise', customerId: 'cus_123' });
    const result = await memoryAuthAdapter.getUserMetadata!(id);
    expect(result.appMetadata).toEqual({ tier: 'enterprise', customerId: 'cus_123' });
  });

  test('setUserMetadata does NOT affect appMetadata', async () => {
    const { id } = await memoryAuthAdapter.create('m4@example.com', 'hash');
    await memoryAuthAdapter.setAppMetadata!(id, { internal: 'data' });
    await memoryAuthAdapter.setUserMetadata!(id, { pref: 'x' });
    const result = await memoryAuthAdapter.getUserMetadata!(id);
    expect(result.appMetadata).toEqual({ internal: 'data' });
    expect(result.userMetadata).toEqual({ pref: 'x' });
  });

  test('setAppMetadata does NOT affect userMetadata', async () => {
    const { id } = await memoryAuthAdapter.create('m5@example.com', 'hash');
    await memoryAuthAdapter.setUserMetadata!(id, { userPref: 'y' });
    await memoryAuthAdapter.setAppMetadata!(id, { adminNote: 'z' });
    const result = await memoryAuthAdapter.getUserMetadata!(id);
    expect(result.userMetadata).toEqual({ userPref: 'y' });
    expect(result.appMetadata).toEqual({ adminNote: 'z' });
  });

  test('getUser includes userMetadata and appMetadata', async () => {
    const { id } = await memoryAuthAdapter.create('m6@example.com', 'hash');
    await memoryAuthAdapter.setUserMetadata!(id, { theme: 'light' });
    await memoryAuthAdapter.setAppMetadata!(id, { role: 'vip' });
    const user = await memoryAuthAdapter.getUser!(id);
    expect(user?.userMetadata).toEqual({ theme: 'light' });
    expect(user?.appMetadata).toEqual({ role: 'vip' });
  });

  test('setUserMetadata replaces existing data', async () => {
    const { id } = await memoryAuthAdapter.create('m7@example.com', 'hash');
    await memoryAuthAdapter.setUserMetadata!(id, { a: 1, b: 2 });
    await memoryAuthAdapter.setUserMetadata!(id, { c: 3 });
    const result = await memoryAuthAdapter.getUserMetadata!(id);
    expect(result.userMetadata).toEqual({ c: 3 });
    expect((result.userMetadata as any)?.a).toBeUndefined();
  });

  test('appMetadata is NOT updated via updateProfile', async () => {
    const { id } = await memoryAuthAdapter.create('m8@example.com', 'hash');
    await memoryAuthAdapter.setAppMetadata!(id, { secret: 'value' });
    // updateProfile should not expose appMetadata update
    await memoryAuthAdapter.updateProfile!(id, { displayName: 'Test' });
    const result = await memoryAuthAdapter.getUserMetadata!(id);
    expect(result.appMetadata).toEqual({ secret: 'value' });
  });
});
