import { beforeEach, describe, expect, it } from 'bun:test';
import { authHeader, createTestApp } from '../setup';

// ---------------------------------------------------------------------------
// Helper: register + login + verify sessions work for a given app
// ---------------------------------------------------------------------------

async function smokeTestAuth(app: any) {
  // Register
  const regRes = await app.request('/auth/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'combo@test.com', password: 'password123' }),
  });
  expect(regRes.status).toBe(201);
  const { token } = await regRes.json();
  expect(token).toBeDefined();

  // /auth/me should work
  const meRes = await app.request('/auth/me', {
    headers: authHeader(token),
  });
  expect(meRes.status).toBe(200);

  // Sessions list should return at least 1
  const sessRes = await app.request('/auth/sessions', {
    headers: authHeader(token),
  });
  expect(sessRes.status).toBe(200);
  const { sessions } = await sessRes.json();
  expect(sessions.length).toBeGreaterThanOrEqual(1);

  // Logout
  const logoutRes = await app.request('/auth/logout', {
    method: 'POST',
    headers: authHeader(token),
  });
  expect(logoutRes.status).toBe(200);

  return token;
}

// ---------------------------------------------------------------------------
// All-memory (baseline)
// ---------------------------------------------------------------------------

describe('storage: all memory', () => {
  it('starts and runs auth flow', async () => {
    const app = await createTestApp({
      db: { mongo: false, redis: false, sessions: 'memory', cache: 'memory', auth: 'memory' },
    });
    await smokeTestAuth(app);
  });
});

// ---------------------------------------------------------------------------
// All-SQLite
// ---------------------------------------------------------------------------

describe('storage: all sqlite', () => {
  it('starts and runs auth flow', async () => {
    const app = await createTestApp({
      db: {
        mongo: false,
        redis: false,
        sqlite: ':memory:',
        sessions: 'sqlite',
        cache: 'sqlite',
        auth: 'sqlite',
      },
    });
    await smokeTestAuth(app);
  });
});

// ---------------------------------------------------------------------------
// Mixed: sqlite sessions + memory auth + memory cache
// ---------------------------------------------------------------------------

describe('storage: sqlite sessions, memory auth, memory cache', () => {
  it('starts and runs auth flow', async () => {
    const app = await createTestApp({
      db: {
        mongo: false,
        redis: false,
        sqlite: ':memory:',
        sessions: 'sqlite',
        cache: 'memory',
        auth: 'memory',
      },
    });
    await smokeTestAuth(app);
  });
});

// ---------------------------------------------------------------------------
// Mixed: memory sessions + sqlite auth + memory cache
// ---------------------------------------------------------------------------

describe('storage: memory sessions, sqlite auth, memory cache', () => {
  it('starts and runs auth flow', async () => {
    const app = await createTestApp({
      db: {
        mongo: false,
        redis: false,
        sqlite: ':memory:',
        sessions: 'memory',
        cache: 'memory',
        auth: 'sqlite',
      },
    });
    await smokeTestAuth(app);
  });
});

// ---------------------------------------------------------------------------
// Mixed: memory sessions + memory auth + sqlite cache
// ---------------------------------------------------------------------------

