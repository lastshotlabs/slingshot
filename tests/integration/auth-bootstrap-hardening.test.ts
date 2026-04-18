import { afterEach, describe, expect, test } from 'bun:test';
import { bootstrapAuth } from '../../packages/slingshot-auth/src/bootstrap';
import { makeEventBus } from '../../packages/slingshot-auth/tests/helpers/runtime';

const originalNodeEnv = process.env.NODE_ENV;

afterEach(() => {
  process.env.NODE_ENV = originalNodeEnv;
});

function bootstrapWithJwt(jwt: { issuer?: string; audience?: string | string[] }) {
  return bootstrapAuth(
    {
      db: {
        mongo: false,
        auth: 'memory',
        sessions: 'memory',
        oauthState: 'memory',
      },
      runtime: {
        password: Bun.password,
      },
      security: {
        trustProxy: false,
        signing: {
          secret: 'test-secret-key-must-be-at-least-32-chars!!',
        },
      },
      auth: {
        roles: ['user'],
        defaultRole: 'user',
        jwt,
      },
    },
    makeEventBus(),
    undefined,
    {
      signing: {
        secret: 'test-secret-key-must-be-at-least-32-chars!!',
      },
      dataEncryptionKeys: [],
      password: Bun.password,
    },
  );
}

describe('auth bootstrap hardening', () => {
  test('production boot fails when jwt.issuer is missing', async () => {
    process.env.NODE_ENV = 'production';

    await expect(
      bootstrapWithJwt({
        audience: 'slingshot-api',
      }),
    ).rejects.toThrow(/jwt\.issuer is required in production/i);
  });

  test('production boot fails when jwt.audience is missing', async () => {
    process.env.NODE_ENV = 'production';

    await expect(
      bootstrapWithJwt({
        issuer: 'https://auth.example.com',
      }),
    ).rejects.toThrow(/jwt\.audience is required in production/i);
  });

  test('production boot succeeds when jwt.issuer and jwt.audience are configured', async () => {
    process.env.NODE_ENV = 'production';

    await expect(
      bootstrapWithJwt({
        issuer: 'https://auth.example.com',
        audience: 'slingshot-api',
      }),
    ).resolves.toBeDefined();
  });

  test('production boot fails when trustProxy is not configured and auth is enabled', async () => {
    process.env.NODE_ENV = 'production';

    await expect(
      bootstrapAuth(
        {
          db: {
            mongo: false,
            auth: 'memory',
            sessions: 'memory',
            oauthState: 'memory',
          },
          runtime: {
            password: Bun.password,
          },
          security: {
            signing: {
              secret: 'test-secret-key-must-be-at-least-32-chars!!',
            },
          },
          auth: {
            roles: ['user'],
            defaultRole: 'user',
            jwt: {
              issuer: 'https://auth.example.com',
              audience: 'slingshot-api',
            },
          },
        },
        makeEventBus(),
        undefined,
        {
          signing: {
            secret: 'test-secret-key-must-be-at-least-32-chars!!',
          },
          dataEncryptionKeys: [],
          password: Bun.password,
        },
      ),
    ).rejects.toThrow(
      /security\.trustProxy must be explicitly configured in production when auth is enabled/i,
    );
  });
});
