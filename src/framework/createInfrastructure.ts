/**
 * Infrastructure creation — extracted from createApp().
 *
 * Handles database connections, store resolution, trust-proxy configuration,
 * and the frameworkConfig object that is passed to all plugin lifecycle methods.
 *
 * Phase 1 singleton elimination: connect functions return connections directly.
 * No module-level state is read or set.
 */
// ---------------------------------------------------------------------------
// NOTE FOR MAINTAINERS
//
// Assembly sequence inside createInfrastructure():
//   1. Resolve store preferences (sessions, oauthState, cache, authStore).
//      Falls back: redis > postgres > sqlite > mongo > memory.
//   2. Connect MongoDB (single or separate mode) if db.mongo is set.
//   3. Connect Redis if db.redis is true.
//   4. Connect Postgres if db.postgres connection string is provided.
//   5. Resolve data-encryption keys from secrets.
//   6. Build the ResolvedStores object.
//   7. Create the EntityRegistry.
//   8. Assemble the FrameworkConfig object passed to every plugin lifecycle.
//   9. Resolve framework persistence repositories (upload registry, idempotency,
//      WebSocket messages, audit log, cron registry) via resolveFrameworkPersistence().
//  10. Return InfrastructureResult with every connection handle, so callers can
//      wire them into SlingshotContext and plugin lifecycle.
// ---------------------------------------------------------------------------
import { createAuditLogFactories } from '@framework/auditLog';
import type { AuditLogStore } from '@framework/auditLog';
import { cronRegistryFactories } from '@framework/persistence/cronRegistry';
import { idempotencyFactories } from '@framework/persistence/idempotency';
import { createUploadRegistryFactories } from '@framework/persistence/uploadRegistry';
import { wsMessageFactories } from '@framework/persistence/wsMessages';
import type { frameworkSecretSchema } from '@framework/secrets/frameworkSecretSchema';
import { connectAppMongo, connectAuthMongo, connectMongo } from '@lib/mongo';
import { connectRedis } from '@lib/redis';
import { getDataEncryptionKeys } from '@lib/signingConfig';
import type { SigningConfig } from '@lib/signingConfig';
import type { Connection } from 'mongoose';
import type {
  CaptchaConfig,
  CoreRegistrar,
  CsrfConfig,
  DataEncryptionKey,
  EntityRegistry,
  ResolvedPersistence,
  ResolvedSecrets,
  ResolvedStores,
  RuntimeSqliteDatabase,
  SlingshotFrameworkConfig,
  SlingshotRuntime,
  StoreInfra,
  StoreType,
  WsMessageDefaults,
} from '@lastshotlabs/slingshot-core';
import {
  createEntityRegistry,
  deepFreeze,
  resolveRepo,
  resolveRepoAsync,
} from '@lastshotlabs/slingshot-core';
import type { DrizzlePostgresDb } from '@lastshotlabs/slingshot-postgres';
import type { DbConfig as AppDbConfig } from '../config/types/db';
import type { LoggingConfig } from '../config/types/logging';
import { resolveLoggingConfig } from '../config/types/logging';
import { resolveMongoMode } from './dbDefaults';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type { ResolvedStores };

/**
 * The framework configuration object passed to every plugin lifecycle phase.
 *
 * Extends `SlingshotFrameworkConfig` with concrete connection handles that are
 * resolved at startup. Plugins receive this as an argument to `setupMiddleware`,
 * `setupRoutes`, and `setupPost` — they must not mutate it.
 *
 * @see SlingshotFrameworkConfig
 */
export interface FrameworkConfig extends SlingshotFrameworkConfig {
  /** Active Mongoose connections, or `undefined` when MongoDB is disabled. */
  mongo: { auth: Connection | null; app: Connection | null } | undefined;
  /** CAPTCHA configuration, or `null` when CAPTCHA is not configured. */
  captcha: CaptchaConfig | null;
  /** Opaque WebSocket config draft exposed to plugins during bootstrap. */
  ws?: unknown;
  /** The CoreRegistrar used to register framework-level services. */
  registrar: CoreRegistrar;
  /** The entity registry plugins use to discover and look up entity configs at runtime. */
  entityRegistry: EntityRegistry;
}

/**
 * All outputs produced by `createInfrastructure()`.
 *
 * The caller (`createApp`) is responsible for binding these into the
 * `SlingshotContext` and passing them to plugin lifecycle methods.
 */
