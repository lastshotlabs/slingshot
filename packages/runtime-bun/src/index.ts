import { Database } from 'bun:sqlite';
import type {
  RuntimeServerInstance,
  RuntimeSqliteDatabase,
  RuntimeSqlitePreparedStatement,
  RuntimeSqliteRunResult,
  RuntimeSqliteStatement,
  RuntimeWebSocket,
  RuntimeWebSocketHandler,
  SlingshotRuntime,
} from '@lastshotlabs/slingshot-core';

/** Bun's default request body limit when none is supplied (128 MiB). */
const BUN_DEFAULT_MAX_BODY = 128 * 1024 * 1024;

// ---------------------------------------------------------------------------
// Logger — structured, redirectable, parity with runtime-node
// ---------------------------------------------------------------------------

/**
 * Structured logging hook for the Bun runtime. The runtime emits operational
 * events (fetch handler errors, websocket handler errors) to the configured
 * logger. Defaults to a `console.error`-backed implementation.
 *
 * Pass a custom logger via {@link configureRuntimeBunLogger} to forward into
 * pino, OpenTelemetry, etc.
 */
export interface RuntimeBunLogger {
  warn(event: string, fields?: Record<string, unknown>): void;
  error(event: string, fields?: Record<string, unknown>): void;
}

function formatLogLine(event: string, fields?: Record<string, unknown>): string {
  if (!fields) return `[runtime-bun] ${event}`;
  const parts: string[] = [];
  for (const [k, v] of Object.entries(fields)) {
    if (v === undefined) continue;
    if (k === 'stack') continue;
    if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
      parts.push(`${k}=${String(v)}`);
    }
  }
  const summary = parts.length > 0 ? ` ${parts.join(' ')}` : '';
  return `[runtime-bun] ${event}${summary}`;
}

const defaultLogger: RuntimeBunLogger = {
  warn(event, fields) {
    console.warn(formatLogLine(event, fields));
  },
  error(event, fields) {
    console.error(formatLogLine(event, fields));
    if (typeof fields?.stack === 'string') {
      console.error(fields.stack);
    }
  },
};

let activeLogger: RuntimeBunLogger = defaultLogger;

/**
 * Replace the runtime's structured logger. Pass `null` to reset to the default
 * console-backed logger. Returns the previous logger so tests can save and
 * restore state.
 */
export function configureRuntimeBunLogger(logger: RuntimeBunLogger | null): RuntimeBunLogger {
  const previous = activeLogger;
  activeLogger = logger ?? defaultLogger;
  return previous;
}

function logRuntimeError(scope: 'fetch' | 'websocket', phase: string, error: unknown): void {
  activeLogger.error('runtime-handler-error', {
    scope,
    phase,
    message: error instanceof Error ? error.message : String(error),
    stack: error instanceof Error ? error.stack : undefined,
  });
}

type BunRuntimeWebSocket = RuntimeWebSocket & {
  readonly data: unknown;
  send(data: string | Buffer): unknown;
  close(code?: number, reason?: string): unknown;
  ping?(): unknown;
  subscribe?(channel: string): unknown;
  unsubscribe?(channel: string): unknown;
};

const bunWsHandles = new WeakMap<object, RuntimeWebSocket>();

function requireBunWsMethod(
  ws: BunRuntimeWebSocket,
  method: 'ping' | 'subscribe' | 'unsubscribe',
): (...args: [string?]) => unknown {
  const fn = ws[method];
  if (typeof fn !== 'function') {
    throw new Error(`[runtime-bun] Bun ServerWebSocket is missing ${method}()`);
  }
  return fn.bind(ws) as (...args: [string?]) => unknown;
}

function toRuntimeWebSocket(ws: BunRuntimeWebSocket): RuntimeWebSocket {
  const existing = bunWsHandles.get(ws as object);
  if (existing) return existing;
  const rtWs: RuntimeWebSocket = {
    get data() {
      return ws.data;
    },
    send(data: string | Buffer): void {
      try {
        ws.send(data);
      } catch (err) {
        logRuntimeError('websocket', 'send', err);
      }
    },
    close(code?: number, reason?: string): void {
      ws.close(code, reason);
    },
    ping(): void {
      requireBunWsMethod(ws, 'ping')();
    },
    subscribe(channel: string): void {
      requireBunWsMethod(ws, 'subscribe')(channel);
    },
    unsubscribe(channel: string): void {
      requireBunWsMethod(ws, 'unsubscribe')(channel);
    },
  };
  bunWsHandles.set(ws as object, rtWs);
  return rtWs;
}

