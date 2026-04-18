// Redis connection management — no module-level mutable state.
//
// Phase 1 singleton elimination: connectRedis() returns the client directly
// instead of storing it in a module global. disconnectRedis() accepts the
// client as a parameter. Use getRedisFromApp(app) for context-aware access.
import { log } from '@framework/lib/logger';
import type { default as RedisClass, RedisOptions } from 'ioredis';
import { getContext } from '@lastshotlabs/slingshot-core';

function requireIoredis(): new (opts: RedisOptions) => RedisClass {
  try {
    // Bun supports require() in ESM; this defers the import to call time
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require('ioredis') as unknown as {
      default?: new (opts: RedisOptions) => RedisClass;
    } & (new (opts: RedisOptions) => RedisClass);
    return mod.default ?? mod;
  } catch {
    throw new Error('ioredis is not installed. Run: bun add ioredis');
  }
}

export interface RedisCredentials {
  /** Redis host:port (e.g., "localhost:6379") */
  host: string;
  /** Redis username */
  user?: string;
  /** Redis password */
  password?: string;
}

export const getRedisConnectionOptions = (creds: RedisCredentials): RedisOptions => {
  const hostPort = creds.host;
  if (!hostPort) throw new Error('Missing Redis host — pass credentials via SecretRepository');
  const [host, port] = hostPort.split(':');
  if (!host || !port)
    throw new Error(`Invalid Redis host format — expected "host:port", got "${hostPort}"`);

  const username = creds.user;
  const password = creds.password;

  return {
    host,
    port: Number(port),
    ...(username && { username }),
    ...(password && { password }),
  };
};

/**
 * Connect to Redis and return the client.
 * The caller is responsible for storing the client (e.g., on SlingshotContext).
 *
 * @param creds Credentials resolved by SecretRepository. No process.env fallback.
 */
export const connectRedis = (creds: RedisCredentials): Promise<RedisClass> => {
  const Redis = requireIoredis();
  const opts = getRedisConnectionOptions(creds);
  const client = new Redis(opts);
  client.on('error', err => log(`[redis] error: ${err.message}`));
  return new Promise((resolve, reject) => {
    client.once('ready', () => {
      log(`[redis] connected to ${opts.host}:${opts.port} as ${opts.username || 'default user'}`);
      resolve(client);
    });
    client.once('error', reject);
  });
};

/**
 * Gracefully close the Redis connection.
 * Accepts the client as parameter — no module-level state.
 */
export const disconnectRedis = async (client: RedisClass | null): Promise<void> => {
  if (!client) return;
  await client.quit();
  log('[redis] disconnected');
};

/**
 * Context-aware Redis getter. Returns the instance-scoped Redis from
 * SlingshotContext, or null when Redis is not configured on the context.
 * Throws if no SlingshotContext is attached to the app.
 */
export const getRedisFromApp = (app: object): RedisClass | null => {
  const ctx = getContext(app);
  return ctx.redis as RedisClass | null;
};