export interface InfrastructureResult {
  /** The frameworkConfig object passed to plugin lifecycle methods. */
  frameworkConfig: FrameworkConfig;
  /** Resolved store selections for sessions, OAuth state, cache, and auth. */
  resolvedStores: ResolvedStores;
  /** `true` when Redis connected successfully and is available as a store. */
  redisEnabled: boolean;
  /** The MongoDB connection mode that was used, or `false` when Mongo is disabled. */
  mongoMode: 'single' | 'separate' | false;
  /** Data encryption keys resolved from the `DATA_ENCRYPTION_KEY` secret. */
  dataEncryptionKeys: DataEncryptionKey[];
  /** CORS allowed origins — `'*'` by default, or the value of `InfrastructureOptions.cors`. */
  corsOrigins: string | readonly string[];
  /** Framework persistence repositories (upload registry, idempotency, WS messages, etc.). */
  persistence: ResolvedPersistence;
  /** Open SQLite database handle, or `null` when SQLite is not configured. */
  sqliteDb: RuntimeSqliteDatabase | null;
  /** ioredis client instance, or `null` when Redis is disabled. */
  redis: import('ioredis').default | null;
  /** Active Mongoose connection handles plus the mongoose module, or `null` when Mongo is disabled. */
  mongo: {
    auth: Connection | null;
    app: Connection | null;
    mongoose: typeof import('mongoose');
  } | null;
  /** Drizzle-wrapped Postgres connection, or `null` when Postgres is not configured. */
  postgres: DrizzlePostgresDb | null;
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

/**
 * Options passed to `createInfrastructure()`.
 *
 * All sensitive credentials come from `secrets` — none of these fields
 * read from `process.env` directly.
 */
export interface InfrastructureOptions {
  /** Database backend configuration: which backends to enable and how to assign per-feature stores. */
  db: AppDbConfig;
  /** Signing config for JWT and cookie signing. Pass `null` to disable signing. */
  securitySigning?: SigningConfig | null;
  /**
   * CORS policy. Accepts a single origin string, an array of origins, or a
   * full CORS options object with `origin`, `credentials`, `allowHeaders`, etc.
   * Defaults to `'*'` when omitted.
   *
   * When an object is provided, only the `origin` field is extracted for storage
   * in `SlingshotContext.config.security.cors`. The full CORS options are applied
   * by `mountFrameworkMiddleware` which reads from `securityConfig.cors` directly.
   */
  cors?:
    | string
    | string[]
    | {
        origin: string | string[];
        credentials?: boolean;
        allowHeaders?: string[];
        exposeHeaders?: string[];
        maxAge?: number;
      };
  /** CAPTCHA (e.g. hCaptcha or Turnstile) configuration. Omit to disable CAPTCHA. */
  captcha?: CaptchaConfig;
  /** Resolved logging configuration shared with plugins and framework repositories. */
  logging?: LoggingConfig;
  /** Opaque WebSocket config draft forwarded into plugin bootstrap context. */
  ws?: unknown;
  /** CSRF settings forwarded to plugin lifecycle config. */
  csrf?: CsrfConfig;
  /**
   * Number of reverse-proxy hops to trust for `X-Forwarded-For`.
   * Pass `false` to disable trust-proxy entirely. Defaults to `false`.
   */
  trustProxy?: false | number;
  /** CoreRegistrar for framework-level service registration. */
  registrar: CoreRegistrar;
  /**
   * Resolved framework secrets from SecretRepository.
   * Credentials are passed directly to connect functions — no `process.env` fallback.
   */
  secrets: ResolvedSecrets<typeof frameworkSecretSchema>;
  /**
   * TTL in seconds for upload registry entries.
   * @default 2592000 (30 days)
   */
  uploadRegistryTtlSeconds?: number;
  /**
   * Retention in days for audit log entries.
   * - SQLite: prunes expired entries on each write.
   * - MongoDB: sets `expiresAt` used by MongoDB's TTL index.
   * - `undefined`: no automatic pruning.
   */
  auditLogTtlDays?: number;
  /** Runtime abstraction for database, password hashing, filesystem, glob, and HTTP server APIs. */
  runtime: SlingshotRuntime;
  /**
   * App-level health configuration. Indicators are stored on the framework
   * config so the `/health/ready` route can run them on every request.
   */
  health?: import('@lastshotlabs/slingshot-core').HealthAppConfig;
}

function freezeArrayCopy<T>(value: readonly T[]): readonly T[] {
  return Object.freeze([...value]);
}

function cloneAndFreezeConfig<T extends object>(value: T | null | undefined): Readonly<T> | null {
  if (!value) return null;
  return deepFreeze(structuredClone(value));
}

interface OpenInfrastructureHandles {
  mongoMode: 'single' | 'separate' | false;
  authConn: Connection | null;
  appConn: Connection | null;
  redisClient: import('ioredis').default | null;
  postgresDb: DrizzlePostgresDb | null;
  sqliteDb: RuntimeSqliteDatabase | null;
}

async function cleanupOpenInfrastructure(handles: OpenInfrastructureHandles): Promise<void> {
  const { mongoMode, authConn, appConn, redisClient, postgresDb, sqliteDb } = handles;

  if (sqliteDb) {
    try {
      sqliteDb.close();
    } catch {
      /* best-effort */
    }
  }

  if (postgresDb) {
    try {
      await postgresDb.pool.end();
    } catch {
      /* best-effort */
    }
  }

  if (redisClient) {
    try {
      const { disconnectRedis } = await import('@lib/redis');
      if (typeof disconnectRedis === 'function') {
        await disconnectRedis(redisClient);
      }
    } catch {
      /* best-effort */
    }
  }

  if (mongoMode !== false && (authConn || appConn)) {
    try {
      const { disconnectMongo } = await import('@lib/mongo');
      if (typeof disconnectMongo === 'function') {
        await disconnectMongo(authConn, appConn);
      }
    } catch {
      /* best-effort */
    }
  }
}

/**
 * Connect databases, resolve store preferences, and assemble the infrastructure
 * objects that power every slingshot application instance.
 *
 * @remarks
 * **Assembly sequence:**
 * 1. Determine the `defaultStore` using smart fallback: Redis → Postgres → SQLite → Mongo → Memory.
 * 2. Resolve per-feature store overrides (`sessions`, `oauthState`, `cache`, `authStore`).
 * 3. Connect MongoDB in `single` or `separate` mode if `db.mongo` is set.
 * 4. Connect Redis if `db.redis` is `true` (requires `REDIS_HOST` secret).
 * 5. Connect Postgres if `db.postgres` connection string is provided (lazy dynamic import).
 * 6. Derive `dataEncryptionKeys` from `secrets.dataEncryptionKey`.
 * 7. Build `ResolvedStores` and the `EntityRegistry`.
 * 8. Assemble `FrameworkConfig` — the frozen config object plugins receive in lifecycle methods.
 * 9. Call `resolveFrameworkPersistence()` to instantiate upload registry, idempotency,
 *    WebSocket messages, audit log, and cron registry repositories.
 * 10. Return `InfrastructureResult` with every connection handle for the caller to bind.
 *
 * @param options - Database backends, secrets, runtime, and feature configuration.
 * @returns All connection handles, the framework config, and resolved persistence repositories.
 * @throws {Error} When a required secret is missing for an enabled backend (Mongo, Redis).
 *
 * @example
 * ```ts
 * const infra = await createInfrastructure({
 *   db: { mongo: 'single', redis: true },
 *   secrets: resolvedSecrets,
 *   registrar,
 *   runtime,
 * });
 * // infra.frameworkConfig is passed to plugin lifecycle methods
 * // infra.redis, infra.mongo, infra.postgres are the raw connection handles
 * ```
 */
export async function createInfrastructure(
  options: InfrastructureOptions,
): Promise<InfrastructureResult> {
  const {
    db,
    securitySigning,
    cors: corsOpt,
    captcha,
    logging,
    ws,
    csrf,
    trustProxy,
    registrar,
    secrets,
    health: appHealth,
    uploadRegistryTtlSeconds,
    auditLogTtlDays,
    runtime,
  } = options;
  const { sqlite } = db;
  const enableRedis = db.redis !== false;
  const mongo = resolveMongoMode(db);

  // Normalize: when cors is an object extract just the origin for context storage.
  // The full cors config (with credentials, allowHeaders, etc.) is applied by
  // mountFrameworkMiddleware via securityConfig.cors — that path handles all shapes.
  const rawCorsOrigins: string | string[] =
    corsOpt === undefined
      ? '*'
      : typeof corsOpt === 'string' || Array.isArray(corsOpt)
        ? corsOpt
        : corsOpt.origin;
  const corsOrigins: string | readonly string[] = Array.isArray(rawCorsOrigins)
    ? freezeArrayCopy(rawCorsOrigins)
    : rawCorsOrigins;
  const resolvedLogging = resolveLoggingConfig(logging);

  // Smart fallback: pick the best available store rather than blindly defaulting to "redis"
  const defaultStore: StoreType = enableRedis
    ? 'redis'
    : db.postgres
      ? 'postgres'
      : sqlite
        ? 'sqlite'
        : mongo !== false
          ? 'mongo'
          : 'memory';

  const sessions = db.sessions ?? defaultStore;
  const oauthState = db.oauthState ?? sessions;
  const cache = db.cache ?? defaultStore;
  const authStore = db.auth ?? (mongo !== false ? 'mongo' : sessions);

  // Connect databases — connect functions return connections directly (no module-level state)
  let authConn: Connection | null = null;
  let appConn: Connection | null = null;
  let mongooseModule: typeof import('mongoose') | null = null;
  let redisClient: import('ioredis').default | null = null;
  let postgresDb: DrizzlePostgresDb | null = null;
  let sqliteDb: RuntimeSqliteDatabase | null = null;

  try {
    if (mongo === 'single') {
      const {
        mongoUrl: url,
        mongoUser: user,
        mongoPassword: password,
        mongoHost: host,
        mongoDb: dbName,
      } = secrets;
      if (url) {
        const result = await connectMongo({ url });
        authConn = result.authConn;
        appConn = result.appConn;
        mongooseModule = result.mongoose;
      } else if (!user || !password || !host || !dbName) {
        throw new Error(
          '[slingshot] MongoDB is enabled (db.mongo="single") but required secrets are missing. ' +
            'Provide MONGO_URL, or MONGO_USER, MONGO_PASSWORD, MONGO_HOST, and MONGO_DB.',
        );
      } else {
        const result = await connectMongo({ user, password, host, db: dbName });
        authConn = result.authConn;
        appConn = result.appConn;
        mongooseModule = result.mongoose;
      }
    } else if (mongo === 'separate') {
      const {
        mongoUser: user,
        mongoPassword: password,
        mongoHost: host,
        mongoDb: dbName,
        mongoAuthUser: authUser,
        mongoAuthPassword: authPassword,
        mongoAuthHost: authHost,
        mongoAuthDb: authDbName,
      } = secrets;
      if (!user || !password || !host || !dbName) {
        throw new Error(
          '[slingshot] MongoDB app connection is enabled (db.mongo="separate") but required secrets are missing. ' +
            'Provide MONGO_USER, MONGO_PASSWORD, MONGO_HOST, and MONGO_DB.',
        );
      }
      if (!authUser || !authPassword || !authHost || !authDbName) {
        throw new Error(
          '[slingshot] MongoDB auth connection is enabled (db.mongo="separate") but required secrets are missing. ' +
            'Provide MONGO_AUTH_USER, MONGO_AUTH_PASSWORD, MONGO_AUTH_HOST, and MONGO_AUTH_DB.',
        );
      }
      const authResult = await connectAuthMongo({
        user: authUser,
        password: authPassword,
        host: authHost,
        db: authDbName,
      });
      authConn = authResult.authConn;
      mongooseModule = authResult.mongoose;

      const appResult = await connectAppMongo({ user, password, host, db: dbName });
      appConn = appResult.appConn;
    }

    if (enableRedis) {
      if (!secrets.redisHost) {
        throw new Error('[slingshot] Redis is enabled but REDIS_HOST secret is missing.');
      }
      redisClient = await connectRedis({
        host: secrets.redisHost,
        user: secrets.redisUser,
        password: secrets.redisPassword,
      });
    }

    if (db.postgres) {
      const { connectPostgres } = await import('@lastshotlabs/slingshot-postgres');
      postgresDb = await connectPostgres(db.postgres, {
        pool: db.postgresPool,
        migrations: db.postgresMigrations,
        healthcheckTimeoutMs: db.postgresPool?.queryTimeoutMs,
      });
    }

    /**
     * Return the resolved mongoose module, throwing if it was never initialized.
     * Called only when `mongo !== false`, so the error path is a programming error.
     *
     * @throws {Error} When called with `db.mongo` set but the module failed to initialize.
     */
    function getMongooseOrThrow(): typeof import('mongoose') {
      if (!mongooseModule) throw new Error('[framework] Mongoose module not initialized');
      return mongooseModule;
    }

    function getAppConnOrThrow(): Connection {
      if (!appConn) throw new Error('[framework] MongoDB app connection not initialized');
      return appConn;
    }

    const dataEncryptionKeys = getDataEncryptionKeys(secrets.dataEncryptionKey || undefined);
    const frozenSigning = cloneAndFreezeConfig(securitySigning);
    const frozenCaptcha = cloneAndFreezeConfig(captcha);
    const frozenMongo =
      mongo !== false ? Object.freeze({ auth: authConn, app: appConn }) : undefined;

    const resolvedStores: ResolvedStores = {
      sessions,
      oauthState,
      cache,
      authStore,
      sqlite,
    };
    const frozenResolvedStores = Object.freeze({ ...resolvedStores });
    const frozenDataEncryptionKeys = freezeArrayCopy(dataEncryptionKeys);

    // Create the entity registry — plugins discover entities through this at runtime.
    const entityRegistry = createEntityRegistry();

    // Resolve persistence repositories based on the default store selection.
    // Must happen before building frameworkConfig so storeInfra is available.
    const resolvedPersistence = await resolveFrameworkPersistence({
      defaultStore,
      redis: redisClient,
      mongo: mongo !== false ? { conn: getAppConnOrThrow(), mongoose: getMongooseOrThrow() } : null,
      sqlite,
      postgres: postgresDb,
      appName: '', // set later — not needed for persistence key prefixing at this level
      uploadRegistryTtlSeconds,
      auditLogTtlDays,
      auditWarnings: resolvedLogging.auditWarnings,
      runtime,
    });
    sqliteDb = resolvedPersistence.sqliteDb;

    // Build the config object passed to all plugin phase methods.
    // Constructed after resolveFrameworkPersistence so storeInfra is available.
    const frameworkConfig: FrameworkConfig = {
      resolvedStores: frozenResolvedStores,
      logging: Object.freeze({ ...resolvedLogging }),
      security: Object.freeze({
        cors: corsOrigins,
        csrf: csrf
          ? {
              ...csrf,
              exemptPaths: csrf.exemptPaths ? freezeArrayCopy(csrf.exemptPaths) : undefined,
            }
          : undefined,
      }),
      signing: frozenSigning,
      dataEncryptionKeys: frozenDataEncryptionKeys,
      redis: redisClient ?? undefined,
      mongo: frozenMongo,
      captcha: frozenCaptcha,
      ws,
      trustProxy: trustProxy ?? false,
      registrar,
      entityRegistry,
      password: runtime.password,
      sqlite: runtime.sqlite,
      storeInfra: resolvedPersistence.storeInfra,
      health: appHealth
        ? Object.freeze({
            indicators: appHealth.indicators ? freezeArrayCopy(appHealth.indicators) : undefined,
          })
        : undefined,
    };

    return {
      frameworkConfig,
      resolvedStores,
      redisEnabled: enableRedis,
      mongoMode: mongo,
      dataEncryptionKeys: [...frozenDataEncryptionKeys],
      corsOrigins,
      persistence: resolvedPersistence.persistence,
      sqliteDb,
      redis: redisClient,
      mongo:
        mongo !== false ? { auth: authConn, app: appConn, mongoose: getMongooseOrThrow() } : null,
      postgres: postgresDb,
    };
  } catch (error) {
    await cleanupOpenInfrastructure({
      mongoMode: mongo,
      authConn,
      appConn,
      redisClient,
      postgresDb,
      sqliteDb,
    });
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Persistence resolution
// ---------------------------------------------------------------------------

interface PersistenceResolutionOptions {
  defaultStore: StoreType;
  redis: import('ioredis').default | null;
  mongo: { conn: Connection; mongoose: typeof import('mongoose') } | null;
  sqlite: string | undefined;
  postgres: DrizzlePostgresDb | null;
  appName: string;
  uploadRegistryTtlSeconds?: number;
  auditLogTtlDays?: number;
  auditWarnings: boolean;
  runtime: SlingshotRuntime;
}

/**
 * Instantiate framework persistence repositories against the resolved default store.
 *
 * Creates repository instances for: upload registry, idempotency, WebSocket messages,
 * audit log, and cron registry. The audit log uses a more conservative store selection
 * (Redis maps to memory since Redis is not a reliable audit log store).
 *
 * Also opens the SQLite database file if SQLite is configured, and owns its lifecycle:
 * if any repository instantiation throws, the SQLite handle is closed before re-throwing
 * to avoid holding the file lock.
 *
 * @param opts - Connection handles, store selection, and TTL configuration.
 * @returns The resolved persistence object and the raw SQLite database handle.
 * @throws {Error} When a repository factory requires a backend that is not connected.
 */
async function resolveFrameworkPersistence(opts: PersistenceResolutionOptions): Promise<{
  persistence: ResolvedPersistence;
  sqliteDb: RuntimeSqliteDatabase | null;
  storeInfra: StoreInfra;
}> {
  const {
    defaultStore,
    redis,
    mongo,
    sqlite,
    postgres,
    appName,
    uploadRegistryTtlSeconds,
    auditLogTtlDays,
    auditWarnings,
    runtime,
  } = opts;

  // Default room config state — owned by the persistence closure, instance-scoped
  const DEFAULT_MAX_COUNT = 100;
  const DEFAULT_TTL_SECONDS = 86_400;

  let defaults: Required<WsMessageDefaults> = {
    maxCount: DEFAULT_MAX_COUNT,
    ttlSeconds: DEFAULT_TTL_SECONDS,
  };
  const roomConfigs = new Map<string, { maxCount: number; ttlSeconds: number }>();
  const sqliteDb = sqlite ? runtime.sqlite.open(sqlite) : null;

  // If anything below throws (e.g. resolveRepo with an unsupported store), close the
  // SQLite handle before propagating — otherwise the file lock is held until GC.
  try {
    const storeInfra = {
      appName: appName || 'slingshot',
      getRedis: () => {
        if (!redis)
          throw new Error('[framework/persistence] Redis store selected but Redis is unavailable');
        return redis;
      },
      getMongo: () => {
        if (!mongo)
          throw new Error('[framework/persistence] Mongo store selected but Mongo is unavailable');
        return { conn: mongo.conn, mg: mongo.mongoose };
      },
      getSqliteDb: () => {
        if (!sqliteDb)
          throw new Error(
            '[framework/persistence] SQLite store selected but SQLite is unavailable',
          );
        return sqliteDb;
      },
      getPostgres: () => {
        if (!postgres)
          throw new Error(
            '[framework/persistence] Postgres store selected but Postgres is unavailable. Set db.postgres in your config.',
          );
        return postgres;
      },
    };
    const uploadRegistry = resolveRepo(
      createUploadRegistryFactories(uploadRegistryTtlSeconds),
      defaultStore,
      storeInfra,
    );
    const idempotency = resolveRepo(idempotencyFactories, defaultStore, storeInfra);
    const wsMessages = await resolveRepoAsync(wsMessageFactories, defaultStore, storeInfra);
    const cronRegistry = resolveRepo(cronRegistryFactories, defaultStore, storeInfra);

    const auditLogStoreMap: Record<StoreType, AuditLogStore> = {
      memory: 'memory',
      redis: 'memory',
      sqlite: 'sqlite',
      mongo: 'mongo',
      postgres: 'postgres',
    };
    const auditLogStore = auditLogStoreMap[defaultStore];
    const auditLog = resolveRepo(
      createAuditLogFactories(auditLogTtlDays, { emitWarnings: auditWarnings }),
      auditLogStore,
      storeInfra,
    );

    return {
      persistence: {
        uploadRegistry,
        idempotency,
        wsMessages,
        auditLog,
        cronRegistry,
        configureRoom(endpoint, room, options) {
          const key = `${endpoint}\0${room}`;
          if (!options.persist) {
            roomConfigs.delete(key);
            return;
          }
          roomConfigs.set(key, {
            maxCount: options.maxCount ?? defaults.maxCount,
            ttlSeconds: options.ttlSeconds ?? defaults.ttlSeconds,
          });
        },
        getRoomConfig(endpoint, room) {
          return roomConfigs.get(`${endpoint}\0${room}`) ?? null;
        },
        setDefaults(newDefaults) {
          defaults = {
            maxCount: newDefaults.maxCount ?? DEFAULT_MAX_COUNT,
            ttlSeconds: newDefaults.ttlSeconds ?? DEFAULT_TTL_SECONDS,
          };
        },
      },
      sqliteDb,
      storeInfra,
    };
  } catch (err) {
    sqliteDb?.close();
    throw err;
  }
}
