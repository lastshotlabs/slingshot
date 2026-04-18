/**
 * Tests queued account deletion (DELETE /auth/me with accountDeletion.queued: true)
 * and POST /auth/cancel-deletion with a mocked @lib/queue.
 *
 * Must run in a separate bun test invocation to prevent mock leakage.
 */
import { beforeEach, describe, expect, mock, test } from 'bun:test';
import { createAuthPlugin, createMemoryAuthAdapter } from '@lastshotlabs/slingshot-auth';
import type { AuthPluginConfig } from '@lastshotlabs/slingshot-auth';
import { getContext } from '@lastshotlabs/slingshot-core';
// ---------------------------------------------------------------------------
// Import after mocks are in place
// ---------------------------------------------------------------------------

import { createApp } from '../../src/app';
import type { CreateAppConfig } from '../../src/app';

// ---------------------------------------------------------------------------
// Mock @lib/queue before any module that imports it
// ---------------------------------------------------------------------------

let _lastJobId = 1;
let _fakeJobRemoved = false;
let _fakeJobExists = true;
let _workerHandler: ((job: { data: { userId: string } }) => Promise<void>) | null = null;

const makeQueueApi = () => ({
  createQueue: () => ({
    add: async () => ({ id: `job-${_lastJobId++}` }),
    close: async () => {},
    getJob: async () =>
      _fakeJobExists
        ? {
            remove: async () => {
              _fakeJobRemoved = true;
            },
          }
        : null,
  }),
  createWorker: (_name: string, handler: (job: { data: { userId: string } }) => Promise<void>) => {
    _workerHandler = handler;
    return { on: () => {}, close: async () => {} };
  },
});

const fakeQueueModule = () => ({
  ...makeQueueApi(),
  createQueueFactory: () => makeQueueApi(),
});

// Mock both the old framework queue and the auth package's internal queue
mock.module('../../src/lib/queue', fakeQueueModule);
mock.module('../../src/lib/redis', () => ({
  connectRedis: async () => ({ options: { host: 'localhost', port: 6379 } }),
}));

// Mock the auth package's redis accessor so getRedis doesn't throw
mock.module('../../packages/slingshot-auth/src/infra/redis', () => ({
  setRedis: () => {},
  getRedis: () => ({ options: { host: 'localhost', port: 6379 } }),
}));

// Mock the auth package's queue module
mock.module('../../packages/slingshot-auth/src/infra/queue', fakeQueueModule);

// Prevent ioredis / bullmq from being loaded at all
mock.module('ioredis', () => ({
  default: class {
    on() {}
    once() {}
  },
}));
mock.module('bullmq', () => ({}));

let memoryAuthAdapter: ReturnType<typeof createMemoryAuthAdapter>;

function mkAuthPlugin(overrides: Partial<AuthPluginConfig> = {}) {
  const { auth, db, security, ...restOverrides } = overrides;
  return createAuthPlugin({
    auth: {
      adapter: memoryAuthAdapter,
      roles: ['user'],
      defaultRole: 'user',
      ...auth,
    },
    db: { sessions: 'memory', ...db },
    security: { bearerAuth: false, ...security },
    ...restOverrides,
  });
}

function baseConfig(): CreateAppConfig {
  return {
    routesDir: import.meta.dir + '/../fixtures/routes',
    meta: { name: 'Test App' },
    db: { mongo: false, redis: true, sessions: 'memory', cache: 'memory', auth: 'memory' },
    security: { rateLimit: { windowMs: 60_000, max: 1000 } },
    logging: { onLog: () => {} },
    plugins: [mkAuthPlugin()],
  };
}

beforeEach(() => {
  memoryAuthAdapter = createMemoryAuthAdapter();
  _lastJobId = 1;
  _fakeJobRemoved = false;
  _fakeJobExists = true;
  _workerHandler = null;
  process.env.REDIS_HOST = 'localhost:6379';
});

