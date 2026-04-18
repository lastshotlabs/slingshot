/**
 * Postgres-backed boundary cache adapter.
 *
 * Stores cache entries in the `cache_entries` table with TTL support.
 * Expired entries are filtered at read time and periodically swept by a
 * background interval. Pattern deletion converts glob patterns to SQL
 * `LIKE` expressions.
 */
import type { Pool } from 'pg';
import type { CacheAdapter } from '@lastshotlabs/slingshot-core';

/** Background cleanup interval in milliseconds (60 seconds). */
const CLEANUP_INTERVAL_MS = 60_000;

/**
 * Convert a glob pattern to a SQL `LIKE` pattern.
 *
 * Steps:
 * 1. Escape SQL `LIKE` metacharacters (`%`, `_`, `\`) so they match literally.
 * 2. Replace glob `*` with `%` (match any sequence).
 * 3. Replace glob `?` with `_` (match single character).
 *
 * @param pattern - A glob-style pattern where `*` matches any sequence and `?`
 *   matches a single character.
 * @returns The equivalent SQL `LIKE` pattern.
 */
function globToLike(pattern: string): string {
  return pattern
    .replace(/[%_\\]/g, '\\$&') // escape LIKE metacharacters
    .replace(/\*/g, '%') // glob * -> LIKE %
    .replace(/\?/g, '_'); // glob ? -> LIKE _
}

/**
 * Create a `CacheAdapter` backed by a Postgres connection pool.
 *
 * Stores cache entries in the `cache_entries` table. TTL expiry is enforced at
 * read time (expired entries return `null`) and by a periodic background sweep.
 * Pattern deletion converts glob patterns to SQL `LIKE` expressions.
 *
 * The factory is async — it runs `CREATE TABLE IF NOT EXISTS` and
 * `CREATE INDEX IF NOT EXISTS` before returning the adapter. A background
 * interval sweeps expired entries every 60 seconds; the timer is `unref()`'d
 * so it does not prevent process exit.
 *
 * @param pool - A `pg.Pool` instance from the shared Postgres connection.
 * @returns A promise that resolves to a `CacheAdapter` backed by Postgres.
 */
export async function createPostgresCacheAdapter(pool: Pool): Promise<CacheAdapter> {
  let ready = false;

  // Create table and index
  await pool.query(`
    CREATE TABLE IF NOT EXISTS cache_entries (
      key         TEXT        PRIMARY KEY,
      value       TEXT        NOT NULL,
      expires_at  TIMESTAMPTZ
    )
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_cache_entries_expires
      ON cache_entries (expires_at)
      WHERE expires_at IS NOT NULL
  `);

  ready = true;

  // Background cleanup: delete expired entries every 60 seconds
  const cleanupTimer = setInterval(async () => {
    try {
      await pool.query(
        'DELETE FROM cache_entries WHERE expires_at IS NOT NULL AND expires_at <= NOW()',
      );
    } catch {
      // Best-effort cleanup — swallow errors to avoid crashing the process
    }
  }, CLEANUP_INTERVAL_MS);

  // Allow the process to exit even if the timer is still scheduled
  if (typeof cleanupTimer === 'object' && 'unref' in cleanupTimer) {
    cleanupTimer.unref();
  }

  return {
    name: 'postgres',

    async get(key: string): Promise<string | null> {
      const result = await pool.query<{ value: string }>(
        'SELECT value FROM cache_entries WHERE key = $1 AND (expires_at IS NULL OR expires_at > NOW())',
        [key],
      );
      return result.rows[0]?.value ?? null;
    },

    async set(key: string, value: string, ttl?: number): Promise<void> {
      const expiresAt = ttl ? new Date(Date.now() + ttl * 1000) : null;
      await pool.query(
        `INSERT INTO cache_entries (key, value, expires_at)
         VALUES ($1, $2, $3)
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, expires_at = EXCLUDED.expires_at`,
        [key, value, expiresAt],
      );
    },

    async del(key: string): Promise<void> {
      await pool.query('DELETE FROM cache_entries WHERE key = $1', [key]);
    },

    async delPattern(pattern: string): Promise<void> {
      const likePattern = globToLike(pattern);
      await pool.query('DELETE FROM cache_entries WHERE key LIKE $1', [likePattern]);
    },

    isReady(): boolean {
      return ready;
    },
  };
}
