import { Database } from 'bun:sqlite';
import type {
  RuntimeServerInstance,
  RuntimeSqliteDatabase,
  RuntimeSqlitePreparedStatement,
  RuntimeSqliteRunResult,
  RuntimeSqliteStatement,
  SlingshotRuntime,
} from '@lastshotlabs/slingshot-core';

/**
 * Creates a `SlingshotRuntime` implementation powered by the Bun runtime.
 *
 * Provides the following capabilities using Bun's built-in APIs:
 * - **password** — `Bun.password.hash` / `Bun.password.verify` (argon2id by default)
 * - **sqlite** — `bun:sqlite` Database (WAL mode, `create: true`)
 * - **server** — `Bun.serve` HTTP server with WebSocket upgrade support
 * - **fs** — `Bun.write`, `Bun.file` for async file I/O
 * - **glob** — `Bun.Glob` for file pattern scanning
 *
 * Pass the returned runtime to `createServer` or `createApp` as the `runtime` option.
 *
 * @returns A fully-implemented `SlingshotRuntime` backed by Bun APIs.
 *
 * @remarks
 * This runtime is intended for use in Bun environments only. For Node.js, use
 * `nodeRuntime()` from `@lastshotlabs/slingshot-runtime-node`.
 *
 * @example
 * ```ts
 * import { bunRuntime } from '@lastshotlabs/slingshot-runtime-bun';
 * import { createServer } from '@lastshotlabs/slingshot-core';
 *
 * const server = await createServer({ runtime: bunRuntime(), ...config });
 * ```
 */
export function bunRuntime(): SlingshotRuntime {
  return {
    password: {
      async hash(plain: string): Promise<string> {
        return Bun.password.hash(plain);
      },
      async verify(plain: string, hash: string): Promise<boolean> {
        return Bun.password.verify(plain, hash);
      },
    },
    sqlite: {
      open(path: string): RuntimeSqliteDatabase {
        const db = new Database(path, { create: true });
        return adaptBunSqlite(db);
      },
    },
    server: {
      listen(opts): RuntimeServerInstance {
        // Cast opts to avoid fighting Bun.serve's complex overloaded types at the opaque runtime boundary
        const server = Bun.serve(opts as unknown as Parameters<typeof Bun.serve>[0]);
        return {
          get port(): number {
            return server.port ?? opts.port ?? 3000;
          },
          stop(close?: boolean): void {
            void server.stop(close);
          },
          upgrade(req: Request, o: { data: unknown }): boolean {
            return server.upgrade(req, o);
          },
          publish(channel: string, msg: string): void {
            server.publish(channel, msg);
          },
        };
      },
    },
    fs: {
      async write(path: string, data: string | Uint8Array): Promise<void> {
        await Bun.write(path, data);
      },
      async readFile(path: string): Promise<Uint8Array | null> {
        const f = Bun.file(path);
        if (!(await f.exists())) return null;
        return new Uint8Array(await f.arrayBuffer());
      },
      async exists(path: string): Promise<boolean> {
        return Bun.file(path).exists();
      },
    },
    glob: {
      async scan(pattern: string, options?: { cwd?: string }): Promise<string[]> {
        const glob = new Bun.Glob(pattern);
        const results: string[] = [];
        for await (const f of glob.scan(options ?? {})) {
          results.push(f);
        }
        return results;
      },
    },
    async readFile(path: string): Promise<string | null> {
      const f = Bun.file(path);
      if (!(await f.exists())) return null;
      return await f.text();
    },
    supportsAsyncLocalStorage: true,
  };
}

/**
 * Wraps a `bun:sqlite` `Database` in the `RuntimeSqliteDatabase` interface.
 *
 * Adapts Bun's `bun:sqlite` API to the `RuntimeSqliteDatabase` contract so it
 * can be consumed by slingshot adapters. Binding parameters are cast at the opaque
 * Bun runtime boundary using `as import('bun:sqlite').SQLQueryBindings[]` since
 * Bun's type signature is more specific than the `unknown[]` the interface uses.
 *
 * @param db - An open `bun:sqlite` `Database` instance.
 * @returns A `RuntimeSqliteDatabase` that delegates all operations to `db`.
 *
 * @remarks
 * `run()` and `query()` use `db.run()` / `db.query()` directly. For frequently
 * executed statements, use `prepare()` to avoid re-preparing on every call.
 *
 * When `path` is provided to `sqlite.open(path)` (which calls `new Database(path, { create: true })`),
 * Bun creates the SQLite database file at that path if it does not already exist. No
 * error is thrown for a missing file — creation is implicit.
 *
 * @example
 * ```ts
 * // Used internally by bunRuntime() — not needed in application code.
 * const { Database } = require('bun:sqlite');
 * const db = new Database('./data.db', { create: true });
 * const runtimeDb = adaptBunSqlite(db);
 * ```
 */
function adaptBunSqlite(db: import('bun:sqlite').Database): RuntimeSqliteDatabase {
  return {
    run(sql: string, ...params: unknown[]): void {
      // Cast at the opaque Bun runtime boundary — unknown[] vs SQLQueryBindings[]
      db.run(sql, ...(params as import('bun:sqlite').SQLQueryBindings[][]));
    },
    query<T = unknown>(sql: string): RuntimeSqliteStatement<T> {
      // Use a generic statement and cast bindings at the opaque Bun boundary
      const stmt = db.query<T, import('bun:sqlite').SQLQueryBindings[]>(sql);
      return {
        get(...params: unknown[]): T | null {
          return stmt.get(...(params as import('bun:sqlite').SQLQueryBindings[])) ?? null;
        },
        all(...params: unknown[]): T[] {
          return stmt.all(...(params as import('bun:sqlite').SQLQueryBindings[]));
        },
        run(...params: unknown[]): void {
          stmt.run(...(params as import('bun:sqlite').SQLQueryBindings[]));
        },
      };
    },
    prepare<T = unknown>(sql: string): RuntimeSqlitePreparedStatement<T> {
      const stmt = db.prepare<T, import('bun:sqlite').SQLQueryBindings[]>(sql);
      return {
        get(...params: unknown[]): T | null {
          return stmt.get(...(params as import('bun:sqlite').SQLQueryBindings[])) ?? null;
        },
        all(...params: unknown[]): T[] {
          return stmt.all(...(params as import('bun:sqlite').SQLQueryBindings[]));
        },
        run(...params: unknown[]): RuntimeSqliteRunResult {
          const result = stmt.run(...(params as import('bun:sqlite').SQLQueryBindings[]));
          return { changes: result.changes };
        },
      };
    },
    /**
     * Wraps `fn` in a `bun:sqlite` transaction and returns a callable thunk.
     *
     * @remarks
     * The returned function, when called, begins a SQLite transaction, executes `fn`,
     * and automatically **commits** if `fn` returns normally or **rolls back** if `fn`
     * throws. The rollback is performed by Bun's transaction wrapper before re-throwing
     * the original error. Nested calls to transaction thunks use SQLite savepoints
     * (SAVEPOINT / RELEASE / ROLLBACK TO) rather than nested BEGIN statements.
     */
    transaction<T>(fn: () => T): () => T {
      return db.transaction(fn) as () => T;
    },
    close(): void {
      db.close();
    },
  };
}
