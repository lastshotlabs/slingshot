import { createMemoryAuthAdapter } from '@auth/adapters/memoryAuth';
import { DEFAULT_AUTH_CONFIG } from '@auth/config/authConfig';
import type { AuthResolvedConfig } from '@auth/config/authConfig';
import {
  createAuthRateLimitService,
  createMemoryAuthRateLimitRepository,
} from '@auth/lib/authRateLimit';
import { createMemorySessionRepository } from '@auth/lib/session';
import { setSuspended } from '@auth/lib/suspension';
import { login, register } from '@auth/services/auth';
import { makeDummyHashGetter } from '@auth/services/auth';
import { beforeEach, describe, expect, test } from 'bun:test';

let memoryAuthAdapter: ReturnType<typeof createMemoryAuthAdapter>;

let config: AuthResolvedConfig;

const testRuntime = () =>
  ({
    adapter: memoryAuthAdapter,
    config,
    stores: {
      sessions: 'memory' as const,
      oauthState: 'memory' as const,
      authStore: 'memory' as const,
    },
    password: Bun.password,
    getDummyHash: makeDummyHashGetter(Bun.password),
    signing: { secret: 'test-secret-key-must-be-at-least-32-chars!!' },
    dataEncryptionKeys: [],
    oauth: {
      providers: {},
      stateStore: {
        store: async () => {},
        consume: async () => null,
      },
    },
    eventBus: {
      emit: () => {},
      on: () => {},
      off: () => {},
    },
    events: {
      definitions: {
        register: () => {},
        get: () => undefined,
        has: () => false,
        list: () => [],
        freeze: () => {},
        frozen: false,
      },
      register: () => {},
      get: () => undefined,
      list: () => [],
      publish: () => ({
        key: 'auth:login',
        payload: null,
        meta: {
          eventId: 'test-event-id',
          occurredAt: new Date(0).toISOString(),
          ownerPlugin: 'slingshot-auth-test',
          exposure: ['internal'] as const,
          scope: null,
        },
      }),
    },
    lockout: null,
    rateLimit: createAuthRateLimitService(createMemoryAuthRateLimitRepository()),
    credentialStuffing: null,
    securityGate: {
      preAuthCheck: async () => ({ allowed: true }),
      lockoutCheck: async () => ({ allowed: true }),
      recordLoginFailure: async () => ({ stuffingNowBlocked: false }),
      recordLoginSuccess: async () => {},
    },
    queueFactory: null,
    repos: {
      session: createMemorySessionRepository(),
      oauthCode: { store: async () => {}, consume: async () => null } as any,
      oauthReauth: { store: async () => {}, consume: async () => null } as any,
      magicLink: { store: async () => {}, consume: async () => null } as any,
      deletionCancelToken: { store: async () => {}, consume: async () => null } as any,
      mfaChallenge: { store: async () => {}, consume: async () => null } as any,
      verificationToken: { store: async () => {}, consume: async () => null } as any,
      resetToken: { store: async () => {}, consume: async () => null } as any,
      samlRequestId: null,
    },
  }) as any;

beforeEach(() => {
  memoryAuthAdapter = createMemoryAuthAdapter();
  config = { ...DEFAULT_AUTH_CONFIG };
});

describe('suspension — login enforcement', () => {
  test('suspended user cannot login', async () => {
    await register('test@example.com', 'Password1!', testRuntime());
    const user = await memoryAuthAdapter.findByEmail('test@example.com');
    await setSuspended(memoryAuthAdapter, user!.id, true, 'Policy violation');

    await expect(login('test@example.com', 'Password1!', testRuntime())).rejects.toMatchObject({
      status: 403,
      code: 'ACCOUNT_SUSPENDED',
    });
  });

  test('unsuspended user can login again', async () => {
    await register('test@example.com', 'Password1!', testRuntime());
    const user = await memoryAuthAdapter.findByEmail('test@example.com');
    await setSuspended(memoryAuthAdapter, user!.id, true);
    await setSuspended(memoryAuthAdapter, user!.id, false);

    const result = await login('test@example.com', 'Password1!', testRuntime());
    expect(result.token).toBeTruthy();
  });

  test('non-suspended user login succeeds', async () => {
    await register('test@example.com', 'Password1!', testRuntime());
    const result = await login('test@example.com', 'Password1!', testRuntime());
    expect(result.token).toBeTruthy();
  });
});

describe('suspension — getSuspended / setSuspended helpers', () => {
  test('default suspension status is false', async () => {
    const { id } = await memoryAuthAdapter.create('x@example.com', 'hash');
    const status = await (await import('@auth/lib/suspension')).getSuspended(memoryAuthAdapter, id);
    expect(status.suspended).toBe(false);
  });

  test('setSuspended with reason', async () => {
    const { id } = await memoryAuthAdapter.create('x@example.com', 'hash');
    await setSuspended(memoryAuthAdapter, id, true, 'Fraud detected');
    const status = await (await import('@auth/lib/suspension')).getSuspended(memoryAuthAdapter, id);
    expect(status.suspended).toBe(true);
    expect(status.suspendedReason).toBe('Fraud detected');
  });
});
