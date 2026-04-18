/**
 * Redis integration entrypoint.
 *
 * Re-exports all Redis connection helpers from the framework's internal `lib/redis`
 * module. Import from this entrypoint rather than reaching into internal paths.
 * Requires `ioredis` to be installed (`bun add ioredis`).
 *
 * **Connection management**
 * - {@link connectRedis} — open a Redis connection from credentials and return the
 *   ioredis client. No module-level state is stored; callers own the returned client.
 * - {@link disconnectRedis} — gracefully quit the Redis client.
 * - {@link getRedisConnectionOptions} — translate a `RedisCredentials` object to an
 *   ioredis `RedisOptions` object. Useful for custom connection setup.
 * - {@link getRedisFromApp} — retrieve the live ioredis client from app context
 *   (`SlingshotContext.redis`).
 *
 * @example
 * ```ts
 * import { connectRedis, getRedisFromApp } from '@lastshotlabs/slingshot/redis';
 *
 * const redis = await connectRedis({ host: 'localhost:6379', password: 'secret' });
 * // Later, inside a route handler:
 * const client = getRedisFromApp(app);
 * ```
 */

export {
  connectRedis,
  disconnectRedis,
  getRedisConnectionOptions,
  getRedisFromApp,
} from '../lib/redis';
