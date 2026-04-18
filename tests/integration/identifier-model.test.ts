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

// ---------------------------------------------------------------------------
// verifyPassword
// ---------------------------------------------------------------------------

describe('verifyPassword', () => {
  test('returns true for correct password', async () => {
    const res = await app.request(
      '/auth/register',
      json({ email: 'vp@example.com', password: 'correct123' }),
    );
    expect(res.status).toBe(201);
    const { userId } = await res.json();

    const valid = await memoryAuthAdapter.verifyPassword(userId, 'correct123');
    expect(valid).toBe(true);
  });

  test('returns false for wrong password', async () => {
    const res = await app.request(
      '/auth/register',
      json({ email: 'vp2@example.com', password: 'correct123' }),
    );
    expect(res.status).toBe(201);
    const { userId } = await res.json();

    const valid = await memoryAuthAdapter.verifyPassword(userId, 'wrong456');
    expect(valid).toBe(false);
  });

  test('returns false for OAuth-only user (no password)', async () => {
    // Create an OAuth-only user by directly using the adapter
    const { id } = await memoryAuthAdapter.findOrCreateByProvider!('google', 'oauth-user-123', {
      email: 'oauthonly@example.com',
    });

    const valid = await memoryAuthAdapter.verifyPassword(id, 'anything');
    expect(valid).toBe(false);
  });

  test('returns false for non-existent userId', async () => {
    const valid = await memoryAuthAdapter.verifyPassword('nonexistent-id', 'password');
    expect(valid).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// getIdentifier
// ---------------------------------------------------------------------------

describe('getIdentifier', () => {
  test('returns email for credential user registered via API', async () => {
    const res = await app.request(
      '/auth/register',
      json({ email: 'ident@example.com', password: 'pass1234' }),
    );
    expect(res.status).toBe(201);
    const { userId } = await res.json();

    const identifier = await memoryAuthAdapter.getIdentifier(userId);
    expect(identifier).toBe('ident@example.com');
  });

  test('returns email for OAuth user with email', async () => {
    const { id } = await memoryAuthAdapter.findOrCreateByProvider!('google', 'oauth-ident-456', {
      email: 'OAuth@Example.COM',
    });

    const identifier = await memoryAuthAdapter.getIdentifier(id);
    expect(identifier).toBe('oauth@example.com');
  });

  test('returns empty string for non-existent userId', async () => {
    const identifier = await memoryAuthAdapter.getIdentifier('nonexistent-id');
    expect(identifier).toBe('');
  });
});

// ---------------------------------------------------------------------------
// Full flow: register → login → verifyPassword
// ---------------------------------------------------------------------------

describe('full flow', () => {
  test('register → login → verifyPassword works', async () => {
    // Register
    const regRes = await app.request(
      '/auth/register',
      json({ email: 'flow@example.com', password: 'secure123' }),
    );
    expect(regRes.status).toBe(201);
    const { userId, token } = await regRes.json();
    expect(userId).toBeString();
    expect(token).toBeString();

    // Login
    const loginRes = await app.request(
      '/auth/login',
      json({ email: 'flow@example.com', password: 'secure123' }),
    );
    expect(loginRes.status).toBe(200);
    const loginBody = await loginRes.json();
    expect(loginBody.userId).toBe(userId);

    // verifyPassword with correct password
    const correctValid = await memoryAuthAdapter.verifyPassword(userId, 'secure123');
    expect(correctValid).toBe(true);

    // verifyPassword with wrong password
    const wrongValid = await memoryAuthAdapter.verifyPassword(userId, 'wrong456');
    expect(wrongValid).toBe(false);

    // getIdentifier returns normalized email
    const identifier = await memoryAuthAdapter.getIdentifier(userId);
    expect(identifier).toBe('flow@example.com');
  });

  test('set-password then verifyPassword reflects the new hash', async () => {
    const regRes = await app.request(
      '/auth/register',
      json({ email: 'changepw@example.com', password: 'oldpass123' }),
    );
    expect(regRes.status).toBe(201);
    const { userId, token } = await regRes.json();

    // Change password via set-password route (requires currentPassword since user has one)
    const pwRes = await app.request('/auth/set-password', {
      method: 'POST',
      headers: { ...authHeader(token), 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: 'newpass456', currentPassword: 'oldpass123' }),
    });
    expect(pwRes.status).toBe(200);

    // Old password no longer works
    const oldValid = await memoryAuthAdapter.verifyPassword(userId, 'oldpass123');
    expect(oldValid).toBe(false);

    // New password works
    const newValid = await memoryAuthAdapter.verifyPassword(userId, 'newpass456');
    expect(newValid).toBe(true);
  });
});
