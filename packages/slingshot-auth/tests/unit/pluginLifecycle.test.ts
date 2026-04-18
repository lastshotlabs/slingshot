import { expect, test } from 'bun:test';
import { createAuthPlugin, createMemoryAuthAdapter } from '../../src';

test('teardown returns when setupMiddleware never ran', async () => {
  const plugin = createAuthPlugin({
    auth: {
      adapter: createMemoryAuthAdapter(),
      roles: ['admin', 'user'],
      defaultRole: 'user',
      jwt: {
        issuer: 'http://localhost',
        audience: 'slingshot-tests',
      },
      rateLimit: {
        register: { windowMs: 60_000, max: 1000 },
        login: { windowMs: 60_000, max: 1000 },
        forgotPassword: { windowMs: 60_000, max: 1000 },
        resetPassword: { windowMs: 60_000, max: 1000 },
        verifyEmail: { windowMs: 60_000, max: 1000 },
        resendVerification: { windowMs: 60_000, max: 1000 },
        mfaVerify: { windowMs: 60_000, max: 1000 },
        mfaEmailOtpInitiate: { windowMs: 60_000, max: 1000 },
        mfaResend: { windowMs: 60_000, max: 1000 },
        setPassword: { windowMs: 60_000, max: 1000 },
        mfaDisable: { windowMs: 60_000, max: 1000 },
        oauthUnlink: { windowMs: 60_000, max: 1000 },
        deleteAccount: { windowMs: 60_000, max: 1000 },
      },
    },
    db: {
      sessions: 'memory',
      oauthState: 'memory',
    },
    security: {
      bearerAuth: false,
    },
  });

  await expect(plugin.teardown?.()).resolves.toBeUndefined();
});
