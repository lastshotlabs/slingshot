import { drizzle } from 'drizzle-orm/node-postgres';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';

/**
 * A connected Postgres handle bundling a raw `pg.Pool` and a Drizzle ORM client.
 *
 * - `pool` — passed to plugin adapters that accept a raw `pg.Pool` (permissions, push, webhooks).
 * - `db` — passed to Drizzle-based adapters such as `createPostgresAdapter` (auth).
 */
export interface DrizzlePostgresDb {
  /** Raw `pg.Pool` for plugin adapters that work directly with parameterized SQL. */
  readonly pool: Pool;
  /** Drizzle ORM client wrapping the same pool, used by `createPostgresAdapter`. */
  readonly db: NodePgDatabase;
}

/**
 * Opens a Postgres connection pool and returns a bundled `{ pool, db }` handle.
 *
 * The pool is eagerly verified with a `SELECT 1` query to surface connectivity problems at
 * startup rather than at first request (fail-fast). Both `pool` and `db` share the same
 * underlying connection pool.
 *
 * @param connectionString - A `postgresql://` connection string.
 * @returns A `DrizzlePostgresDb` handle with a verified, live connection.
 * @throws {Error} If the Postgres server is unreachable or credentials are invalid.
 *
 * @example
 * ```ts
 * import { connectPostgres } from '@lastshotlabs/slingshot-postgres';
 *
 * const db = await connectPostgres(process.env.DATABASE_URL!);
 * // Pass db.pool to permission/push/webhook adapters.
 * // Pass db to createPostgresAdapter for auth.
 * ```
 */
export async function connectPostgres(connectionString: string): Promise<DrizzlePostgresDb> {
  const pool = new Pool({ connectionString });
  await pool.query('SELECT 1'); // verify connectivity eagerly
  const db = drizzle(pool);
  return { pool, db };
}
