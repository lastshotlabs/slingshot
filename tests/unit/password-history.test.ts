import { createMemoryAuthAdapter } from '@auth/adapters/memoryAuth';
import { checkPasswordNotReused } from '@auth/lib/passwordHistory';
import type { OpenAPIHono } from '@hono/zod-openapi';
import { beforeEach, describe, expect, test } from 'bun:test';
import { createTestApp } from '../setup';

let memoryAuthAdapter: ReturnType<typeof createMemoryAuthAdapter>;

beforeEach(() => {
  memoryAuthAdapter = createMemoryAuthAdapter();
});

/** Helper: create a user in the memory store and return their ID. */
async function createUser(email: string, password: string): Promise<string> {
  const hash = await Bun.password.hash(password);
  const { id } = await memoryAuthAdapter.create(email, hash);
  return id;
}

// ---------------------------------------------------------------------------
// checkPasswordNotReused
// ---------------------------------------------------------------------------

describe('checkPasswordNotReused', () => {
  test('returns true (OK) when history is empty', async () => {
    const userId = await createUser('a@example.com', 'initial');
    const result = await checkPasswordNotReused(memoryAuthAdapter, userId, 'mynewpass', 5);
    expect(result).toBe(true);
  });

  test('returns true when preventReuse is 0 (feature disabled)', async () => {
    const userId = await createUser('b@example.com', 'initial');
    const result = await checkPasswordNotReused(memoryAuthAdapter, userId, 'anypassword', 0);
    expect(result).toBe(true);
  });

  test('returns false when password matches history', async () => {
    const userId = await createUser('c@example.com', 'initial');
    const adapter = memoryAuthAdapter;
    const hash = await Bun.password.hash('oldpassword');
    await adapter.addPasswordToHistory!(userId, hash, 5);

    const result = await checkPasswordNotReused(memoryAuthAdapter, userId, 'oldpassword', 5);
    expect(result).toBe(false);
  });

  test('returns true when password does not match any history entry', async () => {
    const userId = await createUser('d@example.com', 'initial');
    const adapter = memoryAuthAdapter;
    const hash = await Bun.password.hash('oldpassword');
    await adapter.addPasswordToHistory!(userId, hash, 5);

    const result = await checkPasswordNotReused(memoryAuthAdapter, userId, 'differentpassword', 5);
    expect(result).toBe(true);
  });

  test('detects reuse across multiple history entries', async () => {
    const userId = await createUser('e@example.com', 'initial');
    const adapter = memoryAuthAdapter;
    const hash1 = await Bun.password.hash('pass1');
    const hash2 = await Bun.password.hash('pass2');
    const hash3 = await Bun.password.hash('pass3');
    await adapter.addPasswordToHistory!(userId, hash1, 5);
    await adapter.addPasswordToHistory!(userId, hash2, 5);
    await adapter.addPasswordToHistory!(userId, hash3, 5);

    expect(await checkPasswordNotReused(memoryAuthAdapter, userId, 'pass1', 5)).toBe(false);
    expect(await checkPasswordNotReused(memoryAuthAdapter, userId, 'pass2', 5)).toBe(false);
    expect(await checkPasswordNotReused(memoryAuthAdapter, userId, 'pass3', 5)).toBe(false);
    // A new password should pass
    expect(await checkPasswordNotReused(memoryAuthAdapter, userId, 'pass4', 5)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// addPasswordToHistory (maxCount trimming)
// ---------------------------------------------------------------------------

describe('addPasswordToHistory — trim to maxCount', () => {
  test('trims history to maxCount most recent entries', async () => {
    const userId = await createUser('f@example.com', 'initial');
    const adapter = memoryAuthAdapter;
    const plainPasswords = ['a', 'b', 'c', 'd', 'e', 'f'];
    const hashes = await Promise.all(plainPasswords.map(p => Bun.password.hash(p)));

    for (const h of hashes) {
      await adapter.addPasswordToHistory!(userId, h, 3);
    }

    const history = await adapter.getPasswordHistory!(userId);
    // Only the 3 most recent entries should remain
    expect(history.length).toBe(3);
    // Entries d, e, f are the most recent
    expect(await Bun.password.verify('d', history[0])).toBe(true);
    expect(await Bun.password.verify('e', history[1])).toBe(true);
    expect(await Bun.password.verify('f', history[2])).toBe(true);
  });

  test('history for unknown user returns empty array', async () => {
    const adapter = memoryAuthAdapter;
    const history = await adapter.getPasswordHistory!('nonexistent');
    expect(history).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// End-to-end: set-password with reuse prevention
// ---------------------------------------------------------------------------

describe('POST /auth/set-password — password history enforcement', () => {
  let app: OpenAPIHono<any>;
  let appAdapter: ReturnType<typeof createMemoryAuthAdapter>;

  beforeEach(async () => {
    appAdapter = createMemoryAuthAdapter();
    app = await createTestApp(
      {},
      {
        auth: {
          enabled: true,
          adapter: appAdapter,
          passwordPolicy: { preventReuse: 3 },
        },
      },
    );
  });

  const json = (body: Record<string, unknown>) => ({
    method: 'POST' as const,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  async function registerAndLogin(email: string, password: string) {
    const reg = await app.request('/auth/register', json({ email, password }));
    const { token, userId } = await reg.json();
    return { token, userId };
  }

  test('rejects reused password with 400 PASSWORD_PREVIOUSLY_USED', async () => {
    const { token } = await registerAndLogin('a@example.com', 'password123');
    // Set password to newpassword1 — this records newpassword1 in history
    const setRes1 = await app.request('/auth/set-password', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-user-token': token },
      body: JSON.stringify({ password: 'newpassword1', currentPassword: 'password123' }),
    });
    expect(setRes1.status).toBe(200);

    // Now login with newpassword1 to get a fresh token (set-password may have rotated sessions)
    const loginRes = await app.request(
      '/auth/login',
      json({ email: 'a@example.com', password: 'newpassword1' }),
    );
    const { token: token2 } = await loginRes.json();

    // Try to change to newpassword2 — this should succeed and record newpassword2
    const setRes2 = await app.request('/auth/set-password', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-user-token': token2 },
      body: JSON.stringify({ password: 'newpassword2', currentPassword: 'newpassword1' }),
    });
    expect(setRes2.status).toBe(200);

    // Login again with newpassword2
    const loginRes2 = await app.request(
      '/auth/login',
      json({ email: 'a@example.com', password: 'newpassword2' }),
    );
    const { token: token3 } = await loginRes2.json();

    // Try to reuse newpassword1 — it's in history, should be rejected
    const setRes3 = await app.request('/auth/set-password', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-user-token': token3 },
      body: JSON.stringify({ password: 'newpassword1', currentPassword: 'newpassword2' }),
    });
    expect(setRes3.status).toBe(400);
    const body = await setRes3.json();
    expect(body.code).toBe('PASSWORD_PREVIOUSLY_USED');
  });

  test('accepts new password not in history', async () => {
    const { token } = await registerAndLogin('b@example.com', 'password123');
    const setRes = await app.request('/auth/set-password', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-user-token': token },
      body: JSON.stringify({ password: 'brandnewpassword1', currentPassword: 'password123' }),
    });
    expect(setRes.status).toBe(200);
  });

  test('records password change to history', async () => {
    const { token, userId } = await registerAndLogin('c@example.com', 'password123');
    await app.request('/auth/set-password', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-user-token': token },
      body: JSON.stringify({ password: 'newpassword1', currentPassword: 'password123' }),
    });

    const history = await appAdapter.getPasswordHistory!(userId);
    expect(history.length).toBeGreaterThan(0);
  });
});
