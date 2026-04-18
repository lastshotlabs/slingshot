import { Hono } from 'hono';
import { createAuthResolvedConfig, createMemoryAuthAdapter } from '@lastshotlabs/slingshot-auth';
import type { AuthResolvedConfig, AuthRuntimeContext } from '@lastshotlabs/slingshot-auth';
import {
  AUTH_RUNTIME_KEY,
  createAuthRateLimitService,
  createMemoryAuthRateLimitRepository,
  createMemoryDeletionCancelTokenRepository,
  createMemoryMagicLinkRepository,
  createMemoryMfaChallengeRepository,
  createMemoryOAuthCodeRepository,
  createMemoryOAuthReauthRepository,
  createMemoryOAuthStateStore,
  createMemoryResetTokenRepository,
  createMemorySessionRepository,
  createMemoryVerificationTokenRepository,
  makeDummyHashGetter,
} from '@lastshotlabs/slingshot-auth/testing';
import type {
  AppEnv,
  ResolvedStores,
  SlingshotContext,
  SlingshotEventBus,
} from '@lastshotlabs/slingshot-core';
import type { OAuthProviders } from '../../../slingshot-auth/src/lib/oauth';

// Removes readonly modifiers so test files can mutate runtime fields directly
// without unsafe `as any` casts.
export type MutableTestRuntime = {
  -readonly [K in keyof AuthRuntimeContext]: AuthRuntimeContext[K];
};

// The stub intentionally omits type-safe generic overloads — this is an
// opaque test-boundary mock, not a real implementation.
export function makeEventBus(onEmit?: (event: string) => void): SlingshotEventBus {
  return {
    emit: (event: string) => {
      onEmit?.(event);
    },
    on: () => {},
    off: () => {},
    shutdown: async () => {},
    clientSafeKeys: new Set<string>(),
    registerClientSafeEvents: () => {},
    ensureClientSafeEventKey: (key: string) => key,
  } as unknown as SlingshotEventBus;
}

export function makeTestRuntime(
  configOverrides: Partial<AuthResolvedConfig> = {},
  onEmit?: (event: string) => void,
): MutableTestRuntime {
  const adapter = createMemoryAuthAdapter();
  const rateLimitRepo = createMemoryAuthRateLimitRepository();
  const rateLimitService = createAuthRateLimitService(rateLimitRepo);
  const passwordRuntime = Bun.password;
  const oauthProviders: OAuthProviders = {};

  return {
    adapter,
    config: createAuthResolvedConfig(configOverrides),
    eventBus: makeEventBus(onEmit),
    password: passwordRuntime,
    getDummyHash: makeDummyHashGetter(passwordRuntime),
    signing: { secret: 'test-signing-secret-32-chars-ok!' },
    dataEncryptionKeys: [],
    oauth: { providers: oauthProviders, stateStore: createMemoryOAuthStateStore() },
    lockout: null,
    rateLimit: rateLimitService,
    credentialStuffing: null,
    securityGate: {
      preAuthCheck: async () => ({ allowed: true }),
      lockoutCheck: async () => ({ allowed: true }),
      recordLoginFailure: async () => ({ stuffingNowBlocked: false }),
      recordLoginSuccess: async () => {},
    },
    queueFactory: null,
    repos: {
      oauthCode: createMemoryOAuthCodeRepository(),
      oauthReauth: createMemoryOAuthReauthRepository(),
      magicLink: createMemoryMagicLinkRepository(),
      deletionCancelToken: createMemoryDeletionCancelTokenRepository(),
      mfaChallenge: createMemoryMfaChallengeRepository(),
      samlRequestId: null,
      verificationToken: createMemoryVerificationTokenRepository(),
      resetToken: createMemoryResetTokenRepository(),
      session: createMemorySessionRepository(),
    },
    stores: {
      sessions: 'memory',
      oauthState: 'memory',
      cache: 'memory',
      authStore: 'memory',
      sqlite: undefined,
    } satisfies ResolvedStores,
  };
}

export function wrapWithRuntime(runtime: AuthRuntimeContext): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  app.use('*', async (c, next) => {
    c.set('slingshotCtx', {
      signing: runtime.signing,
      pluginState: new Map([[AUTH_RUNTIME_KEY, runtime]]),
    } as SlingshotContext);
    await next();
  });
  return app;
}
