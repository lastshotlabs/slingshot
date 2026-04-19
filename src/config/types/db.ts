import type { PostgresMigrationMode, StoreType } from '@lastshotlabs/slingshot-core';

export interface RedisConnectionOptions {
  /**
   * Redis connection URL.
   * When present, this is the canonical connection target for Redis.
   */
  url?: string;
  /**
   * Maximum number of retries per request for the Redis client.
   * Omit to use the client default.
   */
  maxRetriesPerRequest?: number;
}

export interface PostgresPoolConfig {
  /**
   * Maximum number of clients in the Postgres pool.
   * Omit to use the pg default.
   */
  max?: number;
  /**
   * Minimum number of clients to keep warm in the Postgres pool.
   * Omit to use the pg default.
   */
  min?: number;
  /**
   * Milliseconds an idle client may remain in the pool before eviction.
   */
  idleTimeoutMs?: number;
  /**
   * Milliseconds to wait when establishing a new Postgres connection.
   */
  connectionTimeoutMs?: number;
  /**
   * Milliseconds to allow an individual query before pg aborts it client-side.
   */
  queryTimeoutMs?: number;
  /**
   * Milliseconds to allow a statement on the server before PostgreSQL cancels it.
   */
  statementTimeoutMs?: number;
  /**
   * Maximum number of uses before a client is recycled.
   */
  maxUses?: number;
  /**
   * Allow Node to exit while clients remain idle in the pool.
   */
  allowExitOnIdle?: boolean;
  /**
   * Enable TCP keepalive on Postgres sockets.
   */
  keepAlive?: boolean;
  /**
   * Delay before the first TCP keepalive probe, in milliseconds.
   */
  keepAliveInitialDelayMillis?: number;
}

export interface DbConfig {
  /**
   * Absolute path to the SQLite database file.
   * Required when any store is "sqlite".
   * Example: import.meta.dir + "/../data.db"
   */
  sqlite?: string;
  /**
   * MongoDB auto-connect mode. Defaults to "single".
   * - "single": one server for both auth and app data. Reads: MONGO_USER, MONGO_PASSWORD, MONGO_HOST, MONGO_DB
   * - "separate": auth and app on different servers. Reads above + MONGO_AUTH_USER, MONGO_AUTH_PASSWORD, MONGO_AUTH_HOST, MONGO_AUTH_DB
   * - false: skip auto-connect entirely - no MongoDB secrets required
   */
  mongo?: 'single' | 'separate' | false;
  /**
   * Redis connection toggle or inline connection config.
   * - true: enable Redis using the configured secrets/runtime defaults
   * - string: Redis URL
   * - object: Redis URL plus client options
   * - false/undefined: disable Redis
   */
  redis?: boolean | string | RedisConnectionOptions;
  /**
   * Postgres connection string.
   * Required when any selected store is "postgres".
   */
  postgres?: string;
  /**
   * Postgres pool sizing and timeout options passed through to `pg.Pool`.
   */
  postgresPool?: PostgresPoolConfig;
  /**
   * Postgres schema bootstrap strategy.
   * - "apply": runtime-owned schema initialization and migrations
   * - "assume-ready": skip startup DDL because migrations are managed externally
   */
  postgresMigrations?: PostgresMigrationMode;
  /**
   * Where to store JWT sessions. Default: resolved framework default store.
   * Sessions are stored on the app-side persistence connection, not the auth connection.
   */
  sessions?: StoreType;
  /**
   * Where to store OAuth state (PKCE code verifier, link user ID). Default: follows `sessions`.
   */
  oauthState?: StoreType;
  /**
   * Global default store for cacheResponse middleware. Default: resolved framework default store.
   * Can be overridden per-route via cacheResponse({ store: "..." }).
   */
  cache?: StoreType;
  /**
   * Which built-in auth adapter to use for /auth/* routes.
   * - "mongo": Mongoose adapter
   * - "sqlite": bun:sqlite adapter
   * - "memory": in-memory Maps
   * - "postgres": Postgres adapter
   * When `mongo: false`, defaults to the same store as `sessions`.
   * Ignored when `auth.adapter` is explicitly passed in CreateAppConfig.
   */
  auth?: 'mongo' | 'sqlite' | 'memory' | 'postgres';
}