describe('storage: memory sessions, memory auth, sqlite cache', () => {
  it('starts and runs auth flow with cached route', async () => {
    const app = await createTestApp({
      db: {
        mongo: false,
        redis: false,
        sqlite: ':memory:',
        sessions: 'memory',
        cache: 'sqlite',
        auth: 'memory',
      },
    });
    await smokeTestAuth(app);

    // Hit a cached route to exercise the cache store
    const res1 = await app.request('/cached');
    expect(res1.status).toBe(200);
    const res2 = await app.request('/cached');
    expect(res2.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// Mixed: sqlite sessions + sqlite auth + memory cache
// ---------------------------------------------------------------------------

describe('storage: sqlite sessions, sqlite auth, memory cache', () => {
  it('starts and runs auth flow', async () => {
    const app = await createTestApp({
      db: {
        mongo: false,
        redis: false,
        sqlite: ':memory:',
        sessions: 'sqlite',
        cache: 'memory',
        auth: 'sqlite',
      },
    });
    await smokeTestAuth(app);
  });
});

// ---------------------------------------------------------------------------
// Mixed: sqlite sessions + memory auth + sqlite cache
// ---------------------------------------------------------------------------

describe('storage: sqlite sessions, memory auth, sqlite cache', () => {
  it('starts and runs auth flow', async () => {
    const app = await createTestApp({
      db: {
        mongo: false,
        redis: false,
        sqlite: ':memory:',
        sessions: 'sqlite',
        cache: 'sqlite',
        auth: 'memory',
      },
    });
    await smokeTestAuth(app);
  });
});

// ---------------------------------------------------------------------------
// Mixed: memory sessions + sqlite auth + sqlite cache
// ---------------------------------------------------------------------------

describe('storage: memory sessions, sqlite auth, sqlite cache', () => {
  it('starts and runs auth flow', async () => {
    const app = await createTestApp({
      db: {
        mongo: false,
        redis: false,
        sqlite: ':memory:',
        sessions: 'memory',
        cache: 'sqlite',
        auth: 'sqlite',
      },
    });
    await smokeTestAuth(app);
  });
});

// ---------------------------------------------------------------------------
// Smart defaults: only sqlite path provided, no explicit store settings
// ---------------------------------------------------------------------------

describe('storage: smart defaults with sqlite path only', () => {
  it('defaults all stores to sqlite when only sqlite path is given', async () => {
    const app = await createTestApp({
      db: { mongo: false, redis: false, sqlite: ':memory:' },
    });
    await smokeTestAuth(app);
  });
});

// ---------------------------------------------------------------------------
// Smart defaults: no db config at all (everything disabled)
// ---------------------------------------------------------------------------

describe('storage: smart defaults with everything disabled', () => {
  it('defaults to memory when mongo and redis are disabled', async () => {
    const app = await createTestApp({
      db: { mongo: false, redis: false },
    });
    await smokeTestAuth(app);
  });
});

// ---------------------------------------------------------------------------
// OAuth state store differs from session store
// ---------------------------------------------------------------------------

describe('storage: oauthState on different store than sessions', () => {
  it('sqlite sessions + memory oauthState', async () => {
    const app = await createTestApp({
      db: {
        mongo: false,
        redis: false,
        sqlite: ':memory:',
        sessions: 'sqlite',
        oauthState: 'memory',
        cache: 'memory',
        auth: 'memory',
      },
    });
    await smokeTestAuth(app);
  });

  it('memory sessions + sqlite oauthState', async () => {
    const app = await createTestApp({
      db: {
        mongo: false,
        redis: false,
        sqlite: ':memory:',
        sessions: 'memory',
        oauthState: 'sqlite',
        cache: 'memory',
        auth: 'memory',
      },
    });
    await smokeTestAuth(app);
  });
});

// ---------------------------------------------------------------------------
// Features on top of mixed stores (email verification, password reset, MFA)
// ---------------------------------------------------------------------------

describe('storage: features with mixed stores', () => {
  it('email verification with sqlite sessions + memory auth', async () => {
    const app = await createTestApp(
      {
        db: {
          mongo: false,
          redis: false,
          sqlite: ':memory:',
          sessions: 'sqlite',
          cache: 'memory',
          auth: 'memory',
        },
      },
      {
        auth: {
          enabled: true,
          emailVerification: {
            required: false,
          },
        },
      },
    );
    expect(app).toBeTruthy();
    await smokeTestAuth(app);
  });

  it('password reset with sqlite sessions + memory auth', async () => {
    const app = await createTestApp(
      {
        db: {
          mongo: false,
          redis: false,
          sqlite: ':memory:',
          sessions: 'sqlite',
          cache: 'memory',
          auth: 'memory',
        },
      },
      {
        auth: {
          enabled: true,
          passwordReset: {},
        },
      },
    );
    expect(app).toBeTruthy();
  });

  it('MFA with all-sqlite stores', async () => {
    const app = await createTestApp(
      {
        db: {
          mongo: false,
          redis: false,
          sqlite: ':memory:',
          sessions: 'sqlite',
          cache: 'sqlite',
          auth: 'sqlite',
        },
      },
      {
        auth: {
          enabled: true,
          mfa: {
            issuer: 'TestApp',
          },
        },
      },
    );
    expect(app).toBeTruthy();
  });

  it('MFA with memory sessions + sqlite auth', async () => {
    const app = await createTestApp(
      {
        db: {
          mongo: false,
          redis: false,
          sqlite: ':memory:',
          sessions: 'memory',
          cache: 'memory',
          auth: 'sqlite',
        },
      },
      {
        auth: {
          enabled: true,
          mfa: {
            issuer: 'TestApp',
          },
        },
      },
    );
    expect(app).toBeTruthy();
  });

  it('refresh tokens with sqlite sessions + memory auth', async () => {
    const app = await createTestApp(
      {
        db: {
          mongo: false,
          redis: false,
          sqlite: ':memory:',
          sessions: 'sqlite',
          cache: 'memory',
          auth: 'memory',
        },
      },
      {
        auth: {
          enabled: true,
          refreshTokens: {
            accessTokenExpiry: 900,
            refreshTokenExpiry: 86400,
          },
        },
      },
    );
    expect(app).toBeTruthy();
    await smokeTestAuth(app);
  });

  it('refresh tokens with all-memory stores', async () => {
    const app = await createTestApp(
      {
        db: { mongo: false, redis: false, sessions: 'memory', cache: 'memory', auth: 'memory' },
      },
      {
        auth: {
          enabled: true,
          refreshTokens: {
            accessTokenExpiry: 900,
            refreshTokenExpiry: 86400,
          },
        },
      },
    );
    expect(app).toBeTruthy();
    await smokeTestAuth(app);
  });
});

// ---------------------------------------------------------------------------
// Auth disabled with various stores (no adapter needed)
// ---------------------------------------------------------------------------

describe('storage: auth disabled with different stores', () => {
  it('sqlite cache + auth disabled', async () => {
    const app = await createTestApp(
      {
        db: { mongo: false, redis: false, sqlite: ':memory:', cache: 'sqlite' },
      },
      {
        auth: { enabled: false },
      },
    );
    expect(app).toBeTruthy();
    const res = await app.request('/health');
    expect(res.status).toBe(200);
  });

  it('all memory + auth disabled', async () => {
    const app = await createTestApp(
      {
        db: { mongo: false, redis: false },
      },
      {
        auth: { enabled: false },
      },
    );
    expect(app).toBeTruthy();
    const res = await app.request('/health');
    expect(res.status).toBe(200);
  });
});
