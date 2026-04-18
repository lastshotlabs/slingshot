/**
 * Shared database interface types for operation executors.
 *
 * Every executor imports its backend handle type from here rather than defining
 * its own. This guarantees structural compatibility between the wiring functions
 * (which pass handles down) and the executors (which receive them).
 *
 * These are minimal structural interfaces — they are intentionally narrower than the
 * full SDKs (bun:sqlite, pg, ioredis, mongoose) so that the executors remain
 * decoupled from any specific library version and are straightforward to test with
 * lightweight fakes.
 *
 * **Adding a new backend:**
 * Define its handle interface here, then import it in the new `*OperationWiring.ts`
 * file and all executors that need it.
 */

/**
 * Minimal interface for a synchronous SQLite database handle (bun:sqlite compatible).
 *
 * Executor contracts:
 * - `run()` executes a mutating statement and returns the number of changed rows.
 * - `query<T>()` prepares a SELECT statement; `.get()` returns one row or null,
 *   `.all()` returns all matching rows.
 *
 * The real `bun:sqlite` `Database` satisfies this interface.
 */
export interface SqliteDb {
  /**
   * Execute a mutating SQL statement (INSERT, UPDATE, DELETE, DDL).
   *
   * @param sql    - The SQL statement with `?` placeholders.
   * @param params - Positional parameter values.
   * @returns An object with a `changes` count indicating rows affected.
   */
  run(sql: string, params?: unknown[]): { changes: number };
  /**
   * Prepare a SELECT statement for repeated execution.
   *
   * @param sql - The SQL SELECT statement with `?` placeholders.
   * @returns A prepared statement with `.get(...args)` and `.all(...args)` methods.
   */
  query<T>(sql: string): { get(...args: unknown[]): T | null; all(...args: unknown[]): T[] };
}

/**
 * Minimal interface for a Postgres connection pool (pg-compatible).
 *
 * The real `pg.Pool` satisfies this interface. Executors call `pool.query()` for
 * every operation — no connection management is exposed at the executor level.
 */
export interface PgQueryable {
  /**
   * Execute a parameterized SQL query against the pool.
   *
   * @param sql    - The SQL statement with `$1`, `$2`, … placeholders.
   * @param params - Positional parameter values.
   * @returns An object with `rows` (the result set) and `rowCount` (rows affected or null).
   */
  query(
    sql: string,
    params?: unknown[],
  ): Promise<{ rows: Record<string, unknown>[]; rowCount: number | null }>;
}

export interface PgClient extends PgQueryable {
  release?(): void;
}

export interface PgPool extends PgQueryable {
  connect?(): Promise<PgClient>;
}

/**
 * Minimal interface for a Mongoose model used by MongoDB executors.
 *
 * Each method corresponds to a Mongoose model method, narrowed to the subset
 * that executors actually call. Executors always chain `.lean()` on `findOne`/`find`
 * results to get plain objects instead of Mongoose documents.
 *
 * The real Mongoose `Model` satisfies this interface.
 */
export interface MongoModel {
  /**
   * Find a single document matching `filter`.
   * Chain `.lean()` to receive a plain object instead of a Mongoose Document.
   *
   * @param filter     - MongoDB query filter.
   * @param projection - Optional field projection string (e.g. `'-__v'`).
   */
  findOne(
    filter: Record<string, unknown>,
    projection?: string,
  ): { lean(): Promise<Record<string, unknown> | null> };
  /**
   * Find all documents matching `filter`.
   * Chain `.lean()` to receive plain objects.
   *
   * @param filter - MongoDB query filter.
   */
  find(filter: Record<string, unknown>): { lean(): Promise<Array<Record<string, unknown>>> };
  /**
   * Update the first document matching `filter`.
   *
   * @param filter - MongoDB query filter.
   * @param update - MongoDB update expression (e.g. `{ $set: { ... } }`).
   * @param opts   - Optional Mongoose update options (e.g. `{ upsert: true }`).
   */
  updateOne(
    filter: Record<string, unknown>,
    update: Record<string, unknown>,
    opts?: Record<string, unknown>,
  ): Promise<{ modifiedCount: number; matchedCount: number }>;
  /**
   * Update all documents matching `filter`.
   *
   * @param filter - MongoDB query filter.
   * @param update - MongoDB update expression.
   */
  updateMany(
    filter: Record<string, unknown>,
    update: Record<string, unknown>,
  ): Promise<{ modifiedCount: number }>;
  /**
   * Delete the first document matching `filter`.
   *
   * @param filter - MongoDB query filter.
   */
  deleteOne(filter: Record<string, unknown>): Promise<{ deletedCount: number }>;
  /**
   * Delete all documents matching `filter`.
   *
   * @param filter - MongoDB query filter.
   */
  deleteMany(filter: Record<string, unknown>): Promise<{ deletedCount: number }>;
  /**
   * Run an aggregation pipeline.
   *
   * @param pipeline - Array of aggregation stage objects.
   * @returns The aggregation result documents as plain objects.
   */
  aggregate(pipeline: Array<Record<string, unknown>>): Promise<Array<Record<string, unknown>>>;
}

/**
 * Minimal interface for a Redis client (ioredis-compatible).
 *
 * Executors use only `GET`, `SET`, and `DEL` — the narrowed interface keeps
 * executors portable across ioredis, ioredis cluster, and test fakes.
 *
 * The real `ioredis.Redis` and `ioredis.Cluster` satisfy this interface.
 */
export interface RedisClient {
  /**
   * Retrieve the string value stored at `key`, or `null` if the key does not exist.
   *
   * @param key - The Redis key.
   */
  get(key: string): Promise<string | null>;
  /**
   * Set the string value at `key`. Additional arguments (e.g. `'EX'`, `ttlSeconds`)
   * are passed through to the underlying client for TTL support.
   *
   * @param key   - The Redis key.
   * @param value - The string value to store (typically a JSON-serialized record).
   * @param args  - Optional Redis SET option arguments (e.g. `'EX'`, `3600`).
   */
  set(key: string, value: string, ...args: unknown[]): Promise<unknown>;
  /**
   * Delete one or more keys.
   *
   * @param keys - One or more Redis keys to delete.
   * @returns The number of keys that were actually deleted.
   */
  del(...keys: string[]): Promise<number>;
}

/**
 * A single entry in the in-memory entity store.
 *
 * The `Map<string | number, MemoryEntry>` is the entire in-memory "table" for an entity.
 * Executors check `isAlive(entry)` (comparing `expiresAt` against `Date.now()`) before
 * operating on an entry.
 */
export interface MemoryEntry {
  /** The full domain record as a plain object. */
  record: Record<string, unknown>;
  /**
   * Absolute expiry timestamp in milliseconds (from `Date.now()`).
   * Absent when the entity has no TTL configured.
   */
  expiresAt?: number;
}
