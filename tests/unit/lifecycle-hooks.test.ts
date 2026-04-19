/**
 * Lifecycle hooks tests.
 *
 * These run at the unit level (no HTTP app needed for most cases).
 * We directly call the service layer and wire the memory adapter + session store,
 * same pattern used by tests like authAdapter.test.ts.
 */
import { createMemoryAuthAdapter } from '@auth/adapters/memoryAuth';
import { DEFAULT_AUTH_CONFIG, createAuthResolvedConfig } from '@auth/config/authConfig';
import type { AuthResolvedConfig, HookContext, PostLoginResult } from '@auth/config/authConfig';
import {
  createAuthRateLimitService,
  createMemoryAuthRateLimitRepository,
} from '@auth/lib/authRateLimit';
import { verifyToken } from '@auth/lib/jwt';
import { createMemorySessionRepository } from '@auth/lib/session';
import { deleteAccount, login, makeDummyHashGetter, register } from '@auth/services/auth';
import { beforeEach, describe, expect, test } from 'bun:test';
import type { SigningConfig } from '@lastshotlabs/slingshot-core';

let memoryAuthAdapter: ReturnType<typeof createMemoryAuthAdapter>;

const TEST_SIGNING: SigningConfig = { secret: 'test-secret-key-must-be-at-least-32-chars!!' };

let config: AuthResolvedConfig;

const TEST_HOOK_CTX: HookContext = {
  ip: '127.0.0.1',
  userAgent: 'test-agent/1.0',
  requestId: 'req-abc123',
};

