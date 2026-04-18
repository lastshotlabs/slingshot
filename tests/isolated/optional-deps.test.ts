/**
 * Verifies that optional peer dependencies (mongoose, ioredis, bullmq) are
 * NOT loaded when the configuration doesn't require them.
 *
 * Uses mock.module() to make the optional packages throw on import/require,
 * simulating an environment where they aren't installed. If createApp()
 * accidentally triggers a require() for an unneeded package, the test fails.
 */
import { beforeEach, describe, expect, it, mock } from 'bun:test';
import { createAuthPlugin, createMemoryAuthAdapter } from '@lastshotlabs/slingshot-auth';
import type { AuthPluginConfig } from '@lastshotlabs/slingshot-auth';
// Now import app code — these imports must succeed despite the mocks above,
// because all optional deps use lazy require() inside guarded functions.
import { createApp } from '../../src/app';
import type { CreateAppConfig } from '../../src/app';

// ---------------------------------------------------------------------------
// Mock optional packages BEFORE any app imports — makes require() throw
// just like it would if the package were not installed.
// ---------------------------------------------------------------------------

function notInstalled(name: string) {
  return new Proxy({} as any, {
    get() {
      throw new Error(`${name} is not installed (mocked for test)`);
    },
    construct() {
      throw new Error(`${name} is not installed (mocked for test)`);
    },
    apply() {
      throw new Error(`${name} is not installed (mocked for test)`);
    },
  });
}

mock.module('mongoose', () => notInstalled('mongoose'));
mock.module('ioredis', () => notInstalled('ioredis'));
mock.module('bullmq', () => notInstalled('bullmq'));
mock.module('@lastshotlabs/slingshot-postgres', () =>
  notInstalled('@lastshotlabs/slingshot-postgres'),
);

let memoryAuthAdapter: ReturnType<typeof createMemoryAuthAdapter>;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mkAuthPlugin(overrides: Partial<AuthPluginConfig> = {}) {
  const { auth, db, security, ...restOverrides } = overrides;
  return createAuthPlugin({
    auth: {
      adapter: memoryAuthAdapter,
      roles: ['admin', 'user'],
      defaultRole: 'user',
      ...auth,
    },
    db: {
      sessions: 'memory',
      oauthState: 'memory',
      ...db,
    },
    security: {
      bearerAuth: false,
      ...security,
    },
    ...restOverrides,
  });
}

const baseConfig: CreateAppConfig = {
  routesDir: import.meta.dir + '/../fixtures/routes',
  meta: { name: 'Optional Deps Test' },
  security: {
    rateLimit: { windowMs: 60_000, max: 1000 },
  },
};

function authHeader(token: string): Record<string, string> {
  return { 'x-user-token': token };
}

async function smokeTestAuth(app: any) {
  const regRes = await app.request('/auth/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'nodeps@test.com', password: 'password123' }),
  });
  expect(regRes.status).toBe(201);
  const { token } = await regRes.json();
  expect(token).toBeDefined();

  const meRes = await app.request('/auth/me', { headers: authHeader(token) });
  expect(meRes.status).toBe(200);

  const logoutRes = await app.request('/auth/logout', {
    method: 'POST',
    headers: authHeader(token),
  });
  expect(logoutRes.status).toBe(200);
}

beforeEach(() => {
  memoryAuthAdapter = createMemoryAuthAdapter();
});

// ---------------------------------------------------------------------------
// Tests: app starts without mongoose, ioredis, or bullmq
// ---------------------------------------------------------------------------

