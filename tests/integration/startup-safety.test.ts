import { afterEach, describe, expect, it } from 'bun:test';
import { createTestApp } from '../setup';

// ---------------------------------------------------------------------------
// These tests verify that bad configuration combinations throw at startup
// (createApp() rejects) rather than silently misconfiguring the server.
// ---------------------------------------------------------------------------

const baseRoutes = import.meta.dir + '/../fixtures/routes';
const createdApps: Array<{ destroy(): Promise<void> }> = [];

afterEach(async () => {
  for (const ctx of createdApps.splice(0)) {
    await ctx.destroy().catch(() => {});
  }
});

function trackApp<T>(app: T): T {
  createdApps.push((app as T & { ctx: { destroy(): Promise<void> } }).ctx);
  return app;
}

// ---------------------------------------------------------------------------
// emailVerification + non-email primaryField
// ---------------------------------------------------------------------------

describe('startup safety — emailVerification', () => {
  it("throws when emailVerification is set and primaryField is 'username'", async () => {
    await expect(
      createTestApp(
        {},
        {
          auth: {
            enabled: true,
            primaryField: 'username',
            emailVerification: { required: false },
          },
        },
      ),
    ).rejects.toThrow(/emailVerification.*primaryField.*email/i);
  });

  it("throws when emailVerification is set and primaryField is 'phone'", async () => {
    await expect(
      createTestApp(
        {},
        {
          auth: {
            enabled: true,
            primaryField: 'phone',
            emailVerification: { required: false },
          },
        },
      ),
    ).rejects.toThrow(/emailVerification.*primaryField.*email/i);
  });
});

// ---------------------------------------------------------------------------
// passwordReset + non-email primaryField
// ---------------------------------------------------------------------------

describe('startup safety — passwordReset', () => {
  it("throws when passwordReset is set and primaryField is 'username'", async () => {
    await expect(
      createTestApp(
        {},
        {
          auth: {
            enabled: true,
            primaryField: 'username',
            passwordReset: {},
          },
        },
      ),
    ).rejects.toThrow(/passwordReset.*primaryField.*email/i);
  });

  it("throws when passwordReset is set and primaryField is 'phone'", async () => {
    await expect(
      createTestApp(
        {},
        {
          auth: {
            enabled: true,
            primaryField: 'phone',
            passwordReset: {},
          },
        },
      ),
    ).rejects.toThrow(/passwordReset.*primaryField.*email/i);
  });
});

// ---------------------------------------------------------------------------
// defaultRole + adapter missing setRoles
// ---------------------------------------------------------------------------

describe('startup safety — defaultRole', () => {
  it('throws when defaultRole is set on an adapter that does not implement setRoles', async () => {
    // Use an explicit custom adapter with no setRoles method
    const bareAdapter = {
      findByEmail: async () => null,
      findById: async () => null,
      createUser: async () => ({ id: '1', passwordHash: '' }),
      verifyPassword: async () => false,
      // setRoles intentionally absent
    };

    await expect(
      createTestApp(
        {},
        {
          auth: {
            enabled: true,
            adapter: bareAdapter as any,
            defaultRole: 'user',
          },
        },
      ),
    ).rejects.toThrow(/defaultRole.*setRoles/i);
  });
});

// ---------------------------------------------------------------------------
// OAuth postRedirect not in allowedRedirectUrls
// ---------------------------------------------------------------------------

