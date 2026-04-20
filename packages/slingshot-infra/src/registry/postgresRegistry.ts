import type { RegistryDocument, RegistryLock, RegistryProvider } from '../types/registry';
import { createEmptyRegistryDocument } from '../types/registry';

interface PgQueryResult<TResult> {
  rows: TResult[];
  rowCount: number | null;
}

interface PgClient {
  connect(): Promise<void>;
  query<TResult = unknown>(
    queryText: string,
    values?: readonly unknown[],
  ): Promise<PgQueryResult<TResult>>;
  end(): Promise<void>;
}

interface PgModule {
  Client: new (options: { connectionString: string }) => PgClient;
}

/**
 * Configuration for the Postgres-backed registry provider.
 */
export interface PostgresRegistryConfig {
  /** Postgres connection string (e.g. `'postgres://user:pass@host:5432/db'`). */
  connectionString: string;
  /** Table name. Default: `'slingshot_registry'`. */
  table?: string;
}

/**
 * Lazily import the `pg` package (optional peer dependency).
 *
 * @returns The `pg` module namespace (`typeof import('pg')`).
 *
 * @throws {Error} If `pg` is not installed in the current project
 *   (`bun add pg` to resolve).
 */
async function loadPg(): Promise<PgModule> {
  try {
    const imported: unknown = await import('pg');
    if (
      typeof imported === 'object' &&
      imported !== null &&
      'Client' in imported &&
      typeof imported.Client === 'function'
    ) {
      return imported as PgModule;
    }
    throw new Error('Invalid pg module export');
  } catch {
    throw new Error('pg is not installed. Run: bun add pg');
  }
}

/**
 * Compute a stable 32-bit integer hash of a string for use as a `pg_advisory_lock` ID.
 *
 * Uses the FNV-1a 32-bit algorithm, which produces a non-negative integer in the
 * unsigned 32-bit range. The result is then coerced to a signed 32-bit integer
 * (`hash | 0`) so it fits within PostgreSQL's `bigint` advisory lock parameter
 * without overflow.
 *
 * @param str - The string to hash (typically the registry table name).
 * @returns A signed 32-bit integer suitable for `pg_advisory_lock($1)`.
 *
 * @remarks
 * The same table name will always produce the same lock ID across processes,
 * making this safe to use as a distributed mutex key. Different table names
 * produce different lock IDs with negligible collision probability.
 */
function hashStringToInt(str: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    hash = (hash * 0x01000193) >>> 0;
  }
  // Ensure it fits in a signed 32-bit integer for pg_advisory_lock
  return hash | 0;
}

/**
 * Create a registry provider that persists the `RegistryDocument` as a JSONB
 * column in a Postgres table.
 *
 * Optimistic concurrency is provided via an integer `version` column: `write()`
 * with an ETag executes a conditional `UPDATE WHERE version = <etag>` and
 * throws if zero rows are updated. True advisory locking uses
 * `pg_advisory_lock()` to serialize concurrent writers; the lock is released
 * when `lock.release()` is called.
 *
 * `initialize()` creates the table with `CREATE TABLE IF NOT EXISTS` and
 * inserts an initial empty document (no-op if the row already exists).
 *
 * @param config - Postgres connection string and optional table name.
 * @returns A `RegistryProvider` backed by Postgres.
 *
 * @throws {Error} If the `pg` package is not installed.
 * @throws {Error} If a concurrent write is detected (version mismatch).
 *
 * @example
 * ```ts
 * import { createPostgresRegistry } from '@lastshotlabs/slingshot-infra';
 *
 * const registry = createPostgresRegistry({
 *   connectionString: process.env.DATABASE_URL!,
 * });
 * await registry.initialize();
 * ```
 */