const testRuntime = () =>
  ({
    adapter: memoryAuthAdapter,
    config,
    eventBus: {
      emit: () => {},
      on: () => {},
      off: () => {},
    },
    password: Bun.password,
    getDummyHash: makeDummyHashGetter(Bun.password),
    lockout: null,
    rateLimit: createAuthRateLimitService(createMemoryAuthRateLimitRepository()),
    credentialStuffing: null,
    securityGate: {
      preAuthCheck: async () => ({ allowed: true }),
      lockoutCheck: async () => ({ allowed: true }),
      recordLoginFailure: async () => ({ stuffingNowBlocked: false }),
      recordLoginSuccess: async () => {},
    },
    signing: { secret: 'test-secret-key-must-be-at-least-32-chars!!' },
    dataEncryptionKeys: [],
    stores: {
      sessions: 'memory' as const,
      oauthState: 'memory' as const,
      authStore: 'memory' as const,
    },
    oauth: { providers: {}, stateStore: { store: async () => {}, consume: async () => null } },
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

// ---------------------------------------------------------------------------
// preRegister
// ---------------------------------------------------------------------------

describe('preRegister hook', () => {
  test('receives correct { identifier } and allows registration', async () => {
    const calls: Array<{ identifier: string } & HookContext> = [];
    config = {
      ...config,
      hooks: {
        preRegister: async data => {
          calls.push(data);
        },
      },
    };

    const result = await register('pre@example.com', 'Password1!', testRuntime());
    expect(calls).toHaveLength(1);
    expect(calls[0].identifier).toBe('pre@example.com');
    expect(result.userId).toBeString();
  });

  test('receives HookContext fields when passed via RegisterOptions', async () => {
    const calls: Array<{ identifier: string } & HookContext> = [];
    config = {
      ...config,
      hooks: {
        preRegister: async data => {
          calls.push(data);
        },
      },
    };

    await register('pre-ctx@example.com', 'Password1!', testRuntime(), {
      hookContext: TEST_HOOK_CTX,
    });
    expect(calls[0].ip).toBe('127.0.0.1');
    expect(calls[0].userAgent).toBe('test-agent/1.0');
    expect(calls[0].requestId).toBe('req-abc123');
  });

  test('throwing aborts registration — user is not created', async () => {
    config = {
      ...config,
      hooks: {
        preRegister: async () => {
          throw new Error('blocked by preRegister');
        },
      },
    };

    await expect(register('blocked@example.com', 'Password1!', testRuntime())).rejects.toThrow(
      'blocked by preRegister',
    );

    // User should not have been created — re-registering with same identifier should succeed
    config = { ...config, hooks: {} };
    const result = await register('blocked@example.com', 'Password1!', testRuntime());
    expect(result.userId).toBeString();
  });
});

// ---------------------------------------------------------------------------
// postRegister
// ---------------------------------------------------------------------------

describe('postRegister hook', () => {
  test('receives { userId, identifier } after successful registration', async () => {
    const calls: Array<{ userId: string; identifier: string } & HookContext> = [];
    config = {
      ...config,
      hooks: {
        postRegister: async data => {
          calls.push(data);
        },
      },
    };

    const result = await register('post@example.com', 'Password1!', testRuntime());
    // postRegister is fire-and-forget — await a tick to let it flush
    await Bun.sleep(10);
    expect(calls).toHaveLength(1);
    expect(calls[0].userId).toBe(result.userId);
    expect(calls[0].identifier).toBe('post@example.com');
  });

  test('receives HookContext fields when passed via RegisterOptions', async () => {
    const calls: Array<{ userId: string; identifier: string } & HookContext> = [];
    config = {
      ...config,
      hooks: {
        postRegister: async data => {
          calls.push(data);
        },
      },
    };

    await register('post-ctx@example.com', 'Password1!', testRuntime(), {
      hookContext: TEST_HOOK_CTX,
    });
    await Bun.sleep(10);
    expect(calls[0].ip).toBe('127.0.0.1');
    expect(calls[0].userAgent).toBe('test-agent/1.0');
  });

  test('throwing is caught and logged — registration still succeeds', async () => {
    config = {
      ...config,
      hooks: {
        postRegister: async () => {
          throw new Error('post hook error — should be swallowed');
        },
      },
    };

    const result = await register('post-err@example.com', 'Password1!', testRuntime());
    await Bun.sleep(10);
    // Must have succeeded despite the hook error
    expect(result.userId).toBeString();
    expect(result.token).toBeString();
  });
});

// ---------------------------------------------------------------------------
// preLogin
// ---------------------------------------------------------------------------

describe('preLogin hook', () => {
  beforeEach(async () => {
    config = { ...DEFAULT_AUTH_CONFIG };
    await register('login@example.com', 'Password1!', testRuntime());
  });

  test('receives correct { identifier } and allows login', async () => {
    const calls: Array<{ identifier: string } & HookContext> = [];
    config = {
      ...config,
      hooks: {
        preLogin: async data => {
          calls.push(data);
        },
      },
    };

    const result = await login('login@example.com', 'Password1!', testRuntime());
    expect(calls).toHaveLength(1);
    expect(calls[0].identifier).toBe('login@example.com');
    expect(result.token).toBeString();
  });

  test('receives HookContext fields when passed', async () => {
    const calls: Array<{ identifier: string } & HookContext> = [];
    config = {
      ...config,
      hooks: {
        preLogin: async data => {
          calls.push(data);
        },
      },
    };

    await login('login@example.com', 'Password1!', testRuntime(), undefined, TEST_HOOK_CTX);
    expect(calls[0].ip).toBe('127.0.0.1');
    expect(calls[0].userAgent).toBe('test-agent/1.0');
    expect(calls[0].requestId).toBe('req-abc123');
  });

  test('throwing aborts login', async () => {
    config = {
      ...config,
      hooks: {
        preLogin: async () => {
          throw new Error('login blocked by hook');
        },
      },
    };

    await expect(login('login@example.com', 'Password1!', testRuntime())).rejects.toThrow(
      'login blocked by hook',
    );
  });
});

// ---------------------------------------------------------------------------
// postLogin
// ---------------------------------------------------------------------------

describe('postLogin hook', () => {
  beforeEach(async () => {
    config = { ...DEFAULT_AUTH_CONFIG };
    await register('post-login@example.com', 'Password1!', testRuntime());
  });

  test('receives { userId, sessionId } after successful login', async () => {
    const calls: Array<{ userId: string; sessionId: string } & HookContext> = [];
    config = {
      ...config,
      hooks: {
        postLogin: async data => {
          calls.push(data);
          return undefined;
        },
      },
    };

    const result = await login('post-login@example.com', 'Password1!', testRuntime());
    await Bun.sleep(10);
    expect(calls).toHaveLength(1);
    expect(calls[0].userId).toBe(result.userId);
    expect(typeof calls[0].sessionId).toBe('string');
    expect(calls[0].sessionId.length).toBeGreaterThan(0);
  });

  test('receives HookContext fields when passed', async () => {
    const calls: Array<{ userId: string; sessionId: string } & HookContext> = [];
    config = {
      ...config,
      hooks: {
        postLogin: async data => {
          calls.push(data);
          return undefined;
        },
      },
    };

    await login('post-login@example.com', 'Password1!', testRuntime(), undefined, TEST_HOOK_CTX);
    await Bun.sleep(10);
    expect(calls[0].ip).toBe('127.0.0.1');
    expect(calls[0].userAgent).toBe('test-agent/1.0');
    expect(calls[0].requestId).toBe('req-abc123');
  });

  test('returning { customClaims } injects extra claims into the JWT', async () => {
    config = {
      ...config,
      hooks: {
        postLogin: async (): Promise<PostLoginResult> => ({
          customClaims: { orgId: 'abc-123', tier: 'pro' },
        }),
      },
    };

    const result = await login('post-login@example.com', 'Password1!', testRuntime());
    // Decode the JWT and check for injected claims
    const payload = await verifyToken(result.token, config, TEST_SIGNING);
    expect((payload as any).orgId).toBe('abc-123');
    expect((payload as any).tier).toBe('pro');
  });

  test('returning void leaves JWT unchanged (backward compat)', async () => {
    config = {
      ...config,
      hooks: {
        postLogin: async (): Promise<PostLoginResult | undefined> => {
          // returns nothing
          return undefined;
        },
      },
    };

    const result = await login('post-login@example.com', 'Password1!', testRuntime());
    const payload = await verifyToken(result.token, config, TEST_SIGNING);
    expect(payload.sub).toBeString();
    expect(payload.sid).toBeString();
    // No extra claims injected
    expect((payload as any).orgId).toBeUndefined();
  });

  test('throwing is caught — login still returns token without extra claims', async () => {
    config = {
      ...config,
      hooks: {
        postLogin: async () => {
          throw new Error('post login error — should be swallowed');
        },
      },
    };

    const result = await login('post-login@example.com', 'Password1!', testRuntime());
    await Bun.sleep(10);
    expect(result.token).toBeString();
    // Token should still be valid even though hook threw
    const payload = await verifyToken(result.token, config, TEST_SIGNING);
    expect(payload.sub).toBeString();
  });

  test('postLogin fires on register path too (via createSessionWithRefreshToken)', async () => {
    config = { ...DEFAULT_AUTH_CONFIG };
    const calls: Array<{ userId: string; sessionId: string }> = [];
    config = {
      ...config,
      hooks: {
        postLogin: async data => {
          calls.push(data);
          return undefined;
        },
      },
    };

    const result = await register('new-hooks@example.com', 'Password1!', testRuntime());
    await Bun.sleep(10);
    expect(calls).toHaveLength(1);
    expect(calls[0].userId).toBe(result.userId);
  });
});

// ---------------------------------------------------------------------------
// prePasswordChange data shape (config-level verification)
// ---------------------------------------------------------------------------

describe('prePasswordChange hook config', () => {
  test('createAuthResolvedConfig includes hooks', () => {
    const hook = async (_data: { userId: string } & HookContext) => {};
    const built = createAuthResolvedConfig({ hooks: { prePasswordChange: hook } });
    expect(built.hooks.prePasswordChange).toBe(hook);
  });

  test('postPasswordChange is stored via createAuthResolvedConfig', () => {
    const post = async (_data: { userId: string } & HookContext) => {};
    const built = createAuthResolvedConfig({ hooks: { postPasswordChange: post } });
    expect(built.hooks.postPasswordChange).toBe(post);
  });

  test('setting hooks to {} clears all hooks', () => {
    config = { ...config, hooks: { preRegister: async () => {} } };
    config = { ...config, hooks: {} };
    expect(config.hooks.preRegister).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// preDeleteAccount / postDeleteAccount
// ---------------------------------------------------------------------------

describe('preDeleteAccount hook', () => {
  test('throwing aborts deleteAccount', async () => {
    config = { ...DEFAULT_AUTH_CONFIG };
    const { userId } = await register('del@example.com', 'Password1!', testRuntime());

    config = {
      ...config,
      hooks: {
        preDeleteAccount: async () => {
          throw new Error('deletion blocked');
        },
      },
    };

    // preDeleteAccount runs before the password/adapter check — no password needed
    await expect(deleteAccount(userId, testRuntime())).rejects.toThrow('deletion blocked');
  });
});

describe('postDeleteAccount hook', () => {
  test('receives { userId } and is fire-and-forget', async () => {
    config = { ...DEFAULT_AUTH_CONFIG };
    const { userId } = await register('del-post@example.com', 'Password1!', testRuntime());

    const calls: Array<{ userId: string } & HookContext> = [];
    config = {
      ...config,
      hooks: {
        postDeleteAccount: async data => {
          calls.push(data);
        },
      },
    };

    await deleteAccount(userId, testRuntime(), 'Password1!');
    await Bun.sleep(10);
    expect(calls).toHaveLength(1);
    expect(calls[0].userId).toBe(userId);
  });

  test('throwing is caught — deleteAccount still completes', async () => {
    config = { ...DEFAULT_AUTH_CONFIG };
    const { userId } = await register('del-err@example.com', 'Password1!', testRuntime());

    config = {
      ...config,
      hooks: {
        postDeleteAccount: async () => {
          throw new Error('post delete error');
        },
      },
    };

    // Should not throw
    await expect(deleteAccount(userId, testRuntime(), 'Password1!')).resolves.toBeUndefined();
    await Bun.sleep(10);
  });
});
