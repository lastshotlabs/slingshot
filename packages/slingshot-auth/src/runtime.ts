import type {
  AuthAdapter,
  DataEncryptionKey,
  ResolvedStores,
  RuntimePassword,
  SigningConfig,
  SlingshotContext,
  SlingshotEventBus,
} from '@lastshotlabs/slingshot-core';
import type { AuthResolvedConfig } from './config/authConfig';
import type { AuthQueueFactory } from './infra/queue';
import type { LockoutService } from './lib/accountLockout';
import type { AuthRateLimitService } from './lib/authRateLimit';
import type { CredentialStuffingService } from './lib/credentialStuffing';
import type { DeletionCancelTokenRepository } from './lib/deletionCancelToken';
import type { VerificationTokenRepository } from './lib/emailVerification';
import type { MagicLinkRepository } from './lib/magicLink';
import type { MfaChallengeRepository } from './lib/mfaChallenge';
import type { OAuthProviders, OAuthStateStore } from './lib/oauth';
import type { OAuthCodeRepository } from './lib/oauthCode';
import type { OAuthReauthRepository } from './lib/oauthReauth';
import type { ResetTokenRepository } from './lib/resetPassword';
import type { SamlRequestIdRepository } from './lib/samlRequestId';
import type { SecurityGate } from './lib/securityGate';
import type { SessionRepository } from './lib/session';

/**
 * Per-app auth runtime state, created by `bootstrapAuth` and stored in
 * `SlingshotContext.pluginState` under the `AUTH_RUNTIME_KEY` symbol.
 *
 * Access it via `getAuthRuntimeContext(ctx)` from a `SlingshotContext`, or
 * `getAuthRuntimeFromRequest(c)` from a Hono request context inside an auth route.
 *
 * All properties are `readonly`. The `config` object is deep-frozen. The `repos` map
 * contains the resolved storage adapters for all auth sub-systems.
 *
 * @remarks
 * This interface is intentionally wide — it is the single source of truth for all
 * auth runtime state. Plugin-layer code should prefer this over storing state in
 * module-level variables. Every `createAuthPlugin()` call produces an independent
 * `AuthRuntimeContext` instance (Rule 3 — no cross-app state pollution).
 */
export interface AuthRuntimeContext {
  readonly adapter: AuthAdapter;
  readonly eventBus: SlingshotEventBus;
  readonly config: AuthResolvedConfig;
  readonly stores: Readonly<ResolvedStores>;
  readonly password: RuntimePassword;
  /**
   * Returns the dummy hash used for timing-safe non-existent-user login.
   * The hash is lazily computed and cached within the closure of this instance —
   * no module-level state (Rule 3). Created by bootstrapAuth per factory call.
   */
  readonly getDummyHash: () => Promise<string>;
  readonly signing: SigningConfig | null;
  readonly dataEncryptionKeys: readonly DataEncryptionKey[];
  readonly oauth: {
    readonly providers: OAuthProviders;
    readonly stateStore: OAuthStateStore;
  };
  readonly lockout: LockoutService | null;
  readonly rateLimit: AuthRateLimitService;
  readonly credentialStuffing: CredentialStuffingService | null;
  readonly securityGate: SecurityGate;
  readonly queueFactory: AuthQueueFactory | null;
  readonly repos: {
    readonly oauthCode: OAuthCodeRepository;
    readonly oauthReauth: OAuthReauthRepository;
    readonly magicLink: MagicLinkRepository;
    readonly deletionCancelToken: DeletionCancelTokenRepository;
    readonly mfaChallenge: MfaChallengeRepository;
    readonly samlRequestId: SamlRequestIdRepository | null;
    readonly verificationToken: VerificationTokenRepository;
    readonly resetToken: ResetTokenRepository;
    readonly session: SessionRepository;
  };
}

/**
 * Key used to store and retrieve the `AuthRuntimeContext` from `SlingshotContext.pluginState`
 * and from Hono request context.
 *
 * @remarks
 * This constant is exported from `@lastshotlabs/slingshot-auth/testing` for use in test
 * harnesses that need to inject a mock runtime context into Hono's request context
 * without going through the full plugin bootstrap.
 *
 * @example
 * // Inject a test runtime into Hono context
 * import { AUTH_RUNTIME_KEY } from '@lastshotlabs/slingshot-auth/testing';
 * app.use('*', async (c, next) => {
 *   c.set(AUTH_RUNTIME_KEY, testRuntime);
 *   await next();
 * });
 */
export const AUTH_RUNTIME_KEY = 'slingshot-auth';

/**
 * Retrieves the `AuthRuntimeContext` from a `SlingshotContext`.
 *
 * Use this inside framework-level code that has access to the `SlingshotContext` directly
 * (e.g., `setupPost` hooks, admin providers, or server-side utilities).
 *
 * @param ctx - The `SlingshotContext` instance, typically obtained via `getContext(app)`.
 * @returns The `AuthRuntimeContext` for the app.
 *
 * @throws {Error} When the auth plugin has not been initialised on this context.
 *
 * @example
 * import { getContext } from '@lastshotlabs/slingshot-core';
 * import { getAuthRuntimeContext } from '@lastshotlabs/slingshot-auth';
 *
 * const ctx = getContext(app);
 * const runtime = getAuthRuntimeContext(ctx);
 * const adapter = runtime.adapter;
 */
export function getAuthRuntimeContext(
  ctx: SlingshotContext | null | undefined,
): AuthRuntimeContext {
  const runtime = ctx?.pluginState.get(AUTH_RUNTIME_KEY) as AuthRuntimeContext | undefined;
  if (!runtime?.adapter) {
    throw new Error('[slingshot-auth] auth runtime context is not available on SlingshotContext');
  }
  return runtime;
}

/**
 * Retrieves the `AuthRuntimeContext` from a Hono request context.
 *
 * Use this inside Hono route handlers and middleware where `SlingshotContext` is
 * available via `c.get('slingshotCtx')`. This is the standard accessor for auth
 * services inside route files.
 *
 * @param c - A Hono context object (or any object with a `get(key)` method).
 * @returns The `AuthRuntimeContext` for the current request.
 *
 * @throws {Error} When the auth plugin has not been initialised or the context is missing.
 *
 * @example
 * import { getAuthRuntimeFromRequest } from '@lastshotlabs/slingshot-auth';
 *
 * app.get('/profile', userAuth, async (c) => {
 *   const runtime = getAuthRuntimeFromRequest(c);
 *   const userId = c.get('authUserId')!;
 *   const user = await runtime.adapter.getUser?.(userId);
 *   return c.json(user);
 * });
 */
export function getAuthRuntimeFromRequest(c: { get(key: string): unknown }): AuthRuntimeContext {
  return getAuthRuntimeContext(c.get('slingshotCtx') as SlingshotContext | undefined);
}
