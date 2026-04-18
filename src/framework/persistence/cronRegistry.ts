// ---------------------------------------------------------------------------
// Cron Registry — backend factory functions
//
// Persists the set of BullMQ scheduler names registered by the current
// deployment so the next deployment can diff and remove stale schedulers.
// ---------------------------------------------------------------------------
import type { CronRegistryRepository } from '@lastshotlabs/slingshot-core';
import type { RepoFactories } from '@lastshotlabs/slingshot-core';

// ---------------------------------------------------------------------------
// Memory
// ---------------------------------------------------------------------------

/**
 * Create an in-memory `CronRegistryRepository`.
 *
 * State is held in a closure-owned `Set` and is lost on process restart.
 * Intended for local development and unit tests where persistence is not
 * required between deployments.
 *
 * @returns A `CronRegistryRepository` backed by an in-memory `Set`.
 */
export function createMemoryCronRegistry(): CronRegistryRepository {
  let stored = new Set<string>();

  return {
    getAll() {
      return Promise.resolve(new Set(stored));
    },
    save(names) {
      stored = new Set(names);
      return Promise.resolve();
    },
  };
}

// ---------------------------------------------------------------------------
// Redis
// ---------------------------------------------------------------------------

/**
 * Create a Redis-backed `CronRegistryRepository`.
 *
 * Scheduler names are serialised as a JSON array and stored under the key
 * `cron-registry:<appName>`. An unreadable or missing key returns an empty
 * set rather than throwing, so a fresh deployment can always proceed.
 *
 * @param getRedis - Lazy accessor that returns the Redis client. Called on
 *   every `getAll()` / `save()` invocation so the client is never held
 *   statically.
 * @param appName - The application name used to namespace the Redis key,
 *   preventing collisions between multiple apps sharing one Redis instance.
 * @returns A `CronRegistryRepository` that reads and writes a single Redis key.
 */
export function createRedisCronRegistry(
  getRedis: () => {
    get(key: string): Promise<string | null>;
    set(key: string, value: string): Promise<unknown>;
  },
  appName: string,
): CronRegistryRepository {
  const key = `cron-registry:${appName}`;

  return {
    async getAll() {
      const raw = await getRedis().get(key);
      if (!raw) return new Set();
      try {
        const parsed = JSON.parse(raw) as unknown;
        if (Array.isArray(parsed))
          return new Set(parsed.filter((x): x is string => typeof x === 'string'));
      } catch {
        // JSON parse error — treat as empty registry
      }
      return new Set();
    },
    async save(names) {
      await getRedis().set(key, JSON.stringify([...names]));
    },
  };
}

// ---------------------------------------------------------------------------
// SQLite
// ---------------------------------------------------------------------------

/**
 * Create a SQLite-backed `CronRegistryRepository`.
 *
 * The `cron_scheduler_registry` table is created lazily on first access (lazy
 * init pattern). `save()` replaces the entire set atomically by deleting all
 * rows and reinserting, keeping the implementation simple at the cost of a
 * brief inconsistency window (acceptable for a registry read only at deploy
 * time).
 *
 * @param getDb - Lazy accessor that returns the SQLite database handle. Called
 *   on each operation so the handle is not captured at construction time.
 * @returns A `CronRegistryRepository` backed by a SQLite table.
 */
export function createSqliteCronRegistry(
  getDb: () => {
    run(sql: string, params?: unknown[]): void;
    query<T>(sql: string): { all(...args: unknown[]): T[] };
  },
): CronRegistryRepository {
  let initialized = false;

  function ensureTable() {
    if (initialized) return;
    getDb().run(
      `CREATE TABLE IF NOT EXISTS cron_scheduler_registry (
        name TEXT NOT NULL,
        PRIMARY KEY (name)
      )`,
    );
    initialized = true;
  }

  return {
    getAll() {
      ensureTable();
      const rows = getDb()
        .query<{ name: string }>('SELECT name FROM cron_scheduler_registry')
        .all();
      return Promise.resolve(new Set(rows.map(r => r.name)));
    },
    save(names) {
      ensureTable();
      const db = getDb();
      db.run('DELETE FROM cron_scheduler_registry');
      for (const name of names) {
        db.run('INSERT INTO cron_scheduler_registry (name) VALUES (?)', [name]);
      }
      return Promise.resolve();
    },
  };
}

// ---------------------------------------------------------------------------
// MongoDB
// ---------------------------------------------------------------------------

