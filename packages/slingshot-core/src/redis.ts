/**
 * Canonical Redis client interface used across all slingshot packages.
 *
 * Concrete implementations (ioredis, Upstash Redis, etc.) satisfy this contract.
 * Typed as an interface rather than a class so that any Redis-compatible client
 * can be used without an adapter layer.
 *
 * @remarks
 * `getdel` is optional because it is not supported by all Redis versions (requires Redis 6.2+).
 * Framework code that calls `getdel` should fall back to `GET`+`DEL` when it is absent.
 *
 * @example
 * ```ts
 * import Redis from 'ioredis';
 * import type { RedisLike } from '@lastshotlabs/slingshot-core';
 *
 * const redis: RedisLike = new Redis(process.env.REDIS_URL);
 * ```
 */
export interface RedisLike {
  get(key: string): Promise<string | null>;
  /**
   * Get multiple keys in a single round-trip.
   * @returns An array of the same length as `keys`. Each position contains the stored
   *   string for the corresponding key, or `null` if the key does not exist (or has
   *   expired). The result array is positionally aligned — `result[i]` corresponds to
   *   `keys[i]`. A `null` in the result does NOT indicate an error; it means the key is
   *   absent.
   */
  mget(...keys: string[]): Promise<Array<string | null>>;
  set(key: string, value: string, ...args: unknown[]): Promise<unknown>;
  setex(key: string, seconds: number, value: string): Promise<unknown>;
  del(...keys: string[]): Promise<number>;
  expire(key: string, seconds: number): Promise<number>;
  keys(pattern: string): Promise<string[]>;
  // Sorted set operations
  zrange(key: string, start: number, stop: number): Promise<string[]>;
  zadd(key: string, score: number, member: string): Promise<number>;
  zrem(key: string, ...members: string[]): Promise<number>;
  // List operations
  lpush(key: string, value: string): Promise<number>;
  ltrim(key: string, start: number, stop: number): Promise<string>;
  lrange(key: string, start: number, stop: number): Promise<string[]>;
  getdel?(key: string): Promise<string | null>;
  /**
   * Incrementally iterate over keys matching a pattern.
   * @returns A tuple `[cursor, keys]` where `cursor` is the next scan cursor (an opaque
   *   string) and `keys` is the batch of matching key names returned in this iteration.
   *   When the returned `cursor` is `'0'`, the full keyspace has been scanned and iteration
   *   is complete. Pass `cursor` back into the next `scan()` call to continue iterating.
   *   Additional `args` follow the ioredis convention: `'MATCH', pattern, 'COUNT', batchSize`.
   */
  scan(cursor: string | number, ...args: unknown[]): Promise<[string, string[]]>;
  /**
   * Execute a Lua script atomically on the Redis server.
   * @param script - A Lua script string. Use `KEYS[i]` and `ARGV[i]` to reference keys
   *   and arguments passed in the remaining parameters.
   * @param numkeys - The number of key arguments that follow (consumed from `args`
   *   as `KEYS`; remaining `args` become `ARGV`).
   * @param args - Key names (first `numkeys` entries) followed by arbitrary string arguments.
   * @returns The Lua return value, typed `unknown`. The actual type depends on the script:
   *   Redis Lua can return integers, bulk strings, arrays, or nil (mapped to `null`).
   *   Cast the result at the call site once you know the script's return type.
   */
  eval(script: string, numkeys: number, ...args: unknown[]): Promise<unknown>;
}