describe('no optional deps installed', () => {
  it('starts with all-memory stores', async () => {
    const { app } = await createApp({
      ...baseConfig,
      db: { mongo: false, redis: false, sessions: 'memory', cache: 'memory', auth: 'memory' },
      plugins: [mkAuthPlugin({ auth: { enabled: true, roles: ['user'], defaultRole: 'user' } })],
    });
    await smokeTestAuth(app);
  });

  it('starts with all-sqlite stores', async () => {
    const { app } = await createApp({
      ...baseConfig,
      db: {
        mongo: false,
        redis: false,
        sqlite: ':memory:',
        sessions: 'sqlite',
        cache: 'sqlite',
        auth: 'sqlite',
      },
      plugins: [
        mkAuthPlugin({
          auth: { enabled: true, roles: ['user'], defaultRole: 'user' },
          db: { sessions: 'sqlite' },
        }),
      ],
    });
    await smokeTestAuth(app);
  });

  it('starts with mixed sqlite + memory stores', async () => {
    const { app } = await createApp({
      ...baseConfig,
      db: {
        mongo: false,
        redis: false,
        sqlite: ':memory:',
        sessions: 'sqlite',
        cache: 'memory',
        auth: 'memory',
      },
      plugins: [
        mkAuthPlugin({
          auth: { enabled: true, roles: ['user'], defaultRole: 'user' },
          db: { sessions: 'sqlite' },
        }),
      ],
    });
    await smokeTestAuth(app);
  });

  it('starts with auth disabled and memory cache', async () => {
    const { app } = await createApp({
      ...baseConfig,
      db: { mongo: false, redis: false },
      plugins: [mkAuthPlugin({ auth: { enabled: false } })],
    });
    const res = await app.request('/health');
    expect(res.status).toBe(200);
  });

  it('starts with auth disabled and sqlite cache', async () => {
    const { app } = await createApp({
      ...baseConfig,
      db: { mongo: false, redis: false, sqlite: ':memory:', cache: 'sqlite' },
      plugins: [mkAuthPlugin({ auth: { enabled: false } })],
    });
    const res = await app.request('/health');
    expect(res.status).toBe(200);
  });

  it('starts with email verification on memory stores', async () => {
    const { app } = await createApp({
      ...baseConfig,
      db: { mongo: false, redis: false, sessions: 'memory', cache: 'memory', auth: 'memory' },
      plugins: [mkAuthPlugin({ auth: { enabled: true, emailVerification: { required: false } } })],
    });
    expect(app).toBeTruthy();
  });

  it('starts with password reset on memory stores', async () => {
    const { app } = await createApp({
      ...baseConfig,
      db: { mongo: false, redis: false, sessions: 'memory', cache: 'memory', auth: 'memory' },
      plugins: [mkAuthPlugin({ auth: { enabled: true, passwordReset: {} } })],
    });
    expect(app).toBeTruthy();
  });

  it('starts with MFA on sqlite stores', async () => {
    const { app } = await createApp({
      ...baseConfig,
      db: {
        mongo: false,
        redis: false,
        sqlite: ':memory:',
        sessions: 'sqlite',
        cache: 'sqlite',
        auth: 'sqlite',
      },
      plugins: [
        mkAuthPlugin({
          auth: { enabled: true, mfa: { issuer: 'TestApp' } },
          db: { sessions: 'sqlite' },
        }),
      ],
    });
    expect(app).toBeTruthy();
  });

  it('starts with refresh tokens on memory stores', async () => {
    const { app } = await createApp({
      ...baseConfig,
      db: { mongo: false, redis: false, sessions: 'memory', cache: 'memory', auth: 'memory' },
      plugins: [
        mkAuthPlugin({
          auth: {
            enabled: true,
            refreshTokens: { accessTokenExpiry: 900, refreshTokenExpiry: 86400 },
          },
        }),
      ],
    });
    await smokeTestAuth(app);
  });

  it('starts with CSRF enabled on all-memory stores (no Redis needed)', async () => {
    const { app } = await createApp({
      ...baseConfig,
      db: { mongo: false, redis: false, sessions: 'memory', cache: 'memory', auth: 'memory' },
      plugins: [
        mkAuthPlugin({
          auth: { enabled: true, roles: ['user'], defaultRole: 'user' },
          security: { bearerAuth: false, csrf: { enabled: true } },
        }),
      ],
    });
    const res = await app.request('/health');
    expect(res.status).toBe(200);
  });

  it('starts with mfa.required: true on all-memory stores (no Redis needed)', async () => {
    const { app } = await createApp({
      ...baseConfig,
      db: { mongo: false, redis: false, sessions: 'memory', cache: 'memory', auth: 'memory' },
      plugins: [
        mkAuthPlugin({
          auth: {
            enabled: true,
            roles: ['user'],
            defaultRole: 'user',
            mfa: { issuer: 'TestApp', required: true },
          },
        }),
      ],
    });
    const res = await app.request('/health');
    expect(res.status).toBe(200);
  });

  it('starts with tenancy (header) on all-memory stores without Redis/MongoDB (dev mode)', async () => {
    const { app } = await createApp({
      ...baseConfig,
      db: { mongo: false, redis: false, sessions: 'memory', cache: 'memory', auth: 'memory' },
      plugins: [mkAuthPlugin({ auth: { enabled: true, roles: ['user'], defaultRole: 'user' } })],
      tenancy: {
        resolution: 'header',
        onResolve: async id => (id === 'test' ? { name: 'Test' } : null),
      },
    });
    // Exempt path works without a tenant header
    const res = await app.request('/health');
    expect(res.status).toBe(200);
  });

  it('starts with email verification on all-memory stores and completes auth flow', async () => {
    const { app } = await createApp({
      ...baseConfig,
      db: { mongo: false, redis: false, sessions: 'memory', cache: 'memory', auth: 'memory' },
      plugins: [
        mkAuthPlugin({
          auth: {
            enabled: true,
            roles: ['user'],
            defaultRole: 'user',
            emailVerification: { required: false },
          },
        }),
      ],
    });
    await smokeTestAuth(app);
  });

  it('starts with bot protection block list on all-memory stores (no Redis needed)', async () => {
    const { app } = await createApp({
      ...baseConfig,
      db: { mongo: false, redis: false, sessions: 'memory', cache: 'memory', auth: 'memory' },
      plugins: [mkAuthPlugin({ auth: { enabled: true, roles: ['user'], defaultRole: 'user' } })],
      security: {
        ...baseConfig.security,
        trustProxy: 1,
        botProtection: { blockList: ['10.0.0.0/8'] },
      },
    });
    const res = await app.request('/health');
    expect(res.status).toBe(200);
  });
});
