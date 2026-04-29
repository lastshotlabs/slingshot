/**
 * bootstrapAuth — extracted auth setup for use by the auth plugin.
 *
 * Called by the plugin's setupMiddleware() phase.
 * - Framework path: `resolvedStores` provided — skips store resolution and connection calls.
 * - Standalone path: `resolvedStores` absent — resolves stores from config.db with memory defaults.
 */
import type { ConnectionOptions } from 'bullmq';
import type Redis from 'ioredis';
import type { Connection } from 'mongoose';
import type {
  AuthAdapter,
  DataEncryptionKey,
  PostgresBundle,
  ResolvedStores,
  RuntimePassword,
  SigningConfig,
  SlingshotEventBus,
  SlingshotEvents,
  StoreType,
} from '@lastshotlabs/slingshot-core';
import { createMemoryAuthAdapter } from './adapters/memoryAuth';
import { createAuthResolvedConfig } from './config/authConfig';
import type { AuthResolvedConfig } from './config/authConfig';
import type { LockoutService } from './lib/accountLockout';
import type { AuthRateLimitService } from './lib/authRateLimit';
import type { CredentialStuffingService } from './lib/credentialStuffing';
import { isProd } from './lib/env';
import { validateJwtSecrets } from './lib/jwt';
import { createAuthLogger } from './lib/logger';
import { createOAuthProviders, getConfiguredOAuthProviders } from './lib/oauth';
import { wireSecurityEventConfig } from './lib/securityEventWiring';
import type { AuthRuntimeContext } from './runtime';
import { makeDummyHashGetter } from './services/auth';
import type { AuthPluginConfig } from './types/config';

type AuthRedisClient = ConnectionOptions & Redis;

export interface BootstrapResult {
  adapter: AuthAdapter;
  runtime: AuthRuntimeContext;
  configuredOAuthProviders: string[];
  bearerAuthBypassPaths: string[];
  oauthCallbackPaths: string[];
  stores: ResolvedStores;
  teardownFns: (() => void | Promise<void>)[];
}

export interface AuthRuntimeInfra {
  signing: SigningConfig | null;
  dataEncryptionKeys: readonly DataEncryptionKey[];
  logging?: {
    verbose: boolean;
    authTrace: boolean;
  };
  trustProxy?: false | number;
  /** Returns the Redis client. Throws if Redis is not configured. */
  getRedis?: () => AuthRedisClient;
  /** Returns the Mongo auth connection, or null. */
  getMongoAuth?: () => Connection | null;
  /** Returns the Mongo app connection, or null. */
  getMongoApp?: () => Connection | null;
  /** Password hashing/verification abstraction. Required — auth never picks a runtime. */
  password: RuntimePassword;
  /** SQLite database opener. Required when any store is configured as 'sqlite'. */
  sqlite?: { open(path: string): import('@lastshotlabs/slingshot-core').RuntimeSqliteDatabase };
  /** Returns the Postgres bundle. Present when the framework wires postgres. */
  getPostgres?: () => import('@lastshotlabs/slingshot-core').PostgresBundle;
}

const REDIS_STORE_UNAVAILABLE_MESSAGE =
  '[slingshot-auth] A store is configured as "redis" but no Redis connection is available.\n' +
  'When using slingshot-auth standalone, use "memory" or "sqlite" stores,\n' +
  'or establish a Redis connection (connectRedis()) before calling plugin.setupMiddleware().';

const STANDALONE_MONGO_UNAVAILABLE_MESSAGE =
  '[slingshot-auth] Standalone mode with mongo requires connecting before setupMiddleware().\n' +
  'Call connectMongo() / connectAuthMongo() + connectAppMongo() and pass connections via frameworkConfig,\n' +
  'or use the framework (createServer / createApp) which handles this automatically.';

const STANDALONE_REDIS_SESSION_UNAVAILABLE_MESSAGE =
  '[slingshot-auth] Standalone mode with redis stores requires connecting before setupMiddleware().\n' +
  'Call connectRedis() and pass the client via frameworkConfig.redis,\n' +
  'or use "memory" / "sqlite" stores for standalone mode.';

