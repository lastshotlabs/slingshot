import type { ConnectionOptions } from 'bullmq';
import type { Context, MiddlewareHandler } from 'hono';
import type Redis from 'ioredis';
import type { Connection } from 'mongoose';
import type {
  PluginSeedContext,
  PluginSetupContext,
  StandalonePlugin,
} from '@lastshotlabs/slingshot-core';
import {
  ANONYMOUS_ACTOR,
  type Actor,
  COOKIE_TOKEN,
  HEADER_USER_TOKEN,
  HttpError,
  emitPackageStabilityWarning,
  getClientIpFromRequest,
  getContextOrNull,
  isPublicPath,
  publishPluginState,
  sha256,
  timingSafeEqual,
  validatePluginConfig,
} from '@lastshotlabs/slingshot-core';
import type { AppEnv } from '@lastshotlabs/slingshot-core';
import { bootstrapAuth } from './bootstrap';
import type { BootstrapResult } from './bootstrap';
import type { AuthResolvedConfig } from './config/authConfig';
import { registerAuthEventDefinitions } from './eventGovernance';
import { createAccountGuard } from './guards/accountGuard';
import { createMemoryCacheAdapter } from './lib/cache';
import { templates } from './lib/emailTemplates';
import { isProd } from './lib/env';
import { buildFingerprint } from './lib/fingerprint';
import { validateJwtSecrets, verifyToken } from './lib/jwt';
import { getSecureCookieName } from './lib/cookieOptions';
import { getSuspended } from './lib/suspension';
import { createBearerAuth } from './middleware/bearerAuth';
import { csrfProtection } from './middleware/csrf';
import { createIdentifyMiddleware } from './middleware/identify';
import { requireMfaSetup } from './middleware/requireMfaSetup';
import { requireRole } from './middleware/requireRole';
import { userAuth } from './middleware/userAuth';
import { AUTH_RUNTIME_KEY } from './runtime';
import { assertLoginEmailVerified } from './services/auth';
import type { AuthPluginConfig } from './types/config';
import { authPluginConfigSchema } from './types/config';

export type { AuthPluginConfig };

type FrameworkRedisClient = ConnectionOptions & Redis;
type FrameworkMongoConn = { auth: Connection | null; app: Connection | null };

function readCookieHeaderValue(cookieHeader: string | null, name: string): string | null {
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(';')) {
    const trimmed = part.trim();
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    if (trimmed.slice(0, eq) !== name) continue;
    const value = trimmed.slice(eq + 1);
    try {
      return decodeURIComponent(value);
    } catch {
      return value;
    }
  }
  return null;
}

function readBearerToken(header: string | null): string | null {
  return header?.startsWith('Bearer ') ? header.slice(7) : null;
}

function readAuthCookieHeaderValue(
  cookieHeader: string | null,
  baseName: string,
  production: boolean,
  config: AuthResolvedConfig,
): string | null {
  const secureName = getSecureCookieName(baseName, production, config);
  const secureValue = readCookieHeaderValue(cookieHeader, secureName);
  if (secureValue || (production && secureName !== baseName)) return secureValue;
  return readCookieHeaderValue(cookieHeader, baseName);
}