/**
 * Create a MongoDB-backed `CronRegistryRepository`.
 *
 * Stores a single document (keyed by `appName`) in the
 * `cron_scheduler_registry` collection, with a `names` array field. The
 * Mongoose model is created lazily on first access and cached in the closure
 * to avoid re-registering the schema on repeated calls.
 *
 * @param getConn - Lazy accessor that returns the Mongoose connection.
 * @param getMg - Lazy accessor that returns the mongoose module, used to
 *   construct the schema definition. Kept separate from `getConn` to allow
 *   the opaque boundary cast (`as unknown as …`) to be isolated.
 * @param appName - Used as the document `_id`, namespacing registry entries
 *   by app when multiple apps share one MongoDB instance.
 * @returns A `CronRegistryRepository` backed by a single Mongo document.
 */
export function createMongoCronRegistry(
  getConn: () => { models: Record<string, unknown>; model(name: string, schema: unknown): unknown },
  getMg: () => { Schema: new (def: object, opts?: object) => unknown },
  appName: string,
): CronRegistryRepository {
  const docId = appName || 'default';

  /** Minimal interface for the Mongoose model operations used by this registry. */
  interface CronModel {
    findById(id: string): { lean(): Promise<{ names?: string[] } | null> };
    findByIdAndUpdate(
      id: string,
      update: { $set: { names: string[] } },
      opts: { upsert: boolean },
    ): Promise<unknown>;
  }

  let _model: CronModel | null = null;

  function getModel(): CronModel {
    if (_model) return _model;
    const conn = getConn();
    if (conn.models['CronSchedulerRegistry']) {
      _model = conn.models['CronSchedulerRegistry'] as CronModel;
      return _model;
    }
    const mg = getMg();
    const schema = new mg.Schema(
      { _id: String, names: [String] },
      { collection: 'cron_scheduler_registry' },
    );
    _model = conn.model('CronSchedulerRegistry', schema) as CronModel;
    return _model;
  }

  return {
    async getAll() {
      const doc = await getModel().findById(docId).lean();
      if (!doc?.names) return new Set();
      return new Set(doc.names);
    },
    async save(names) {
      await getModel().findByIdAndUpdate(docId, { $set: { names: [...names] } }, { upsert: true });
    },
  };
}

// ---------------------------------------------------------------------------
// Factory map
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Postgres
// ---------------------------------------------------------------------------

type PgPool = {
  query(
    sql: string,
    params?: unknown[],
  ): Promise<{ rows: Record<string, unknown>[]; rowCount: number | null }>;
};

/**
 * Create a Postgres-backed `CronRegistryRepository`.
 *
 * The `slingshot_cron_registry` table is created lazily on first access using
 * `CREATE TABLE IF NOT EXISTS`. A single row keyed by `appName` stores the
 * scheduler names as a Postgres `TEXT[]`. `save()` uses `INSERT … ON CONFLICT
 * DO UPDATE` (upsert) so the first write and subsequent writes are both safe.
 *
 * @param pool - The Postgres connection pool. Must support parameterised queries.
 * @param appName - Used as the row primary key (`id` column), namespacing
 *   registry entries by app.
 * @returns A `CronRegistryRepository` backed by a single Postgres row.
 * @throws If the lazy `CREATE TABLE IF NOT EXISTS` statement fails (e.g. on
 *   first call when the schema is inaccessible).
 */
export function createPostgresCronRegistry(pool: PgPool, appName: string): CronRegistryRepository {
  const docId = appName || 'default';
  let initialized = false;

  async function ensureTable(): Promise<void> {
    if (initialized) return;
    await pool.query(`
      CREATE TABLE IF NOT EXISTS slingshot_cron_registry (
        id    TEXT PRIMARY KEY,
        names TEXT[] NOT NULL DEFAULT '{}'
      )
    `);
    initialized = true;
  }

  return {
    async getAll() {
      await ensureTable();
      const result = await pool.query('SELECT names FROM slingshot_cron_registry WHERE id = $1', [
        docId,
      ]);
      const names = result.rows[0]?.['names'];
      return new Set(Array.isArray(names) ? (names as string[]) : []);
    },
    async save(names) {
      await ensureTable();
      await pool.query(
        `INSERT INTO slingshot_cron_registry (id, names)
         VALUES ($1, $2)
         ON CONFLICT (id) DO UPDATE SET names = EXCLUDED.names`,
        [docId, [...names]],
      );
    },
  };
}

export const cronRegistryFactories: RepoFactories<CronRegistryRepository> = {
  memory: () => createMemoryCronRegistry(),
  redis: infra => createRedisCronRegistry(infra.getRedis, infra.appName),
  sqlite: infra => createSqliteCronRegistry(infra.getSqliteDb),
  mongo: infra => {
    const { conn, mg } = infra.getMongo();
    return createMongoCronRegistry(
      () => conn,
      () => mg,
      infra.appName,
    );
  },
  postgres: infra => createPostgresCronRegistry(infra.getPostgres().pool, infra.appName),
};