// ---------------------------------------------------------------------------
// Process-level safety net (parity with runtime-node)
// ---------------------------------------------------------------------------

let processHandlersInstalled = false;

/**
 * Install once-per-process handlers for `unhandledRejection` and
 * `uncaughtException`. Both are forwarded to the structured logger so they
 * surface alongside other runtime events. Idempotent.
 */
export function installProcessSafetyNet(): void {
  if (processHandlersInstalled) return;
  processHandlersInstalled = true;
  process.on('unhandledRejection', (reason: unknown) => {
    activeLogger.error('unhandled-rejection', {
      message: reason instanceof Error ? reason.message : String(reason),
      stack: reason instanceof Error ? reason.stack : undefined,
    });
  });
  process.on('uncaughtException', (err: Error) => {
    activeLogger.error('uncaught-exception', { message: err.message, stack: err.stack });
  });
}

/**
 * Wraps the user fetch handler so async rejections are forwarded to `opts.error`
 * (matching the node runtime). Bun.serve catches sync throws but, depending on
 * version, may surface async rejections as unhandled if the consumer didn't
 * supply an `error` handler — this guarantees a single observable error path.
 */
function wrapFetch(
  fetchFn: (req: Request) => Response | Promise<Response>,
  errorFn?: (err: Error) => Response | Promise<Response>,
): (req: Request) => Response | Promise<Response> {
  return async (req: Request) => {
    try {
      return await fetchFn(req);
    } catch (err) {
      const wrapped = err instanceof Error ? err : new Error(String(err));
      if (errorFn) return errorFn(wrapped);
      logRuntimeError('fetch', 'unhandled', wrapped);
      return new Response('Internal Server Error', { status: 500 });
    }
  };
}

/**
 * Wrap the optional websocket handler so any throw or rejection in `open`,
 * `message`, `close`, or `pong` is logged with phase context instead of being
 * silently swallowed by Bun.
 */
function wrapWebSocketHandler(
  handler: RuntimeWebSocketHandler,
  activeSockets?: Set<BunRuntimeWebSocket>,
): RuntimeWebSocketHandler {
  return {
    ...handler,
    async open(ws: RuntimeWebSocket): Promise<void> {
      const raw = ws as BunRuntimeWebSocket;
      activeSockets?.add(raw);
      try {
        await handler.open(toRuntimeWebSocket(raw));
      } catch (err) {
        logRuntimeError('websocket', 'open', err);
      }
    },
    async message(ws: RuntimeWebSocket, message: string | Buffer): Promise<void> {
      try {
        await handler.message(toRuntimeWebSocket(ws as BunRuntimeWebSocket), message);
      } catch (err) {
        logRuntimeError('websocket', 'message', err);
      }
    },
    async close(ws: RuntimeWebSocket, code: number, reason: string): Promise<void> {
      const raw = ws as BunRuntimeWebSocket;
      activeSockets?.delete(raw);
      try {
        await handler.close(toRuntimeWebSocket(raw), code, reason);
      } catch (err) {
        logRuntimeError('websocket', 'close', err);
      }
    },
    pong: handler.pong
      ? (ws: RuntimeWebSocket) => {
          try {
            handler.pong?.(toRuntimeWebSocket(ws as BunRuntimeWebSocket));
          } catch (err) {
            logRuntimeError('websocket', 'pong', err);
          }
        }
      : undefined,
  };
}