function usesRedisStore(stores: ResolvedStores): boolean {
  return [stores.sessions, stores.oauthState, stores.authStore].includes('redis');
}

function requiresSqlite(stores: ResolvedStores): boolean {
  return (
    !!stores.sqlite || [stores.sessions, stores.oauthState, stores.authStore].includes('sqlite')
  );
}

function resolveSecurityStore(
  stores: ResolvedStores,
  configuredStore?: 'redis' | 'memory',
): 'redis' | 'memory' {
  if (configuredStore) return configuredStore;
  return [stores.sessions, stores.oauthState].includes('redis') ? 'redis' : 'memory';
}

function assertRedisAvailable(runtimeInfra: AuthRuntimeInfra | undefined, message: string): void {
  if (!runtimeInfra?.getRedis) {
    throw new Error(message);
  }
  try {
    runtimeInfra.getRedis();
  } catch {
    throw new Error(message);
  }
}

function assertMongoAuthAvailable(
  runtimeInfra: AuthRuntimeInfra | undefined,
  message: string,
): void {
  if (!runtimeInfra?.getMongoAuth?.()) {
    throw new Error(message);
  }
}

async function awaitAdapterReadiness(adapter: AuthAdapter): Promise<void> {
  const ready = (adapter as AuthAdapter & { ready?: unknown }).ready;
  if (typeof ready === 'function') {
    await (ready as () => Promise<void>).call(adapter);
  }
}

function getErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export async function bootstrapAuth(
  config: AuthPluginConfig,
  bus: SlingshotEventBus,
  events: SlingshotEvents,
  resolvedStores?: ResolvedStores,
  runtimeInfra?: AuthRuntimeInfra,
): Promise<BootstrapResult> {
  const authConfig = config.auth ?? {};
  const sessionPolicy = authConfig.sessionPolicy ?? {};
  const teardownFns: (() => void | Promise<void>)[] = [];
  const signing = runtimeInfra?.signing ?? config.security?.signing ?? null;
  const trustProxy = runtimeInfra?.trustProxy ?? config.security?.trustProxy;
  const dataEncryptionKeys = runtimeInfra?.dataEncryptionKeys ?? [];
  const authLogger = createAuthLogger({
    verbose: runtimeInfra?.logging?.verbose,
    authTrace: runtimeInfra?.logging?.authTrace,
  });
  if (!runtimeInfra?.password) {
    throw new Error(
      '[slingshot-auth] RuntimePassword is required. Pass it via runtimeInfra.password.',
    );
  }
  const password: RuntimePassword = runtimeInfra.password;

  // Section A: Event bus wiring
  wireSecurityEventConfig(bus, config.securityEvents);

  // Section B: Store resolution
  let stores: ResolvedStores;
  if (resolvedStores) {
    stores = resolvedStores;
  } else {
    const db = config.db ?? {};
    const defaultStore: StoreType = 'memory';
    stores = {
      sessions: db.sessions ?? defaultStore,
      oauthState: db.oauthState ?? db.sessions ?? defaultStore,
      cache: db.sessions ?? defaultStore,
      authStore:
        db.auth ??
        (db.postgres ? 'postgres' : db.mongo !== false ? 'mongo' : (db.sessions ?? defaultStore)),
      sqlite: db.sqlite,
    };

    if (usesRedisStore(stores)) assertRedisAvailable(runtimeInfra, REDIS_STORE_UNAVAILABLE_MESSAGE);
    if (db.mongo === 'single' || db.mongo === 'separate')
      assertMongoAuthAvailable(runtimeInfra, STANDALONE_MONGO_UNAVAILABLE_MESSAGE);
    if (db.redis !== false && stores.sessions === 'redis')
      assertRedisAvailable(runtimeInfra, STANDALONE_REDIS_SESSION_UNAVAILABLE_MESSAGE);
    if (
      (stores.authStore === 'postgres' ||
        stores.sessions === 'postgres' ||
        stores.oauthState === 'postgres') &&
      !config.db?.postgres
    ) {
      throw new Error(
        '[slingshot-auth] A store is configured as "postgres" but no connection string is available.',
      );
    }
  }

  // Postgres pool — set during adapter resolution, used by storeInfra
  let postgres: PostgresBundle | null = null;

  // Section C: SQLite init
  let sqliteAdapter: Awaited<
    ReturnType<typeof import('./adapters/sqliteAuth').createSqliteAuthAdapter>
  > | null = null;
  if (requiresSqlite(stores)) {
    if (!runtimeInfra.sqlite) {
      throw new Error(
        '[slingshot-auth] A SQLite store is configured but no SQLite opener was provided. ' +
          'Pass runtimeInfra.sqlite = { open(path) } (e.g. from bunRuntime().sqlite).',
      );
    }
    const { createSqliteAuthAdapter } = await import('./adapters/sqliteAuth');
    const sqlitePath = stores.sqlite ?? './data.db';
    const sqliteDb = runtimeInfra.sqlite.open(sqlitePath);
    sqliteAdapter = createSqliteAuthAdapter(sqliteDb, password);
    const adapter = sqliteAdapter;
    teardownFns.push(() => adapter.stopCleanup());
  }

  // Section E: Adapter resolution
  let authAdapter: AuthAdapter;
  const explicitAdapter = authConfig.adapter;
  if (explicitAdapter) {
    authAdapter = explicitAdapter;
  } else if (stores.authStore === 'sqlite') {
    if (!sqliteAdapter) throw new Error('[slingshot-auth] SQLite adapter not initialized');
    authAdapter = sqliteAdapter.adapter;
  } else if (stores.authStore === 'memory') {
    authAdapter = createMemoryAuthAdapter(() => resolvedConfig, password);
  } else if (stores.authStore === 'postgres') {
    // String indirection prevents tsc from resolving the optional dep at build time.
    const postgresPkg = '@lastshotlabs/slingshot-postgres';
    const { createPostgresAdapter } = (await import(postgresPkg)) as {
      createPostgresAdapter: (opts: { pool: unknown }) => Promise<AuthAdapter>;
    };
    const { connectPostgres } = (await import(postgresPkg)) as {
      connectPostgres: (
        connectionString: string,
        options?: {
          pool?: {
            max?: number;
            min?: number;
            idleTimeoutMs?: number;
            connectionTimeoutMs?: number;
            queryTimeoutMs?: number;
            statementTimeoutMs?: number;
            maxUses?: number;
            allowExitOnIdle?: boolean;
            keepAlive?: boolean;
            keepAliveInitialDelayMillis?: number;
          };
          migrations?: import('@lastshotlabs/slingshot-core').PostgresMigrationMode;
          healthcheckTimeoutMs?: number;
        },
      ) => Promise<PostgresBundle>;
    };
    const connectionString = config.db?.postgres;
    if (!connectionString) {
      throw new Error(
        '[slingshot-auth] Postgres auth adapter requires config.db.postgres connection string',
      );
    }
    postgres = await connectPostgres(connectionString, {
      pool: config.db?.postgresPool,
      migrations: config.db?.postgresMigrations,
      healthcheckTimeoutMs: config.db?.postgresPool?.queryTimeoutMs,
    });
    authAdapter = await createPostgresAdapter({ pool: postgres.pool });
    teardownFns.push(() => postgres?.pool.end());
  } else {
    const { createMongoAuthAdapter } = await import('./adapters/mongoAuth');
    const { resolveMongoose: resolveMg } = await import('./infra/mongo');
    const authConn = runtimeInfra.getMongoAuth?.() ?? null;
    if (!authConn)
      throw new Error(
        '[slingshot-auth] Mongo auth adapter requires a Mongo auth connection via runtimeInfra.getMongoAuth',
      );
    authAdapter = createMongoAuthAdapter(authConn, resolveMg(), password);
  }

  await awaitAdapterReadiness(authAdapter);

  // Section F: Config-vs-config validations
  const emailVerification = authConfig.emailVerification;
  const passwordReset = authConfig.passwordReset;
  const primaryField = authConfig.primaryField ?? 'email';
  const oauthProviders = authConfig.oauth?.providers;

  if (emailVerification && primaryField !== 'email') {
    throw new Error(
      `[slingshot-auth] "emailVerification" is only supported when primaryField is "email". Either set primaryField to "email" or remove emailVerification.`,
    );
  }

  if (passwordReset && primaryField !== 'email') {
    throw new Error(
      `[slingshot-auth] "passwordReset" is only supported when primaryField is "email". Either set primaryField to "email" or remove passwordReset.`,
    );
  }

  if (authConfig.concealRegistration && primaryField !== 'email') {
    throw new Error(
      `[slingshot-auth] "concealRegistration" requires primaryField to be "email" — concealment relies on email delivery as the side-channel`,
    );
  }

  // Adapter capability validation
  {
    const { validateAdapterCapabilities } = await import('./lib/validateAdapter');
    validateAdapterCapabilities(authAdapter, {
      hasOAuthProviders: Array.isArray(oauthProviders) && oauthProviders.length > 0,
      hasMfa: !!authConfig.mfa,
      hasMfaWebAuthn: !!authConfig.mfa?.webauthn,
      hasRoles: (authConfig.roles?.length ?? 0) > 0 && !authConfig.defaultRole,
      hasDefaultRole: !!authConfig.defaultRole,
      hasGroups: false,
      hasSuspension: authConfig.checkSuspensionOnIdentify !== false,
      hasM2m: !!authConfig.m2m?.enabled,
      hasAdminApi: false,
      hasPasswordReset: !!passwordReset,
      hasPreventReuse: !!authConfig.passwordPolicy?.preventReuse,
      hasScim: !!authConfig.scim,
      scimDeprovisionMode: authConfig.scim
        ? typeof authConfig.scim.onDeprovision === 'function'
          ? 'custom'
          : (authConfig.scim.onDeprovision ?? 'suspend')
        : 'suspend',
    });
  }

  // Validate TOTP encryption key
  if (authConfig.mfa) {
    if (dataEncryptionKeys.length === 0) {
      if (isProd()) {
        throw new Error(
          '[slingshot-auth] MFA is configured in production but SLINGSHOT_DATA_ENCRYPTION_KEY is not set. Set this env var to encrypt TOTP secrets at rest.',
        );
      } else {
        console.warn(
          '[slingshot-auth] WARNING: MFA configured without SLINGSHOT_DATA_ENCRYPTION_KEY. TOTP secrets stored in plaintext. Set this key in production.',
        );
      }
    }
  }

  // Section G: Build resolved auth config
  const maxSessions = (() => {
    const n = sessionPolicy.maxSessions ?? 6;
    return Number.isFinite(n) && n >= 1 ? Math.floor(n) : 1;
  })();

  let resolvedConfig: AuthResolvedConfig = {
    appName: config.appName ?? 'Bun Core API',
    appRoles: authConfig.roles ?? [],
    defaultRole: authConfig.defaultRole ?? null,
    primaryField,
    concealRegistration: authConfig.concealRegistration ?? null,
    emailVerification: emailVerification ?? null,
    passwordReset: passwordReset ?? null,
    magicLink: authConfig.magicLink ?? null,
    passwordPolicy: authConfig.passwordPolicy ?? {},
    rateLimit: authConfig.rateLimit ?? {},
    authCookie: authConfig.cookieConfig ?? {},
    csrfCookie: authConfig.csrfCookieConfig ?? {},
    maxSessions,
    persistSessionMetadata: sessionPolicy.persistSessionMetadata ?? true,
    includeInactiveSessions: sessionPolicy.includeInactiveSessions ?? false,
    trackLastActive: sessionPolicy.trackLastActive ?? false,
    sessionPolicy,
    refreshToken: authConfig.refreshTokens ?? null,
    mfa: authConfig.mfa
      ? {
          ...authConfig.mfa,
          webauthn: authConfig.mfa.webauthn
            ? {
                ...authConfig.mfa.webauthn,
                strictSignCount: authConfig.mfa.webauthn.strictSignCount ?? isProd(),
              }
            : undefined,
        }
      : null,
    csrfEnabled: !!config.security?.csrf?.enabled,
    jwt: authConfig.jwt ?? null,
    breachedPassword: authConfig.breachedPasswordCheck ?? null,
    oauthPostRedirect: authConfig.oauth?.postRedirect ?? null,
    oauthAllowedRedirectUrls: authConfig.oauth?.allowedRedirectUrls ?? [],
    oauthReauth: authConfig.oauth?.reauth ?? null,
    stepUp: authConfig.stepUp ?? null,
    checkSuspensionOnIdentify: authConfig.checkSuspensionOnIdentify !== false,
    captcha: config.security?.captcha ?? null,
    m2m: authConfig.m2m?.enabled !== false && authConfig.m2m ? authConfig.m2m : null,
    saml: authConfig.saml ?? null,
    oidc: authConfig.oidc ?? null,
    scim: authConfig.scim ?? null,
    emailTemplates: config.emailTemplates ?? null,
    hooks: authConfig.hooks ?? {},
  };

  // Section G2: Security services
  const securityStore = resolveSecurityStore(stores, authConfig.rateLimit?.store);

  let credentialStuffingService: CredentialStuffingService | null = null;
  let lockoutService: LockoutService | null = null;

  if (sessionPolicy.idleTimeout) {
    authLogger.log(
      '[slingshot-auth] sessionPolicy.idleTimeout is set — trackLastActive auto-enabled for idle timeout enforcement.',
    );
  }

  // Section H: OIDC setup
  if (authConfig.oidc) {
    resolvedConfig = {
      ...resolvedConfig,
      jwt: { ...(authConfig.jwt ?? {}), issuer: authConfig.oidc.issuer, algorithm: 'RS256' },
    };

    const { loadJwksKey, generateAndLoadKeyPair, loadPreviousKey } = await import('./lib/jwks');
    let oidcConfig = resolvedConfig.oidc ?? authConfig.oidc;

    if (oidcConfig.signingKey) {
      oidcConfig = loadJwksKey(oidcConfig, oidcConfig.signingKey);
    } else {
      oidcConfig = (await generateAndLoadKeyPair(oidcConfig)).oidc;
    }

    for (const prev of authConfig.oidc.previousKeys ?? []) {
      oidcConfig = loadPreviousKey(oidcConfig, prev);
    }
    resolvedConfig = {
      ...resolvedConfig,
      oidc: oidcConfig,
    };
  }

  // Freeze the final config
  resolvedConfig = createAuthResolvedConfig(resolvedConfig);
  validateJwtSecrets(resolvedConfig, signing);

  if (!resolvedConfig.jwt?.issuer) {
    if (isProd()) {
      throw new Error(
        '[slingshot-auth] jwt.issuer is required in production. Tokens must be bound to a specific issuer to prevent token confusion across services.',
      );
    }
    console.warn(
      '[slingshot-auth] WARNING: jwt.issuer is not configured. Tokens are not bound to a specific issuer, ' +
        'which allows token confusion across services. Set auth.jwt.issuer to your application URL.',
    );
  }
  if (!resolvedConfig.jwt?.audience) {
    if (isProd()) {
      throw new Error(
        '[slingshot-auth] jwt.audience is required in production. Tokens must be bound to a specific audience to prevent acceptance by unrelated services.',
      );
    }
    console.warn(
      '[slingshot-auth] WARNING: jwt.audience is not configured. Tokens are not bound to a specific audience. ' +
        'Set auth.jwt.audience to prevent tokens from being accepted by unrelated services.',
    );
  }

  // Validate cookie domain is not overly broad
  const cookieDomain = resolvedConfig.authCookie.domain;
  if (cookieDomain) {
    const OVERLY_BROAD_DOMAINS = ['.com', '.net', '.org', '.io', '.co', '.co.uk', '.com.au'];
    if (OVERLY_BROAD_DOMAINS.includes(cookieDomain.toLowerCase())) {
      throw new Error(
        `[slingshot-auth] Cookie domain "${cookieDomain}" is overly broad and would scope cookies to all sites ` +
          'under that TLD. Set a specific domain (e.g., ".example.com") or omit it entirely.',
      );
    }
  }

  // Production requires an explicit trustProxy choice whenever auth is active.
  // Login, OAuth exchange, M2M issuance, and other abuse checks key off client
  // IP even when the caller did not provide an explicit auth.rateLimit block.
  if (authConfig.enabled !== false && trustProxy === undefined && isProd()) {
    throw new Error(
      '[slingshot-auth] security.trustProxy must be explicitly configured in production when auth is enabled. ' +
        'Set it to the number of trusted proxies (for example 1) or false when not behind a proxy.',
    );
  }

  if (sqliteAdapter) {
    // SQLite has no native TTL mechanism, so auth owns cleanup startup.
    sqliteAdapter.startCleanup(() => resolvedConfig);
  }

  // Section I: OAuth init
  const resolvedOAuthProviders = oauthProviders ? createOAuthProviders(oauthProviders) : {};
  const configuredOAuth = getConfiguredOAuthProviders(resolvedOAuthProviders);

  // Section J: Queue factory + account deletion worker
  const enableAuthRoutes = authConfig.enabled !== false;

  let queueFactory: import('./infra/queue').AuthQueueFactory | null = null;
  if (runtimeInfra.getRedis) {
    try {
      const { createQueueFactory } = await import('./infra/queue');
      queueFactory = createQueueFactory(runtimeInfra.getRedis);
    } catch (err: unknown) {
      // BullMQ not installed — only error if queued deletion is configured
      if (!getErrorMessage(err).includes('bullmq is not installed')) throw err;
      if (authConfig.accountDeletion?.queued) {
        throw new Error(
          '[slingshot-auth] accountDeletion.queued requires BullMQ. Run: bun add bullmq',
          { cause: err },
        );
      }
    }
  }

  // Section K: Bearer auth bypass paths
  const oauthBypass = configuredOAuth.flatMap(p => [
    `/auth/${p}`,
    `/auth/${p}/callback`,
    `/auth/${p}/link`,
  ]);
  const DEFAULT_BYPASS = [
    '/docs',
    '/openapi.json',
    '/sw.js',
    '/health',
    '/',
    '/metrics',
    '/oauth/token',
    '/.well-known/openid-configuration',
    '/.well-known/jwks.json',
    '/auth/saml/*',
    '/scim/v2/*',
  ];
  const extraBypass =
    typeof config.security?.bearerAuth === 'object'
      ? (config.security.bearerAuth.bypass ?? [])
      : [];
  const bearerAuthBypassPaths = [...DEFAULT_BYPASS, ...oauthBypass, ...extraBypass];
  const oauthCallbackPaths = oauthBypass.filter(p => p.includes('/callback'));

  // Section M: Repository creation — one infra, all repos resolved from factory maps
  const { resolveMongoose } = await import('./infra/mongo');
  const { resolveRepo } = await import('@lastshotlabs/slingshot-core');
  const { oauthStateFactories } = await import('./lib/oauth');
  const { oauthCodeFactories } = await import('./lib/oauthCode');
  const { oauthReauthFactories } = await import('./lib/oauthReauth');
  const { magicLinkFactories } = await import('./lib/magicLink');
  const { deletionCancelTokenFactories } = await import('./lib/deletionCancelToken');
  const { mfaChallengeFactories } = await import('./lib/mfaChallenge');
  const { verificationTokenFactories } = await import('./lib/emailVerification');
  const { resetTokenFactories } = await import('./lib/resetPassword');
  const { sessionFactories } = await import('./lib/session/index.js');
  const { createCredentialStuffingService, credentialStuffingFactories } =
    await import('./lib/credentialStuffing');
  const { createLockoutService, lockoutRepositoryFactories } = await import('./lib/accountLockout');
  const { createAuthRateLimitService, authRateLimitFactories } =
    await import('./lib/authRateLimit');

  const getRedis =
    runtimeInfra.getRedis ??
    (() => {
      throw new Error('[slingshot-auth] Redis not configured');
    });
  const getMongoApp = runtimeInfra.getMongoApp ?? (() => null);

  const storeInfra: import('@lastshotlabs/slingshot-core').StoreInfra = {
    appName: resolvedConfig.appName,
    getRedis,
    getMongo: () => {
      const conn = getMongoApp();
      if (!conn) throw new Error('[slingshot-auth] Mongo app connection not configured');
      return { conn, mg: resolveMongoose() };
    },
    getSqliteDb: () => {
      if (!sqliteAdapter) throw new Error('[slingshot-auth] SQLite adapter not initialized');
      return sqliteAdapter.db;
    },
    getPostgres: () => {
      // Prefer framework-provided postgres (wired via runtimeInfra.getPostgres),
      // fall back to the pool created by the postgres auth adapter above.
      if (runtimeInfra.getPostgres) return runtimeInfra.getPostgres();
      if (postgres) return postgres;
      throw new Error('[slingshot-auth] Postgres is not configured');
    },
  };

  const oauthStateStore = resolveRepo(oauthStateFactories, stores.oauthState, storeInfra);
  const oauthCodeRepo = resolveRepo(oauthCodeFactories, stores.oauthState, storeInfra);
  const oauthReauthRepo = resolveRepo(oauthReauthFactories, stores.oauthState, storeInfra);
  const magicLinkRepo = resolveRepo(magicLinkFactories, stores.sessions, storeInfra);
  const deletionCancelTokenRepo = resolveRepo(
    deletionCancelTokenFactories,
    stores.sessions,
    storeInfra,
  );
  const mfaChallengeRepo = resolveRepo(mfaChallengeFactories, stores.sessions, storeInfra);
  const verificationTokenRepo = resolveRepo(
    verificationTokenFactories,
    stores.sessions,
    storeInfra,
  );
  const resetTokenRepo = resolveRepo(resetTokenFactories, stores.sessions, storeInfra);
  const sessionRepo = resolveRepo(sessionFactories, stores.sessions, storeInfra);

  if (authConfig.accountDeletion?.queued && enableAuthRoutes) {
    if (!queueFactory) {
      throw new Error('[slingshot-auth] accountDeletion.queued requires Redis and BullMQ.');
    }
    const workerAppName = config.appName ?? 'Bun Core API';
    const deletionConfig = authConfig.accountDeletion;
    const authHooks = authConfig.hooks;
    queueFactory.createWorker<{ userId: string }>(
      `${workerAppName}:account-deletions`,
      async job => {
        const { userId } = job.data;
        const workerAdapter = authAdapter;

        if (deletionConfig.onBeforeDelete) await deletionConfig.onBeforeDelete(userId);

        const sessions = await sessionRepo.getUserSessions(userId, resolvedConfig);
        await Promise.all(
          sessions.map(s => sessionRepo.deleteSession(s.sessionId, resolvedConfig)),
        );

        if (workerAdapter.deleteUser) await workerAdapter.deleteUser(userId);
        bus.emit('security.auth.account.deleted', { userId });
        events.publish(
          'auth:user.deleted',
          { userId },
          // Background queue worker — no originating HTTP request, set explicitly.
          { userId, actorId: userId, source: 'job', requestTenantId: null },
        );

        if (deletionConfig.onAfterDelete) await deletionConfig.onAfterDelete(userId);
        const postDeleteHook = authHooks?.postDeleteAccount;
        if (postDeleteHook) {
          Promise.resolve()
            .then(() => postDeleteHook({ userId }))
            .catch((e: unknown) =>
              console.error(
                '[lifecycle] postDeleteAccount hook error:',
                e instanceof Error ? e.message : String(e),
              ),
            );
        }
      },
      { concurrency: 1 },
    );
  }

  const rateLimitRepo = resolveRepo(authRateLimitFactories, securityStore, storeInfra);
  const rateLimitService: AuthRateLimitService = createAuthRateLimitService(rateLimitRepo);

  if (authConfig.rateLimit?.credentialStuffing) {
    const credentialStuffingRepo = resolveRepo(
      credentialStuffingFactories,
      securityStore,
      storeInfra,
    );
    credentialStuffingService = createCredentialStuffingService(
      authConfig.rateLimit.credentialStuffing,
      credentialStuffingRepo,
    );
  }

  if (authConfig.lockout) {
    const lockoutRepo = resolveRepo(lockoutRepositoryFactories, securityStore, storeInfra);
    lockoutService = createLockoutService(authConfig.lockout, lockoutRepo);
  }

  const { createSecurityGate } = await import('./lib/securityGate');
  const securityGate = createSecurityGate(
    rateLimitService,
    () => credentialStuffingService,
    () => lockoutService,
    {
      windowMs: authConfig.rateLimit?.login?.windowMs ?? 15 * 60 * 1000,
      max: authConfig.rateLimit?.login?.max ?? 10,
    },
  );

  // Warn if strictSignCount is explicitly disabled in production.
  if (authConfig.mfa?.webauthn && isProd() && !authConfig.mfa.webauthn.strictSignCount) {
    console.warn(
      '[slingshot] WebAuthn strictSignCount is disabled. Cloned authenticator keys will be accepted.',
    );
  }

  let samlRequestIdRepo: import('./lib/samlRequestId').SamlRequestIdRepository | null = null;
  if (authConfig.saml) {
    const { samlRequestIdFactories } = await import('./lib/samlRequestId');
    samlRequestIdRepo = resolveRepo(samlRequestIdFactories, stores.oauthState, storeInfra);
  }

  // Per-instance dummy hash getter — closure-owned, zero module-level state (Rule 3).
  const getDummyHash = makeDummyHashGetter(password);

  return {
    adapter: authAdapter,
    runtime: {
      adapter: authAdapter,
      evaluateUserAccess: async input => {
        const decision = await resolvedConfig.hooks.checkUserAccess?.({
          ...input,
          adapter: authAdapter,
          config: resolvedConfig,
        });
        if (decision === false) {
          return {
            allow: false,
            status: 403,
            message: 'Account access denied',
            code: 'account_access_denied',
            reason: 'account_access_denied',
          };
        }
        return decision;
      },
      eventBus: bus,
      events,
      config: resolvedConfig,
      stores,
      signing,
      dataEncryptionKeys,
      password,
      getDummyHash,
      oauth: {
        providers: resolvedOAuthProviders,
        stateStore: oauthStateStore,
      },
      lockout: lockoutService,
      rateLimit: rateLimitService,
      credentialStuffing: credentialStuffingService,
      securityGate,
      logger: authLogger,
      queueFactory,
      repos: {
        oauthCode: oauthCodeRepo,
        oauthReauth: oauthReauthRepo,
        magicLink: magicLinkRepo,
        deletionCancelToken: deletionCancelTokenRepo,
        mfaChallenge: mfaChallengeRepo,
        samlRequestId: samlRequestIdRepo,
        verificationToken: verificationTokenRepo,
        resetToken: resetTokenRepo,
        session: sessionRepo,
      },
    },
    configuredOAuthProviders: configuredOAuth,
    bearerAuthBypassPaths,
    oauthCallbackPaths,
    stores,
    teardownFns,
  };
}