/**
 * Creates the slingshot-auth plugin instance for use with `createApp()`, `createServer()`,
 * or as a standalone Hono plugin via `plugin.setup()`.
 *
 * The plugin bootstraps all auth subsystems (session store, adapters, rate limiting,
 * credential stuffing detection, OAuth providers, MFA, SAML, SCIM, etc.) and mounts
 * the corresponding route handlers on the Hono app.
 *
 * @param rawConfig - Plugin configuration. Validated against `authPluginConfigSchema` at
 *   call time — invalid config throws immediately.
 * @returns A `StandalonePlugin` implementing the four slingshot lifecycle phases:
 *   `setupMiddleware`, `setupRoutes`, `setupPost`, and `setup` (standalone convenience).
 *
 * @throws {Error} When `rawConfig` fails Zod validation.
 * @throws {Error} When `RuntimePassword` is not provided (standalone mode only).
 * @throws {Error} When JWT secrets are missing or too short at startup.
 * @throws {Error} When required auth config is invalid or secrets are missing.
 *
 * @example
 * // Full-framework usage
 * import { createServer } from '@lastshotlabs/slingshot-core';
 * import { createAuthPlugin } from '@lastshotlabs/slingshot-auth';
 *
 * const server = await createServer({
 *   plugins: [createAuthPlugin({ auth: { emailVerification: { required: true } } })],
 * });
 *
 * @example
 * // Standalone Hono usage (no framework)
 * import { Hono } from 'hono';
 * import { InProcessAdapter } from '@lastshotlabs/slingshot-core';
 * import { createAuthPlugin } from '@lastshotlabs/slingshot-auth';
 *
 * const app = new Hono();
 * const plugin = createAuthPlugin({
 *   runtime: { password: myPasswordRuntime },
 *   auth: { roles: ['admin', 'user'], defaultRole: 'user' },
 * });
 * await plugin.setup!(app, {} as any, new InProcessAdapter());
 *
 * @remarks
 * - In standalone mode (no `SlingshotFrameworkConfig`), `config.runtime.password` is required.
 * - Production boot requires an explicit `security.signing.sessionBinding` choice.
 *   Without it a stolen JWT+session pair is usable from any IP or browser. Set
 *   `security.signing.sessionBinding` to either a real binding policy or `false`
 *   to acknowledge the risk explicitly.
 * - OAuth routes are provided by `@lastshotlabs/slingshot-oauth` and mounted by that plugin.
 */