/**
 * Creates a `SlingshotRuntime` implementation powered by the Bun runtime.
 *
 * Provides the following capabilities using Bun's built-in APIs:
 * - **password** — `Bun.password.hash` / `Bun.password.verify` (argon2id by default)
 * - **sqlite** — `bun:sqlite` Database (WAL mode, `create: true`)
 * - **server** — `Bun.serve` HTTP server with WebSocket upgrade support and optional TLS
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
 * **Signal handling**: this runtime does not register `SIGTERM` or `SIGINT` handlers.
 * Process lifecycle management belongs to the calling application — registering
 * signal handlers from a library would conflict with consumers that already do so.
 * Forgetting to register a handler results in hard-killed processes during deploy:
 * in-flight requests are dropped, websocket clients receive `1006`, and active
 * SQLite transactions are rolled back. Always register handlers in production:
 *
 * ```ts
 * const server = await createServer({ runtime: bunRuntime(), ...config });
 * const drain = async () => {
 *   try { await server.stop(); } finally { process.exit(0); }
 * };
 * process.once('SIGTERM', drain);
 * process.once('SIGINT', drain);
 * ```
 *
 * **Async error handling**: the fetch handler is wrapped so async rejections are
 * forwarded to `opts.error` (or logged with a 500 fallback if `opts.error` is omitted).
 * Without this wrapper rejections from async middleware would bypass `opts.error`.
 *
 * **WebSocket error handling**: when `opts.websocket` is provided, every lifecycle
 * callback (`open`, `message`, `close`, `pong`) is wrapped to log with phase context
 * instead of crashing or being silently dropped by Bun.
 *
 * @example
 * ```ts
 * import { bunRuntime } from '@lastshotlabs/slingshot-runtime-bun';
 * import { createServer } from '@lastshotlabs/slingshot-core';
 *
 * const server = await createServer({ runtime: bunRuntime(), ...config });
 *
 * // REQUIRED in production — see remarks above.
 * process.once('SIGTERM', async () => {
 *   await server.stop();
 *   process.exit(0);
 * });
 * ```
 */
export function bunRuntime(): SlingshotRuntime {
  return {
    password: {
      async hash(plain: string): Promise<string> {
        return Bun.password.hash(plain);
      },
      async verify(plain: string, hash: string): Promise<boolean> {
        try {
          return await Bun.password.verify(plain, hash);
        } catch {
          // Malformed hash material — surface as a non-match rather than rejecting.
          return false;
        }
      },
    },
    sqlite: {
      open(path: string): RuntimeSqliteDatabase {
        const db = new Database(path, { create: true });
        // WAL mode is required for concurrent readers + writer on file-based databases.
        // In-memory databases (':memory:') don't support WAL — skip the check for them.
        if (path !== ':memory:') {
          const journalMode = db
            .query<{ journal_mode: string }, []>('PRAGMA journal_mode = WAL')
            .get();
          if (journalMode && journalMode.journal_mode.toLowerCase() !== 'wal') {
            db.close();
            throw new Error(
              `[runtime-bun] failed to enable WAL journal mode (got ${journalMode.journal_mode}); ` +
                `verify the database file is on a writable, non-network filesystem`,
            );
          }
        }
        return adaptBunSqlite(db);
      },
    },
    server: {
      listen(opts): RuntimeServerInstance {
        const fetchHandler = wrapFetch(opts.fetch, opts.error);
        const activeWebSockets = new Set<BunRuntimeWebSocket>();
        const websocketHandler = opts.websocket
          ? wrapWebSocketHandler(opts.websocket, activeWebSockets)
          : undefined;

        // Build options as `unknown` then cast at the Bun.serve boundary. Bun's
        // overload narrows on the presence of `unix` (mutually exclusive with
        // hostname/port); modeling that statically here would require a discriminated
        // union the contract does not enforce. Bun validates at serve() time.
        const sharedOpts: Record<string, unknown> = {
          fetch: fetchHandler,
          maxRequestBodySize: opts.maxRequestBodySize ?? BUN_DEFAULT_MAX_BODY,
        };
        if (opts.error) {
          sharedOpts.error = (err: Error) => opts.error?.(err);
        }
        if (websocketHandler) {
          sharedOpts.websocket = websocketHandler;
        }
        if (opts.tls) {
          sharedOpts.tls = { key: opts.tls.key, cert: opts.tls.cert };
        }

        const serveOpts: Parameters<typeof Bun.serve>[0] = (
          opts.unix
            ? { ...sharedOpts, unix: opts.unix }
            : { ...sharedOpts, port: opts.port, hostname: opts.hostname }
        ) as Parameters<typeof Bun.serve>[0];

        const server = Bun.serve(serveOpts);
        return {
          get port(): number {
            return server.port ?? opts.port ?? 3000;
          },
          async stop(close?: boolean): Promise<void> {
            for (const ws of [...activeWebSockets]) {
              try {
                ws.close(1001, 'Server shutting down');
              } catch (err) {
                logRuntimeError('websocket', 'close-during-stop', err);
              } finally {
                activeWebSockets.delete(ws);
              }
            }
            await server.stop(close);
          },
          upgrade(req: Request, o: { data: unknown }): boolean {
            return server.upgrade(req, o);
          },
          publish(channel: string, msg: string): void {
            try {
              server.publish(channel, msg);
            } catch (err) {
              logRuntimeError('websocket', 'publish', err);
            }
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
