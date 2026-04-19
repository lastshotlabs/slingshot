import { z } from 'zod';

/**
 * Zod schema for the inline Redis connection-options object.
 *
 * Used when `db.redis` is supplied as a plain object rather than a connection
 * URL string or a boolean. Accepts a strict subset of ioredis `RedisOptions`.
 *
 * @remarks
 * Fields:
 * - `url` - Full Redis connection URL (for example `"redis://localhost:6379"`).
 *   Takes precedence over any environment-variable fallback when provided.
 * - `maxRetriesPerRequest` - Maximum number of times a single command will be
 *   retried on transient failure before the promise rejects.
 *
 * The schema uses `.loose()` in `dbSchema` so that additional ioredis options
 * survive validation without unknown-key warnings.
 */
export const redisObjectSchema = z.object({
  url: z.string().optional(),
  maxRetriesPerRequest: z.number().optional(),
});

/**
 * Zod schema for the `db.redis` field of `CreateServerConfig`.
 *
 * Accepts three forms:
 * - `true` - Enable Redis using the configured runtime/secrets path.
 * - `string` - Enable Redis using the supplied connection URL directly.
 * - `object` - Enable Redis with explicit connection options.
 *
 * @remarks
 * Setting `db.redis` to `false` or omitting it entirely disables Redis.
 */
export const redisSchema = z.union([z.boolean(), z.string(), redisObjectSchema.loose()]);

export const postgresPoolSchema = z.object({
  max: z.number().optional(),
  min: z.number().optional(),
  idleTimeoutMs: z.number().optional(),
  connectionTimeoutMs: z.number().optional(),
  queryTimeoutMs: z.number().optional(),
  statementTimeoutMs: z.number().optional(),
  maxUses: z.number().optional(),
  allowExitOnIdle: z.boolean().optional(),
  keepAlive: z.boolean().optional(),
  keepAliveInitialDelayMillis: z.number().optional(),
});

/**
 * Zod schema for the `db` section of `CreateAppConfig` / `CreateServerConfig`.
 *
 * Controls which storage backends are enabled and which backend each
 * cross-cutting concern (sessions, OAuth state, cache, auth) uses.
 *
 * @remarks
 * Fields:
 * - `sqlite` - Path to the SQLite database file.
 * - `mongo` - MongoDB connection mode: `"single"`, `"separate"`, or `false`.
 * - `redis` - Redis connection config; see {@link redisSchema}.
 * - `postgres` - Postgres connection string. Required when any selected store
 *   is `"postgres"`.
 * - `sessions` - Backend used to persist HTTP sessions.
 * - `oauthState` - Backend for short-lived OAuth PKCE/state tokens.
 * - `cache` - Backend for the general-purpose application cache.
 * - `auth` - Backend for user credentials and auth-related records. Does not
 *   accept `"redis"` because auth data must be durable.
 *
 * Constraints:
 * - `sessions`, `oauthState`, and `cache` may use `"postgres"` only when
 *   `postgres` is configured in this section.
 * - `sessions`, `oauthState`, and `cache` may use `"redis"` only when `redis`
 *   is configured in this section.
 * - `auth` does not accept `"redis"`.
 * - Referencing an unconfigured backend produces a startup error.
 *
 * @example
 * ```ts
 * db: {
 *   postgres: 'postgres://slingshot:test@localhost:5432/app',
 *   sessions: 'postgres',
 *   oauthState: 'postgres',
 *   cache: 'postgres',
 *   auth: 'postgres',
 * }
 * ```
 */
export const dbSchema = z.object({
  sqlite: z
    .string()
    .optional()
    .describe("Absolute path to the SQLite database file. Omit unless a store uses 'sqlite'."),
  mongo: z
    .union([z.enum(['single', 'separate']), z.literal(false)])
    .optional()
    .describe(
      'Mongo auto-connect mode. One of: single, separate, false. Omit to use the framework default.',
    ),
  redis: redisSchema
    .optional()
    .describe(
      'Redis connection toggle or configuration. Omit to use the framework default Redis behavior.',
    ),
  postgres: z
    .string()
    .optional()
    .describe("Postgres connection string. Omit unless a store uses 'postgres'."),
  postgresPool: postgresPoolSchema
    .optional()
    .describe('Postgres pool sizing and timeout options passed through to pg.Pool.'),
  postgresMigrations: z
    .enum(['apply', 'assume-ready'])
    .optional()
    .describe(
      'Postgres schema bootstrap strategy. Use "assume-ready" when migrations are managed externally.',
    ),
  sessions: z
    .enum(['redis', 'mongo', 'sqlite', 'memory', 'postgres'])
    .optional()
    .describe(
      'Persistence backend for sessions. One of: redis, mongo, sqlite, memory, postgres. Omit to use the framework default.',
    ),
  oauthState: z
    .enum(['redis', 'mongo', 'sqlite', 'memory', 'postgres'])
    .optional()
    .describe(
      'Persistence backend for OAuth state. One of: redis, mongo, sqlite, memory, postgres. Omit to follow the sessions store.',
    ),
  cache: z
    .enum(['redis', 'mongo', 'sqlite', 'memory', 'postgres'])
    .optional()
    .describe(
      'Persistence backend for cache-like framework state. One of: redis, mongo, sqlite, memory, postgres. Omit to use the framework default.',
    ),
  auth: z
    .enum(['mongo', 'sqlite', 'memory', 'postgres'])
    .optional()
    .describe(
      'Persistence backend for the built-in auth adapter. One of: mongo, sqlite, memory, postgres. Omit to use the framework default.',
    ),
});