export function createAuthPlugin(rawConfig: AuthPluginConfig): StandalonePlugin {
  emitPackageStabilityWarning(
    '@lastshotlabs/slingshot-auth',
    'experimental',
    'Use this package on the next channel while the auth surface is still being hardened.',
  );

  const config: AuthPluginConfig = validatePluginConfig(
    'slingshot-auth',
    rawConfig,
    authPluginConfigSchema,
  );

  type MutableContext = {
    pluginState: Map<string, unknown>;
    routeAuth: unknown;
    rateLimitAdapter: unknown;
    fingerprintBuilder: unknown;
  };

  // Lifecycle handoff: setupMiddleware resolves this promise once bootstrap
  // completes. Later phases await it — type-safe, no mutable variable.
  // rejectBootstrap is called when setupMiddleware throws so teardown() can
  // detect failure and return early rather than deadlocking on bootstrapReady.
  // The .catch(() => {}) suppresses the unhandled-rejection warning in cases
  // where setupMiddleware throws before teardown() attaches its own catch.
  let bootstrapStarted = false;
  let bootstrapCompleted = false;
  let resolveBootstrap!: (result: BootstrapResult) => void;
  let rejectBootstrap!: (err: unknown) => void;
  const bootstrapReady = new Promise<BootstrapResult>((resolve, reject) => {
    resolveBootstrap = resolve;
    rejectBootstrap = reject;
  });
  bootstrapReady.catch(() => {});

  return {
    name: 'slingshot-auth',

    async setupMiddleware({ app, config: frameworkConfig, bus, events }: PluginSetupContext) {
      bootstrapStarted = true;
      try {
        const registrar = frameworkConfig.registrar;
        registerAuthEventDefinitions(events);

        const resolved = frameworkConfig.resolvedStores;
        const redis = frameworkConfig.redis as FrameworkRedisClient | null | undefined;
        const mongo = frameworkConfig.mongo as FrameworkMongoConn | undefined;
        const resolvedPassword = frameworkConfig.password;
        const result = await bootstrapAuth(config, bus, events, resolved, {
          signing: frameworkConfig.signing ?? config.security?.signing ?? null,
          logging: {
            verbose: frameworkConfig.logging.verbose,
            authTrace: frameworkConfig.logging.authTrace,
          },
          trustProxy: frameworkConfig.trustProxy,
          dataEncryptionKeys: frameworkConfig.dataEncryptionKeys,
          getRedis: redis ? () => redis : undefined,
          getMongoAuth: mongo ? () => mongo.auth : undefined,
          getMongoApp: mongo ? () => mongo.app : undefined,
          getPostgres: frameworkConfig.storeInfra
            ? () => frameworkConfig.storeInfra.getPostgres()
            : undefined,
          password: resolvedPassword,
          sqlite: frameworkConfig.sqlite ?? config.runtime?.sqlite,
        });
        bootstrapCompleted = true;
        resolveBootstrap(result);

        const ctx = getContextOrNull(app);
        if (ctx) {
          publishPluginState(ctx.pluginState, AUTH_RUNTIME_KEY, result.runtime);
        }
        const mutableCtx = ctx as MutableContext | null;

        // Validate JWT secrets — auth owns its own startup validation
        validateJwtSecrets(result.runtime.config, result.runtime.signing);

        // Production requires an explicit session fingerprint binding choice.
        // Without it a stolen JWT+session pair works from any IP or browser.
        // Use `true` for IP+UA binding, `{ fields: ['ua'], onMismatch: 'log-only' }`
        // for a low-false-positive start on mobile/CDN-heavy deployments, or
        // `false` to make the opt-out explicit.
        if (isProd() && result.runtime.signing?.sessionBinding === undefined) {
          throw new Error(
            '[slingshot-auth] signing.sessionBinding must be explicitly configured in production. ' +
              'A stolen JWT+session token is otherwise usable from any IP or browser. ' +
              'Set signing.sessionBinding to a binding policy or `false` to acknowledge the risk explicitly.',
          );
        }

        // Register auth boundary contracts with core

        // RouteAuthRegistry — provides userAuth, requireRole, and postGuards to framework routes
        const accountGuard = createAccountGuard({
          adapter: result.adapter,
          config: result.runtime.config,
        });
        const postGuards = Object.freeze([accountGuard]);
        const routeAuthRegistry = {
          userAuth,
          requireRole(...roles: string[]): MiddlewareHandler<AppEnv> {
            return requireRole(...roles);
          },
          postGuards,
        };
        registrar.setRouteAuth(routeAuthRegistry);
        if (mutableCtx) {
          mutableCtx.routeAuth = routeAuthRegistry;
        }

        // RateLimitAdapter — wraps auth's rate limit service
        const rlService = result.runtime.rateLimit;
        const rateLimitAdapter = {
          async trackAttempt(
            key: string,
            opts: { windowMs: number; max: number },
          ): Promise<boolean> {
            if (await rlService.isLimited(key, opts)) {
              return true;
            }
            await rlService.trackAttempt(key, opts);
            return false;
          },
        };
        registrar.setRateLimitAdapter(rateLimitAdapter);
        if (mutableCtx) {
          mutableCtx.rateLimitAdapter = rateLimitAdapter;
        }

        // FingerprintBuilder — wraps auth's buildFingerprint
        const fingerprintBuilder = {
          async buildFingerprint(req: Request): Promise<string> {
            return buildFingerprint(req);
          },
        };
        registrar.setFingerprintBuilder(fingerprintBuilder);
        if (mutableCtx) {
          mutableCtx.fingerprintBuilder = fingerprintBuilder;
        }

        // CacheAdapters — register factory-created memory cache adapter
        registrar.addCacheAdapter('memory', createMemoryCacheAdapter());

        // Resolve bearer tokens: explicit config only — no process.env fallback.
        // Bearer tokens should be provided via config or resolved by SecretRepository at the app level.
        const bearerTokens = config.security?.bearerTokens;
        const enableBearerAuth = config.security?.bearerAuth !== false && bearerTokens;
        if (enableBearerAuth) {
          const bearerAuthMiddleware = createBearerAuth(bearerTokens);

          // Register bearerAuth on RouteAuthRegistry so applyRouteConfig() can use it per-route.
          // Re-register with the same userAuth/requireRole, adding bearerAuth.
          const bearerRouteAuthRegistry = {
            userAuth,
            requireRole(...roles: string[]): MiddlewareHandler<AppEnv> {
              return requireRole(...roles);
            },
            bearerAuth: bearerAuthMiddleware,
            postGuards,
          };
          registrar.setRouteAuth(bearerRouteAuthRegistry);
          if (mutableCtx) {
            mutableCtx.routeAuth = bearerRouteAuthRegistry;
          }

          const bypass = result.bearerAuthBypassPaths;
          app.use('*', async (c, next) => {
            if (isPublicPath(c.req.path, getContextOrNull(app)?.publicPaths ?? [])) {
              return next();
            }
            const path = c.req.path;
            const bypassed = bypass.some((entry: string) =>
              entry.endsWith('*') ? path.startsWith(entry.slice(0, -1)) : path === entry,
            );
            if (bypassed) return next();

            return bearerAuthMiddleware(c as Context<AppEnv>, next);
          });
        }

        app.use('*', createIdentifyMiddleware(result.runtime));

        if (config.security?.csrf?.enabled) {
          const corsOrigins: string | string[] =
            typeof frameworkConfig.security.cors === 'string'
              ? frameworkConfig.security.cors
              : Array.from(frameworkConfig.security.cors);
          const csrfExemptPaths = [
            ...new Set([
              ...result.oauthCallbackPaths,
              ...(frameworkConfig.security.csrf?.exemptPaths ?? []),
              ...(config.security.csrf.exemptPaths ?? []),
            ]),
          ];
          const protectedUnauthenticatedPaths = [
            '/auth/login',
            '/auth/register',
            '/auth/verify-and-login',
            '/auth/magic-link/verify',
            '/auth/mfa/verify',
            '/auth/passkey/login',
            '/auth/refresh',
            '/auth/google',
            '/auth/apple',
            '/auth/microsoft',
            '/auth/github',
            '/auth/linkedin',
            '/auth/twitter',
            '/auth/gitlab',
            '/auth/slack',
            '/auth/bitbucket',
            '/auth/oauth/exchange',
            '/auth/oauth/reauth/exchange',
            '/auth/saml/login',
          ];
          app.use(
            '*',
            csrfProtection({
              exemptPaths: csrfExemptPaths,
              protectedUnauthenticatedPaths,
              checkOrigin: config.security.csrf.checkOrigin ?? true,
              allowedOrigins: corsOrigins,
              signing: result.runtime.signing,
            }),
          );
        }

        if (config.auth?.mfa?.required) {
          app.use('*', requireMfaSetup);
        }

        // Config is already deep-frozen by createAuthResolvedConfig in bootstrap
      } catch (err) {
        if (!bootstrapCompleted) {
          rejectBootstrap(err);
        }
        throw err;
      }
    },

    async setupRoutes({ app }: PluginSetupContext) {
      const result = await bootstrapReady;

      const enableAuthRoutes = config.auth?.enabled !== false;
      const authConfig = config.auth ?? {};
      const primaryField = authConfig.primaryField ?? 'email';
      if (enableAuthRoutes) {
        const { createRegisterRouter } = await import('./routes/register');
        app.route(
          '/',
          createRegisterRouter(
            {
              primaryField,
              emailVerification: authConfig.emailVerification,
              rateLimit: authConfig.rateLimit,
              concealRegistration: authConfig.concealRegistration,
              refreshTokens: authConfig.refreshTokens,
            },
            result.runtime,
          ),
        );

        const { createLoginRouter } = await import('./routes/login');
        app.route(
          '/',
          createLoginRouter(
            {
              primaryField,
              refreshTokens: authConfig.refreshTokens,
              rateLimit: authConfig.rateLimit,
            },
            result.runtime,
          ),
        );

        const { createAccountRouter } = await import('./routes/account');
        app.route(
          '/',
          createAccountRouter(
            {
              primaryField,
              rateLimit: authConfig.rateLimit,
              refreshTokens: authConfig.refreshTokens,
              sessionPolicy: authConfig.sessionPolicy ?? {},
              accountDeletion: authConfig.accountDeletion,
            },
            result.runtime,
          ),
        );

        const { createSessionsRouter } = await import('./routes/sessions');
        app.route('/', createSessionsRouter({ rateLimit: authConfig.rateLimit }, result.runtime));

        if (authConfig.emailVerification && primaryField === 'email') {
          const { createEmailVerificationRouter } = await import('./routes/emailVerification');
          app.route(
            '/',
            createEmailVerificationRouter(
              {
                primaryField,
                emailVerification: authConfig.emailVerification,
                rateLimit: authConfig.rateLimit,
              },
              result.runtime,
            ),
          );
        }

        if (authConfig.passwordReset && primaryField === 'email') {
          const { createPasswordResetRouter } = await import('./routes/passwordReset');
          app.route(
            '/',
            createPasswordResetRouter({ rateLimit: authConfig.rateLimit }, result.runtime),
          );
        }

        if (authConfig.refreshTokens) {
          const { createRefreshRouter } = await import('./routes/refresh');
          app.route(
            '/',
            createRefreshRouter({ refreshTokens: authConfig.refreshTokens }, result.runtime),
          );
        }

        if (authConfig.accountDeletion?.queued && authConfig.accountDeletion.gracePeriod) {
          const { createAccountDeletionRouter } = await import('./routes/accountDeletion');
          app.route(
            '/',
            createAccountDeletionRouter(
              {
                accountDeletion: authConfig.accountDeletion as {
                  queued: true;
                  gracePeriod: number;
                },
              },
              result.runtime,
            ),
          );
        }

        if (authConfig.stepUp) {
          const { createStepUpRouter } = await import('./routes/stepUp');
          app.route(
            '/',
            createStepUpRouter(
              { stepUp: authConfig.stepUp, rateLimit: authConfig.rateLimit },
              result.runtime,
            ),
          );
        }

        if (authConfig.magicLink) {
          const { createMagicLinkRouter } = await import('./routes/magicLink');
          app.route(
            '/',
            createMagicLinkRouter(
              { magicLink: authConfig.magicLink, refreshTokens: authConfig.refreshTokens },
              result.runtime,
            ),
          );
        }
      }

      if (authConfig.mfa && enableAuthRoutes) {
        const { createMfaRouter } = await import('./routes/mfa');
        app.route('/', createMfaRouter({ rateLimit: authConfig.rateLimit }, result.runtime));
      }

      if (authConfig.mfa?.webauthn?.allowPasswordlessLogin && enableAuthRoutes) {
        const { assertWebAuthnDependency } = await import('./services/mfa');
        await assertWebAuthnDependency();
        const { createPasskeyRouter } = await import('./routes/passkey');
        app.route('/', createPasskeyRouter(result.runtime));
      }

      if (authConfig.saml) {
        const { createSamlRouter } = await import('./routes/saml');
        app.route('/', createSamlRouter(result.runtime));
      }

      // Mount OAuth routes when providers are configured.
      // OAuth routes live in slingshot-oauth — dynamically import if available.
      // OAuth routes are owned by @lastshotlabs/slingshot-oauth.
    },

    async setupPost({ app, config: frameworkConfig }: PluginSetupContext) {
      const result = await bootstrapReady;
      const registrar = frameworkConfig.registrar;

      // Register resolved auth config on SlingshotContext (when available)
      const ctx = getContextOrNull(app);
      if (ctx) {
        publishPluginState(ctx.pluginState, AUTH_RUNTIME_KEY, result.runtime);
      }

      // RequestActorResolver — provides resolveActor to framework WS/SSE upgrade
      const runtime = result.runtime;
      const trustProxy = frameworkConfig.trustProxy;
      const computeResolverFingerprint = (
        req: Request,
        fields: Array<'ip' | 'ua' | 'accept-language'>,
      ): string => {
        const parts = fields.map(field => {
          if (field === 'ip') return getClientIpFromRequest(req, trustProxy);
          if (field === 'ua') return req.headers.get('user-agent') ?? '';
          return req.headers.get('accept-language') ?? '';
        });
        return sha256(parts.join(':'));
      };
      registrar.setRequestActorResolver({
        async resolveActor(req: Request): Promise<Actor> {
          try {
            const production = isProd();
            const cookieHeader = req.headers.get('cookie');
            const token =
              readAuthCookieHeaderValue(cookieHeader, COOKIE_TOKEN, production, runtime.config) ??
              req.headers.get(HEADER_USER_TOKEN) ??
              readBearerToken(req.headers.get('authorization'));
            if (!token) return ANONYMOUS_ACTOR;
            const payload = await verifyToken(token, runtime.config, runtime.signing);
            const sessionId = payload.sid as string | undefined;
            const userId = payload.sub;
            const tenantId =
              typeof payload['tenantId'] === 'string'
                ? (payload['tenantId'] as string)
                : typeof payload['tid'] === 'string'
                  ? (payload['tid'] as string)
                  : null;
            const roles = Array.isArray(payload['roles']) ? (payload['roles'] as string[]) : null;

            if (!sessionId) {
              if (payload.scope && typeof userId === 'string' && userId.length > 0) {
                const client = runtime.config.m2m
                  ? await runtime.adapter.getM2MClient?.(userId)
                  : null;
                if (!client?.active) return ANONYMOUS_ACTOR;
                return {
                  id: userId,
                  kind: 'service-account',
                  tenantId,
                  sessionId: null,
                  roles,
                  claims: {},
                };
              }
              return ANONYMOUS_ACTOR;
            }
            if (!userId) return ANONYMOUS_ACTOR;
            const stored = await runtime.repos.session.getSession(sessionId, runtime.config);
            if (!timingSafeEqual(stored ?? '', token)) return ANONYMOUS_ACTOR;

            const bindingCfg = runtime.signing?.sessionBinding;
            if (bindingCfg) {
              const bindingOpts = typeof bindingCfg === 'object' ? bindingCfg : {};
              const fields: Array<'ip' | 'ua' | 'accept-language'> = bindingOpts.fields ?? [
                'ip',
                'ua',
              ];
              const onMismatch = bindingOpts.onMismatch ?? 'unauthenticate';
              const current = computeResolverFingerprint(req, fields);
              const storedFp = await runtime.repos.session.getSessionFingerprint(sessionId);

              if (storedFp === null) {
                runtime.repos.session.setSessionFingerprint(sessionId, current).catch(() => {
                  /* best-effort */
                });
              } else if (!timingSafeEqual(storedFp, current)) {
                if (onMismatch === 'log-only') {
                  console.warn(
                    `[slingshot-auth] session binding mismatch during upgrade auth for user ${userId}`,
                  );
                } else {
                  return ANONYMOUS_ACTOR;
                }
              }
            }

            const suspensionStatus = await getSuspended(runtime.adapter, userId).catch(() => ({
              suspended: false,
            }));
            if (suspensionStatus.suspended) return ANONYMOUS_ACTOR;

            try {
              await assertLoginEmailVerified(userId, runtime);
            } catch (err) {
              if (err instanceof HttpError && err.status === 403) {
                return ANONYMOUS_ACTOR;
              }
              throw err;
            }

            return {
              id: userId,
              kind: 'user',
              tenantId,
              sessionId,
              roles,
              claims: {},
            };
          } catch {
            return ANONYMOUS_ACTOR;
          }
        },
      });

      // EmailTemplates — register auth's built-in templates for mail plugin
      const templateMap: Record<string, { subject: string; html: string; text?: string }> = {};
      for (const [key, tpl] of Object.entries(templates)) {
        templateMap[key] = { subject: tpl.subject, html: tpl.html, text: tpl.text };
      }
      const DELIVERY_MAP: Record<string, string> = {
        email_verification: 'emailVerification',
        password_reset: 'passwordReset',
        magic_link: 'magicLink',
        email_otp: 'emailOtp',
        welcome: 'welcomeEmail',
        account_deletion: 'accountDeletion',
        org_invitation: 'orgInvitation',
      };
      for (const [deliveryKey, authKey] of Object.entries(DELIVERY_MAP)) {
        const tpl = templates[authKey];
        templateMap[deliveryKey] = {
          subject: tpl.subject,
          html: tpl.html,
          text: tpl.text,
        };
      }
      registrar.addEmailTemplates(templateMap);
    },

    /**
     * Standalone convenience — the framework NEVER calls this.
     * Plain Hono apps call setup() directly since there is no framework to orchestrate phases.
     * Calls setupMiddleware then setupRoutes in sequence.
     */
    async seed({ manifestSeed, seedState }: PluginSeedContext) {
      const result = await bootstrapReady;
      const users = manifestSeed.users as
        | ReadonlyArray<{ email: string; password: string; superAdmin?: boolean }>
        | undefined;
      if (!users?.length) return;

      for (const seedUser of users) {
        const existing = await result.runtime.adapter.findByEmail(seedUser.email);
        if (existing) {
          console.log(`[slingshot-auth seed] User '${seedUser.email}' already exists — skipping.`);
          seedState.set(`user:${seedUser.email}`, existing.id);
          continue;
        }

        const hash = await result.runtime.password.hash(seedUser.password);
        const { id } = await result.runtime.adapter.create(seedUser.email, hash);
        seedState.set(`user:${seedUser.email}`, id);
        console.log(`[slingshot-auth seed] Created user '${seedUser.email}' (id: ${id}).`);

        if (seedUser.superAdmin) {
          seedState.set(`superAdmin:${seedUser.email}`, true);
        }
      }
    },

    async setup(ctx: PluginSetupContext) {
      if (this.setupMiddleware) await this.setupMiddleware(ctx);
      if (this.setupRoutes) await this.setupRoutes(ctx);
    },

    async teardown() {
      if (!bootstrapStarted) {
        return;
      }
      let result: BootstrapResult;
      try {
        result = await bootstrapReady;
      } catch {
        return; // bootstrap never completed — nothing to tear down
      }
      for (const fn of result.teardownFns) {
        await fn();
      }
    },
  };
}