describe('startup safety — OAuth allowedRedirectUrls', () => {
  // NOTE: postRedirect/allowedRedirectUrls validation moved to the auth plugin.
  // The bootstrap validates these at setup time via the plugin system.
  // The plugin resolves successfully regardless of oauth config at app startup.

  it('does not throw when postRedirect is in allowedRedirectUrls', async () => {
    const app = trackApp(
      await createTestApp(
        {},
        {
          auth: {
            enabled: true,
            oauth: {
              postRedirect: 'https://app.example.com/dashboard',
              allowedRedirectUrls: ['https://app.example.com'],
            },
          },
        },
      ),
    );
    expect(app).toBeDefined();
  });

  it('does not throw for relative postRedirect (always allowed)', async () => {
    const app = trackApp(
      await createTestApp(
        {},
        {
          auth: {
            enabled: true,
            oauth: {
              postRedirect: '/dashboard',
              allowedRedirectUrls: ['https://somewhere-else.com'],
            },
          },
        },
      ),
    );
    expect(app).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Tenancy in production — requires onResolve
// ---------------------------------------------------------------------------

describe('startup safety — tenancy in production', () => {
  it('throws in production when tenancy is configured without onResolve', async () => {
    const originalEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      await expect(createTestApp({ tenancy: { resolution: 'header' } })).rejects.toThrow(
        /onResolve/i,
      );
    } finally {
      process.env.NODE_ENV = originalEnv;
    }
  });

  it('does not throw in development when tenancy has no onResolve (warns only)', async () => {
    // NODE_ENV is "development" in tests (set by bunfig preload)
    const app = trackApp(await createTestApp({ tenancy: { resolution: 'header' } }));
    expect(app).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// CORS + CSRF safety
// ---------------------------------------------------------------------------

describe('startup safety — CORS + CSRF', () => {
  // NOTE: CSRF+wildcard CORS now logs a warning rather than throwing.
  // The framework warns about wildcard CORS in production but does not block startup.

  it('does not throw in production when csrf.enabled and cors is wildcard (warns only)', async () => {
    const orig = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      // Should warn but not throw
      const app = trackApp(
        await createTestApp({ security: { cors: '*' } }, { security: { csrf: { enabled: true } } }),
      );
      expect(app).toBeDefined();
    } finally {
      process.env.NODE_ENV = orig;
    }
  });

  it('does not throw in development when csrf.enabled and cors is wildcard', async () => {
    const orig = process.env.NODE_ENV;
    process.env.NODE_ENV = 'development';
    try {
      const app = trackApp(
        await createTestApp({ security: { cors: '*' } }, { security: { csrf: { enabled: true } } }),
      );
      expect(app).toBeDefined();
    } finally {
      process.env.NODE_ENV = orig;
    }
  });

  it('does not throw when csrf.enabled and cors is specific origin', async () => {
    const app = trackApp(
      await createTestApp(
        { security: { cors: ['https://example.com'] } },
        { security: { csrf: { enabled: true } } },
      ),
    );
    expect(app).toBeDefined();
  });
});

describe('startup safety — jobs endpoint', () => {
  it('throws in production when jobs.statusEndpoint and no auth', async () => {
    const orig = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      await expect(createTestApp({ jobs: { statusEndpoint: true, auth: 'none' } })).rejects.toThrow(
        '[security] jobs.auth is required in production',
      );
    } finally {
      process.env.NODE_ENV = orig;
    }
  });

  it('does not throw when jobs.statusEndpoint with auth: none and unsafePublic: true', async () => {
    const orig = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      const app = trackApp(
        await createTestApp({
          jobs: { statusEndpoint: true, auth: 'none', unsafePublic: true },
        }),
      );
      expect(app).toBeDefined();
    } finally {
      process.env.NODE_ENV = orig;
    }
  });
});

describe('startup safety — metrics endpoint', () => {
  it('throws in production when metrics.enabled and no auth', async () => {
    const orig = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      await expect(createTestApp({ metrics: { enabled: true, auth: 'none' } })).rejects.toThrow(
        '[security] metrics.auth is required in production',
      );
    } finally {
      process.env.NODE_ENV = orig;
    }
  });

  it('does not throw when metrics.enabled with auth: none and unsafePublic: true', async () => {
    const orig = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      const app = trackApp(
        await createTestApp({
          metrics: { enabled: true, auth: 'none', unsafePublic: true },
        }),
      );
      expect(app).toBeDefined();
    } finally {
      process.env.NODE_ENV = orig;
    }
  });
});
