import { afterEach, describe, expect, test } from 'bun:test';
import { bootstrapAuth } from '../../src/bootstrap';
import type { AuthPluginConfig } from '../../src/types/config';
import { makeEventBus, makeEvents } from '../helpers/runtime';

const originalNodeEnv = process.env.NODE_ENV;

afterEach(() => {
  if (originalNodeEnv === undefined) {
    delete process.env.NODE_ENV;
  } else {
    process.env.NODE_ENV = originalNodeEnv;
  }
});

function runtimeInfra() {
  return {
    signing: { secret: 'test-signing-secret-32-chars-ok!' },
    dataEncryptionKeys: [],
    password: Bun.password,
  };
}

describe('bootstrapAuth standalone defaults', () => {
  test('uses memory auth store when no database is configured', async () => {
    const bus = makeEventBus();
    const result = await bootstrapAuth(
      {} as AuthPluginConfig,
      bus,
      makeEvents(() => bus),
      undefined,
      runtimeInfra(),
    );

    expect(result.stores.authStore).toBe('memory');
    expect(result.stores.sessions).toBe('memory');

    for (const teardown of result.teardownFns) {
      await teardown();
    }
  });
});

describe('bootstrapAuth OIDC production safety', () => {
  test('requires an explicit OIDC signing key in production', async () => {
    process.env.NODE_ENV = 'production';
    const bus = makeEventBus();

    await expect(
      bootstrapAuth(
        {
          auth: {
            oidc: {
              issuer: 'https://issuer.example.com',
            },
          },
        } as AuthPluginConfig,
        bus,
        makeEvents(() => bus),
        undefined,
        runtimeInfra(),
      ),
    ).rejects.toThrow('auth.oidc.signingKey is required in production');
  });
});

describe('bootstrapAuth cookie production safety', () => {
  test.each([
    ['auth', { cookieConfig: { secure: false } }],
    ['CSRF', { csrfCookieConfig: { secure: false } }],
  ] as const)('rejects secure:false for %s cookies in production', async (_name, auth) => {
    process.env.NODE_ENV = 'production';
    const bus = makeEventBus();

    await expect(
      bootstrapAuth(
        { auth } as AuthPluginConfig,
        bus,
        makeEvents(() => bus),
        undefined,
        runtimeInfra(),
      ),
    ).rejects.toThrow(/cookies cannot set secure:false in production/);
  });

  test.each([
    ['auth', { cookieConfig: { sameSite: 'None' as const, secure: false } }],
    ['CSRF', { csrfCookieConfig: { sameSite: 'None' as const, secure: false } }],
  ] as const)('rejects SameSite=None without Secure for %s cookies', async (_name, auth) => {
    process.env.NODE_ENV = 'test';
    const bus = makeEventBus();

    await expect(
      bootstrapAuth(
        { auth } as AuthPluginConfig,
        bus,
        makeEvents(() => bus),
        undefined,
        runtimeInfra(),
      ),
    ).rejects.toThrow(/cookies with SameSite=None must also set secure:true/);
  });
});
