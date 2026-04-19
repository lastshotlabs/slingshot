import { describe, expect, it } from 'bun:test';
import { createTestApp } from '../setup';

describe('createApp config validation', () => {
  it('throws when emailVerification is set with non-email primaryField', async () => {
    await expect(
      createTestApp(
        {},
        {
          auth: {
            enabled: true,
            primaryField: 'username',
            emailVerification: {
              required: true,
            },
          },
        },
      ),
    ).rejects.toThrow('emailVerification');
  });

  it('throws when passwordReset is set with non-email primaryField', async () => {
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
    ).rejects.toThrow('passwordReset');
  });

  it('throws when defaultRole is set but adapter lacks setRoles', async () => {
    await expect(
      createTestApp(
        {},
        {
          auth: {
            enabled: true,
            roles: ['admin'],
            defaultRole: 'admin',
            adapter: {
              async findByEmail() {
                return null;
              },
              async create() {
                return { id: '1' };
              },
              // No setRoles!
            } as any,
          },
        },
      ),
    ).rejects.toThrow('setRoles');
  });

  it('uses memory store when mongo and redis are disabled', async () => {
    const app = await createTestApp({
      db: {
        mongo: false,
        redis: false,
      },
    });
    expect(app).toBeTruthy();
  });

  it('uses sqlite store when sqlite is configured', async () => {
    const app = await createTestApp({
      db: {
        mongo: false,
        redis: false,
        sqlite: ':memory:',
      },
    });
    expect(app).toBeTruthy();
  });

  it('configures rate limit store from explicit config', async () => {
    const app = await createTestApp({
      security: {
        rateLimit: { windowMs: 60_000, max: 1000, store: 'memory' },
      },
    });
    expect(app).toBeTruthy();
  });

  it('configures session policy options', async () => {
    const app = await createTestApp(
      {},
      {
        auth: {
          enabled: true,
          sessionPolicy: {
            maxSessions: 3,
            persistSessionMetadata: true,
            includeInactiveSessions: true,
            trackLastActive: true,
          },
        },
      },
    );
    expect(app).toBeTruthy();
  });

  it('configures password policy', async () => {
    const app = await createTestApp(
      {},
      {
        auth: {
          enabled: true,
          passwordPolicy: {
            minLength: 12,
            requireLetter: true,
            requireDigit: true,
            requireSpecial: true,
          },
        },
      },
    );
    expect(app).toBeTruthy();

    // Test that the policy is enforced
    const res = await app.request(
      new Request('http://localhost/auth/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'weak@example.com', password: 'short' }),
      }),
    );
    expect(res.status).toBe(400);
  });

  it('configures security headers', async () => {
    const app = await createTestApp({
      security: {
        rateLimit: { windowMs: 60_000, max: 1000 },
        headers: {
          contentSecurityPolicy: "default-src 'self'",
          permissionsPolicy: 'camera=()',
        },
      },
    });

    const res = await app.request(new Request('http://localhost/health'));
    expect(res.headers.get('content-security-policy')).toBe("default-src 'self'");
    expect(res.headers.get('permissions-policy')).toBe('camera=()');
  });

  it('starts with oauth postRedirect configured (allowedRedirectUrls validation moved to runtime)', async () => {
    // allowedRedirectUrls is no longer validated at startup — the plugin resolves without error
    const app = await createTestApp(
      {},
      {
        auth: {
          enabled: true,
          oauth: {
            providers: {
              google: {
                clientId: 'id',
                clientSecret: 'secret',
                redirectUri: 'http://localhost/callback',
              },
            },
            postRedirect: 'https://evil.com/steal',
            allowedRedirectUrls: ['https://myapp.com'],
          },
        },
      },
    );
    expect(app).toBeTruthy();
  });

  it('allows relative postRedirect path with allowlist', async () => {
    const app = await createTestApp(
      {},
      {
        auth: {
          enabled: true,
          oauth: {
            providers: {
              google: {
                clientId: 'id',
                clientSecret: 'secret',
                redirectUri: 'http://localhost/callback',
              },
            },
            postRedirect: '/dashboard',
            allowedRedirectUrls: ['https://myapp.com'],
          },
        },
      },
    );
    expect(app).toBeTruthy();
  });

  it('configures refresh tokens', async () => {
    const app = await createTestApp(
      {},
      {
        auth: {
          enabled: true,
          refreshTokens: {
            accessTokenExpiry: 900,
            refreshTokenExpiry: 86400,
            rotationGraceSeconds: 30,
          },
        },
      },
    );
    expect(app).toBeTruthy();
  });

  it('configures MFA with email OTP', async () => {
    const app = await createTestApp(
      {},
      {
        auth: {
          enabled: true,
          mfa: {
            issuer: 'TestApp',
            emailOtp: {},
          },
        },
      },
    );
    expect(app).toBeTruthy();
  });

  it('configures account deletion', async () => {
    const app = await createTestApp(
      {},
      {
        auth: {
          enabled: true,
          accountDeletion: {
            enabled: true,
            requirePasswordConfirmation: true,
          },
        },
      },
    );
    expect(app).toBeTruthy();
  });
});