export function createPostgresRegistry(config: PostgresRegistryConfig): RegistryProvider {
  const tableName = config.table ?? 'slingshot_registry';

  // Guard against SQL injection: table name must be a valid PostgreSQL identifier.
  // Only lowercase letters, digits, and underscores are allowed.
  if (!/^[a-z][a-z0-9_]*$/i.test(tableName)) {
    throw new Error(
      `[slingshot-infra] Invalid Postgres registry table name: "${tableName}". ` +
        'Must start with a letter and contain only letters, digits, and underscores.',
    );
  }

  const lockId = hashStringToInt(tableName);

  async function getClient(): Promise<PgClient> {
    const pg = await loadPg();
    const client = new pg.Client({ connectionString: config.connectionString });
    await client.connect();
    return client;
  }

  return {
    name: 'postgres',

    async read(): Promise<RegistryDocument | null> {
      const client = await getClient();
      try {
        const res = await client.query<{ document: RegistryDocument; version: number }>(
          `SELECT document, version FROM ${tableName} WHERE id = 'default'`,
        );
        if (res.rows.length === 0) return null;
        const [row] = res.rows;
        return structuredClone(row.document);
      } finally {
        await client.end();
      }
    },

    async write(doc: RegistryDocument, etag?: string): Promise<{ etag: string }> {
      const client = await getClient();
      try {
        doc.updatedAt = new Date().toISOString();

        if (etag !== undefined) {
          const version = parseInt(etag, 10);
          if (isNaN(version)) {
            throw new Error(
              '[slingshot-infra] Invalid ETag for postgres registry (expected version number).',
            );
          }
          const res = await client.query(
            `UPDATE ${tableName} SET document = $1, version = version + 1, updated_at = now() WHERE id = 'default' AND version = $2`,
            [JSON.stringify(doc), version],
          );
          if (res.rowCount === 0) {
            throw new Error(
              '[slingshot-infra] Registry was modified by another process. Re-read and retry.',
            );
          }
          return { etag: String(version + 1) };
        } else {
          const res = await client.query<{ version: number }>(
            `UPDATE ${tableName} SET document = $1, version = version + 1, updated_at = now() WHERE id = 'default' RETURNING version`,
            [JSON.stringify(doc)],
          );
          if (res.rows.length === 0) {
            throw new Error(
              '[slingshot-infra] No registry row to update. Run: slingshot registry init',
            );
          }
          const [row] = res.rows;
          return { etag: String(row.version) };
        }
      } finally {
        await client.end();
      }
    },

    async initialize(): Promise<void> {
      const client = await getClient();
      try {
        await client.query('BEGIN');
        await client.query(`SELECT pg_advisory_xact_lock($1)`, [lockId]);
        await client.query(`
          CREATE TABLE IF NOT EXISTS ${tableName} (
            id TEXT PRIMARY KEY DEFAULT 'default',
            document JSONB NOT NULL,
            version INTEGER NOT NULL DEFAULT 1,
            updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
          )
        `);

        const initial = createEmptyRegistryDocument('');
        await client.query(
          `INSERT INTO ${tableName} (id, document, version, updated_at)
           VALUES ('default', $1, 1, now())
           ON CONFLICT (id) DO NOTHING`,
          [JSON.stringify(initial)],
        );
        await client.query('COMMIT');
      } catch (err) {
        try {
          await client.query('ROLLBACK');
        } catch {
          // Preserve the original initialize failure.
        }
        throw err;
      } finally {
        await client.end();
      }
    },

    async lock(): Promise<RegistryLock> {
      // Advisory locks are session-scoped — keep the connection open until release()
      const client = await getClient();
      try {
        await client.query(`SELECT pg_advisory_lock($1)`, [lockId]);

        // Read current version to use as etag
        const res = await client.query<{ version: number }>(
          `SELECT version FROM ${tableName} WHERE id = 'default'`,
        );
        if (res.rows.length === 0) {
          throw new Error(
            '[slingshot-infra] Registry not initialized. Run: slingshot registry init',
          );
        }
        const etag = String(res.rows[0].version);

        return {
          etag,
          async release(): Promise<void> {
            try {
              await client.query(`SELECT pg_advisory_unlock($1)`, [lockId]);
            } finally {
              await client.end();
            }
          },
        };
      } catch (err) {
        await client.end();
        throw err;
      }
    },
  };
}