const json = (body: unknown) => ({
  method: 'POST' as const,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

function authHeader(token: string): Record<string, string> {
  return { 'x-user-token': token };
}

// ---------------------------------------------------------------------------
// DELETE /auth/me — queued deletion
// ---------------------------------------------------------------------------

describe('DELETE /auth/me — queued deletion', () => {
  test('returns 202 when accountDeletion.queued is true', async () => {
    const { app } = await createApp({
      ...baseConfig(),
      plugins: [mkAuthPlugin({ auth: { accountDeletion: { enabled: true, queued: true } } })],
    });

    const reg = await app.request(
      '/auth/register',
      json({ email: 'queued@test.com', password: 'Password1!' }),
    );
    const { token } = (await reg.json()) as { token: string };

    const res = await app.request('/auth/me', {
      method: 'DELETE',
      headers: { ...authHeader(token), 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: 'Password1!' }),
    });
    expect(res.status).toBe(202);
    const body = (await res.json()) as { ok: boolean };
    expect(body.ok).toBe(true);
  });

  test('emits account_deletion delivery event with cancel token when gracePeriod is set', async () => {
    let scheduledUserId: string | undefined;
    let scheduledEmail: string | undefined;
    let scheduledToken: string | undefined;

    const { app } = await createApp({
      ...baseConfig(),
      plugins: [
        mkAuthPlugin({
          auth: {
            accountDeletion: {
              enabled: true,
              queued: true,
              gracePeriod: 3600,
            },
          },
        }),
      ],
    });

    // Register listener AFTER createApp so we get the bus set by the plugin
    const handler = (payload: { userId: string; email: string; cancelToken: string }) => {
      scheduledUserId = payload.userId;
      scheduledEmail = payload.email;
      scheduledToken = payload.cancelToken;
    };
    getContext(app).bus.on('auth:delivery.account_deletion', handler);

    const reg = await app.request(
      '/auth/register',
      json({ email: 'grace@test.com', password: 'Password1!' }),
    );
    const { token, userId } = (await reg.json()) as { token: string; userId: string };

    const res = await app.request('/auth/me', {
      method: 'DELETE',
      headers: { ...authHeader(token), 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: 'Password1!' }),
    });
    getContext(app).bus.off('auth:delivery.account_deletion', handler);
    expect(res.status).toBe(202);
    expect(scheduledUserId).toBe(userId);
    expect(scheduledEmail).toBe('grace@test.com');
    expect(scheduledToken).toBeString();
  });

  test('preDeleteAccount blocks queued deletion scheduling', async () => {
    const { app } = await createApp({
      ...baseConfig(),
      plugins: [
        mkAuthPlugin({
          auth: {
            accountDeletion: {
              enabled: true,
              queued: true,
            },
            hooks: {
              preDeleteAccount: async () => {
                throw new Error('queued deletion blocked');
              },
            },
          },
        }),
      ],
    });

    const reg = await app.request(
      '/auth/register',
      json({ email: 'blocked-queued@test.com', password: 'Password1!' }),
    );
    const { token } = (await reg.json()) as { token: string };

    const res = await app.request('/auth/me', {
      method: 'DELETE',
      headers: { ...authHeader(token), 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: 'Password1!' }),
    });
    expect(res.status).toBe(500);
    expect(_lastJobId).toBe(1);
  });

  test('queued scheduling does not run onBeforeDelete before worker execution', async () => {
    const calls: string[] = [];
    const { app } = await createApp({
      ...baseConfig(),
      plugins: [
        mkAuthPlugin({
          auth: {
            accountDeletion: {
              enabled: true,
              queued: true,
              onBeforeDelete: async userId => {
                calls.push(`before:${userId}`);
              },
            },
          },
        }),
      ],
    });

    const reg = await app.request(
      '/auth/register',
      json({ email: 'queued-before@test.com', password: 'Password1!' }),
    );
    const { token } = (await reg.json()) as { token: string };

    const res = await app.request('/auth/me', {
      method: 'DELETE',
      headers: { ...authHeader(token), 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: 'Password1!' }),
    });
    expect(res.status).toBe(202);
    expect(calls).toHaveLength(0);
  });

  test('queued worker emits deletion events and postDeleteAccount after execution', async () => {
    const calls: string[] = [];
    let deletedUserId: string | undefined;
    let authDeletedUserId: string | undefined;

    const { app } = await createApp({
      ...baseConfig(),
      plugins: [
        mkAuthPlugin({
          auth: {
            accountDeletion: {
              enabled: true,
              queued: true,
              onBeforeDelete: async userId => {
                calls.push(`before:${userId}`);
              },
              onAfterDelete: async userId => {
                calls.push(`after:${userId}`);
              },
            },
            hooks: {
              postDeleteAccount: async ({ userId }) => {
                calls.push(`post:${userId}`);
              },
            },
          },
        }),
      ],
    });

    getContext(app).bus.on('security.auth.account.deleted', ({ userId }: { userId: string }) => {
      deletedUserId = userId;
    });
    getContext(app).bus.on('auth:user.deleted', ({ userId }: { userId: string }) => {
      authDeletedUserId = userId;
    });

    const reg = await app.request(
      '/auth/register',
      json({ email: 'queued-worker@test.com', password: 'Password1!' }),
    );
    const { token, userId } = (await reg.json()) as { token: string; userId: string };

    const res = await app.request('/auth/me', {
      method: 'DELETE',
      headers: { ...authHeader(token), 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: 'Password1!' }),
    });
    expect(res.status).toBe(202);
    expect(_workerHandler).not.toBeNull();

    await _workerHandler!({ data: { userId } });
    await Bun.sleep(10);

    expect(calls).toContain(`before:${userId}`);
    expect(calls).toContain(`after:${userId}`);
    expect(calls).toContain(`post:${userId}`);
    expect(deletedUserId).toBe(userId);
    expect(authDeletedUserId).toBe(userId);
    await expect(memoryAuthAdapter.getUser?.(userId)).resolves.toBeNull();
  });

  test('queued worker revokes sessions created after deletion was scheduled', async () => {
    const { app } = await createApp({
      ...baseConfig(),
      plugins: [
        mkAuthPlugin({
          auth: {
            accountDeletion: {
              enabled: true,
              queued: true,
              gracePeriod: 3600,
            },
          },
        }),
      ],
    });

    await app.request(
      '/auth/register',
      json({ email: 'late-session@test.com', password: 'Password1!' }),
    );
    const login = await app.request(
      '/auth/login',
      json({ email: 'late-session@test.com', password: 'Password1!' }),
    );
    const { token, userId } = (await login.json()) as { token: string; userId: string };

    const schedule = await app.request('/auth/me', {
      method: 'DELETE',
      headers: { ...authHeader(token), 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: 'Password1!' }),
    });
    expect(schedule.status).toBe(202);

    const relogin = await app.request(
      '/auth/login',
      json({ email: 'late-session@test.com', password: 'Password1!' }),
    );
    expect(relogin.status).toBe(200);
    const { token: lateToken } = (await relogin.json()) as { token: string };

    await _workerHandler!({ data: { userId } });

    const me = await app.request('/auth/me', {
      headers: authHeader(lateToken),
    });
    expect(me.status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// POST /auth/cancel-deletion
// ---------------------------------------------------------------------------

describe('POST /auth/cancel-deletion', () => {
  test('returns 200 with valid cancel token and removes the job', async () => {
    let capturedCancelToken: string | undefined;

    const { app } = await createApp({
      ...baseConfig(),
      plugins: [
        mkAuthPlugin({
          auth: {
            accountDeletion: {
              enabled: true,
              queued: true,
              gracePeriod: 3600,
            },
          },
        }),
      ],
    });

    // Register listener AFTER createApp so we get the bus set by the plugin
    const handler = (payload: { cancelToken: string }) => {
      capturedCancelToken = payload.cancelToken;
    };
    getContext(app).bus.on('auth:delivery.account_deletion', handler);

    const reg = await app.request(
      '/auth/register',
      json({ email: 'cancel@test.com', password: 'Password1!' }),
    );
    const { token } = (await reg.json()) as { token: string };

    await app.request('/auth/me', {
      method: 'DELETE',
      headers: { ...authHeader(token), 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: 'Password1!' }),
    });
    getContext(app).bus.off('auth:delivery.account_deletion', handler);
    expect(capturedCancelToken).toBeString();

    const res = await app.request('/auth/cancel-deletion', json({ token: capturedCancelToken }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean };
    expect(body.ok).toBe(true);
    expect(_fakeJobRemoved).toBe(true);
  });

  test('returns 200 even when the job no longer exists', async () => {
    let capturedCancelToken: string | undefined;
    _fakeJobExists = false;

    const { app } = await createApp({
      ...baseConfig(),
      plugins: [
        mkAuthPlugin({
          auth: {
            accountDeletion: {
              enabled: true,
              queued: true,
              gracePeriod: 3600,
            },
          },
        }),
      ],
    });

    // Register listener AFTER createApp so we get the bus set by the plugin
    const handler = (payload: { cancelToken: string }) => {
      capturedCancelToken = payload.cancelToken;
    };
    getContext(app).bus.on('auth:delivery.account_deletion', handler);

    const reg = await app.request(
      '/auth/register',
      json({ email: 'cancelnojob@test.com', password: 'Password1!' }),
    );
    const { token } = (await reg.json()) as { token: string };

    await app.request('/auth/me', {
      method: 'DELETE',
      headers: { ...authHeader(token), 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: 'Password1!' }),
    });
    getContext(app).bus.off('auth:delivery.account_deletion', handler);

    const res = await app.request('/auth/cancel-deletion', json({ token: capturedCancelToken }));
    expect(res.status).toBe(200);
  });

  test('returns 400 with an invalid cancel token', async () => {
    const { app } = await createApp({
      ...baseConfig(),
      plugins: [
        mkAuthPlugin({
          auth: { accountDeletion: { enabled: true, queued: true, gracePeriod: 3600 } },
        }),
      ],
    });

    const res = await app.request('/auth/cancel-deletion', json({ token: 'not-a-valid-token' }));
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain('Invalid');
  });
});
