// Shared test helpers for building a minimal AuthRuntimeContext and injecting
// it into a Hono app under test.
import { Hono } from 'hono';
import type {
  AppEnv,
  EventPublishContext,
  ResolvedStores,
  SlingshotContext,
  SlingshotEventBus,
  SlingshotEventMap,
  SlingshotEvents,
} from '@lastshotlabs/slingshot-core';
import { createMemoryAuthAdapter } from '../../src/adapters/memoryAuth';
import { createAuthResolvedConfig } from '../../src/config/authConfig';
import type { AuthResolvedConfig } from '../../src/config/authConfig';
import {
  createAuthRateLimitService,
  createMemoryAuthRateLimitRepository,
} from '../../src/lib/authRateLimit';
import { createMemoryDeletionCancelTokenRepository } from '../../src/lib/deletionCancelToken';
import { createMemoryVerificationTokenRepository } from '../../src/lib/emailVerification';
import { createAuthLogger } from '../../src/lib/logger';
import { createMemoryMagicLinkRepository } from '../../src/lib/magicLink';
import { createMemoryMfaChallengeRepository } from '../../src/lib/mfaChallenge';
import type { OAuthProviders } from '../../src/lib/oauth';
import { createMemoryOAuthStateStore } from '../../src/lib/oauth';
import { createMemoryOAuthCodeRepository } from '../../src/lib/oauthCode';
import { createMemoryOAuthReauthRepository } from '../../src/lib/oauthReauth';
import { createMemoryResetTokenRepository } from '../../src/lib/resetPassword';
import { createSecurityGate } from '../../src/lib/securityGate';
import { createMemorySessionRepository } from '../../src/lib/session';
import { AUTH_RUNTIME_KEY } from '../../src/runtime';
import type { AuthRuntimeContext } from '../../src/runtime';
import { makeDummyHashGetter } from '../../src/services/auth';

// ---------------------------------------------------------------------------
// Mutable variant of AuthRuntimeContext for use in tests.
//
// AuthRuntimeContext has all-readonly fields. Tests that inject services
// (credentialStuffing, lockout, eventBus) after construction need to assign
// to those fields directly. Stripping readonly here is safe because:
//   - The runtime object is never shared across test runs (makeTestRuntime
//     returns a fresh instance per call)
//   - Mutable<AuthRuntimeContext> is structurally assignable to
//     AuthRuntimeContext everywhere framework code expects it
// ---------------------------------------------------------------------------
export type MutableTestRuntime = {
  -readonly [K in keyof AuthRuntimeContext]: AuthRuntimeContext[K];
};

// ---------------------------------------------------------------------------
// Minimal no-op event bus
// ---------------------------------------------------------------------------

// The stub intentionally omits type-safe generic overloads — this is an
// opaque test-boundary mock, not a real implementation.
export function makeEventBus(onEmit?: (event: string) => void): SlingshotEventBus {
  return {
    emit: (event: string) => {
      onEmit?.(event);
    },
    on: () => {},
    onEnvelope: () => {},
    off: () => {},
    offEnvelope: () => {},
    shutdown: async () => {},
  } as unknown as SlingshotEventBus;
}

export function makeEvents(getBus: () => SlingshotEventBus): SlingshotEvents {
  return {
    definitions: {
      register() {},
      get() {
        return undefined;
      },
      has() {
        return false;
      },
      list() {
        return [];
      },
      freeze() {},
      frozen: false,
    },
    register() {},
    get() {
      return undefined;
    },
    list() {
      return [];
    },
    publish<K extends keyof SlingshotEventMap>(
      key: K,
      payload: SlingshotEventMap[K],
      ctx: EventPublishContext,
    ) {
      getBus().emit(key, payload);
      return {
        key,
        payload,
        meta: {
          eventId: 'test-event-id',
          occurredAt: new Date(0).toISOString(),
          ownerPlugin: 'slingshot-auth-test',
          exposure: ['internal'] as const,
          scope: null,
          requestTenantId: ctx.requestTenantId,
        },
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Runtime factory
// ---------------------------------------------------------------------------

export function makeTestRuntime(
  configOverrides: Partial<AuthResolvedConfig> = {},
): MutableTestRuntime {
  const adapter = createMemoryAuthAdapter();
  const rateLimitRepo = createMemoryAuthRateLimitRepository();
  const rateLimitService = createAuthRateLimitService(rateLimitRepo);
  const passwordRuntime = Bun.password;
  const oauthProviders: OAuthProviders = {};

  // Build the base object first (without securityGate) so that the gate's
  // lazy getters can close over the same object reference that tests mutate.
  // Since MutableTestRuntime has no readonly constraints, tests can assign
  // credentialStuffing/lockout/eventBus directly and the gate will see them.
  const base: Omit<MutableTestRuntime, 'securityGate'> = {
    adapter,
    config: createAuthResolvedConfig(configOverrides),
    evaluateUserAccess: async () => undefined,
    eventBus: makeEventBus(),
    events: undefined as unknown as SlingshotEvents,
    password: passwordRuntime,
    getDummyHash: makeDummyHashGetter(passwordRuntime),
    signing: { secret: 'test-signing-secret-32-chars-ok!' },
    dataEncryptionKeys: [],
    oauth: { providers: oauthProviders, stateStore: createMemoryOAuthStateStore() },
    lockout: null,
    rateLimit: rateLimitService,
    credentialStuffing: null as AuthRuntimeContext['credentialStuffing'],
    logger: createAuthLogger({ verbose: false, authTrace: false }),
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

  // Object.assign mutates base in-place and returns it — same object reference.
  // The securityGate closures read from base.credentialStuffing/lockout, which
  // is the same slot tests mutate via runtime.credentialStuffing = ... .
  return Object.assign(base, {
    events: makeEvents(() => base.eventBus),
    securityGate: createSecurityGate(
      rateLimitService,
      () => base.credentialStuffing,
      () => base.lockout,
      { windowMs: 15 * 60 * 1000, max: 10 },
    ),
  }) as MutableTestRuntime;
}

// ---------------------------------------------------------------------------
// Runtime injection middleware
// ---------------------------------------------------------------------------

/**
 * Returns a Hono app that installs `runtime` into every request context
 * so that `getAuthRuntimeFromRequest` works inside route handlers.
 * Mount your router under this app with `app.route('/', router)`.
 */
export function wrapWithRuntime(runtime: AuthRuntimeContext): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  app.use('*', async (c, next) => {
    const ctxPartial = {
      signing: runtime.signing,
      pluginState: new Map([[AUTH_RUNTIME_KEY, runtime]]),
    };
    c.set('slingshotCtx', ctxPartial as SlingshotContext);
    await next();
  });
  return app;
}
