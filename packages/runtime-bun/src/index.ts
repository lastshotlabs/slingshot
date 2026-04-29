import { Database } from 'bun:sqlite';
import { type Logger, createConsoleLogger } from '@lastshotlabs/slingshot-core';
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

/**
 * Runtime-specific error classes thrown by the Bun adapter for server,
 * WebSocket, SQLite, and password-hashing failures.
 */
export {
  BunRuntimeError,
  BunServerError,
  BunSqliteError,
  BunWebSocketError,
  BunPasswordError,
} from './errors';

/** Bun's default request body limit when none is supplied (128 MiB). */
const BUN_DEFAULT_MAX_BODY = 128 * 1024 * 1024;
const WEBSOCKET_SHUTDOWN_CODE = 1001;
const WEBSOCKET_SHUTDOWN_REASON = 'Server shutting down';
/**
 * Default per-socket close-handler timeout (5 s). After this, force-close any
 * sockets whose close handler has not fired and proceed with the server stop.
 */
const DEFAULT_WS_CLOSE_TIMEOUT_MS = 5_000;
/**
 * Default per-socket close-handler timeout (30 s) for the *graceful* drain
 * path. Longer than the forced-stop timeout because graceful drains have no
 * fall-through to force-close — the runtime simply waits for the configured
 * window, then resolves and lets clients linger if their close handler hasn't
 * fired (the listening port is already released by Bun.serve.stop(false)).
 */
const DEFAULT_WS_GRACEFUL_CLOSE_TIMEOUT_MS = 30_000;
/**
 * Grace window we give Bun's `stop(true)` after a server-side `ws.close()`.
 *
 * Empirically the OS port is released within ~10 ms even though the promise
 * itself never resolves under Bun 1.3.11. We wait long enough that the port
 * has been released by the time our own `stop()` resolves.
 */
const BUN_STOP_GRACE_MS = 50;

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

// Structured-Logger handle (from @lastshotlabs/slingshot-core). Used for
// process-safety-net events (`unhandled-rejection`, `uncaught-exception`)
// where consumers expect a JSON-line shape rather than the legacy
// `[runtime-bun] event key=value` text emitted by the local RuntimeBunLogger.
let structuredLogger: Logger = createConsoleLogger({ base: { runtime: 'bun' } });

/**
 * Replace the structured `Logger` used for process-safety-net events. Pass
 * `null` to reset to the default JSON console logger. Returns the previous
 * logger so tests can save and restore state.
 */
export function configureRuntimeBunStructuredLogger(logger: Logger | null): Logger {
  const previous = structuredLogger;
  structuredLogger = logger ?? createConsoleLogger({ base: { runtime: 'bun' } });
  return previous;
}

type BunRuntimeWebSocket = RuntimeWebSocket & {
  readonly data: unknown;
  send(data: string | Buffer): unknown;
  close(code?: number, reason?: string): unknown;
  ping?(): unknown;
  subscribe?(channel: string): unknown;
  unsubscribe?(channel: string): unknown;
};

/**
 * Configuration for the Bun runtime.
 */
export interface BunRuntimeOptions {
  /**
   * Maximum time in milliseconds to wait for each tracked WebSocket's `close`
   * handler to fire after a *forced* drain has issued `ws.close(1001, ...)`.
   *
   * The drain issues a 1001 close to every active socket, then awaits the
   * per-socket close handlers. If any socket's close handler has not fired
   * within this window, the runtime falls through to `Bun.serve.stop(true)`
   * to force the underlying server to release sockets and the listening port.
   *
   * Defaults to {@link DEFAULT_WS_CLOSE_TIMEOUT_MS} (5 s).
   */
  wsCloseTimeoutMs?: number;
  /**
   * Maximum time in milliseconds to wait for each tracked WebSocket's `close`
   * handler to fire on a *graceful* (`stop()` without `true`) shutdown.
   *
   * On graceful stop the runtime broadcasts a 1001 close to every active
   * socket, then waits up to this window for all close handlers to fire. The
   * port is released by `Bun.serve.stop(false)` independently of this timer —
   * the timeout only bounds the wait, it does not force-kill anything.
   *
   * Defaults to {@link DEFAULT_WS_GRACEFUL_CLOSE_TIMEOUT_MS} (30 s).
   */
  gracefulCloseTimeoutMs?: number;
  /**
   * If `true` (default), after `wsCloseTimeoutMs` elapses without all close
   * handlers firing, the runtime calls `Bun.serve.stop(true)` to force-shut
   * remaining sockets. Set to `false` to instead resolve the stop promise
   * without forcing — useful for tests that want to verify timeout behavior
   * without triggering Bun's force-close path.
   */
  forceCloseAfterTimeout?: boolean;
  /**
   * If `true` (default), `bunRuntime()` registers process-level handlers for
   * `unhandledRejection` and `uncaughtException` via
   * {@link installProcessSafetyNet} on construction. Set to `false` to opt
   * out (the calling app is responsible for installing equivalent handlers).
   *
   * Idempotent — multiple `bunRuntime({ installProcessSafetyNet: true })`
   * calls in the same process register the handlers exactly once.
   */
  installProcessSafetyNet?: boolean;
}

interface ResolvedBunRuntimeOptions {
  wsCloseTimeoutMs: number;
  gracefulCloseTimeoutMs: number;
  forceCloseAfterTimeout: boolean;
  installProcessSafetyNet: boolean;
}

function resolveOptions(opts?: BunRuntimeOptions): ResolvedBunRuntimeOptions {
  return {
    wsCloseTimeoutMs:
      typeof opts?.wsCloseTimeoutMs === 'number' && opts.wsCloseTimeoutMs >= 0
        ? opts.wsCloseTimeoutMs
        : DEFAULT_WS_CLOSE_TIMEOUT_MS,
    gracefulCloseTimeoutMs:
      typeof opts?.gracefulCloseTimeoutMs === 'number' && opts.gracefulCloseTimeoutMs >= 0
        ? opts.gracefulCloseTimeoutMs
        : DEFAULT_WS_GRACEFUL_CLOSE_TIMEOUT_MS,
    forceCloseAfterTimeout: opts?.forceCloseAfterTimeout ?? true,
    installProcessSafetyNet: opts?.installProcessSafetyNet ?? true,
  };
}

interface Deferred {
  promise: Promise<void>;
  resolve: () => void;
}

function createDeferred(): Deferred {
  let resolve!: () => void;
  const promise = new Promise<void>(r => {
    resolve = r;
  });
  return { promise, resolve };
}

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

/**
 * Await all per-socket close-handler deferreds (one per tracked socket). If
 * the timeout elapses first, the returned promise resolves with `false` so
 * the caller can decide whether to force-close. Resolves with `true` when
 * every tracked socket's close handler has fired before the timeout.
 *
 * Snapshots the deferreds at call time — sockets that connect after drain
 * begins are not awaited (graceful drain stops accepting new connections
 * before this is invoked).
 */
async function awaitWebSocketCloseHandlers(
  activeSockets: Map<BunRuntimeWebSocket, Deferred>,
  timeoutMs: number,
): Promise<boolean> {
  if (activeSockets.size === 0) return true;
  const pending = Array.from(activeSockets.values()).map(d => d.promise);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<false>(resolve => {
    timer = setTimeout(() => resolve(false), timeoutMs);
  });
  const allDone = Promise.all(pending).then(() => true as const);
  try {
    return await Promise.race([allDone, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Process-level safety net (parity with runtime-node)
// ---------------------------------------------------------------------------

let processHandlersInstalled = false;

function shouldSkipFatalProcessExit(): boolean {
  const argv = process.argv.join(' ');
  return (
    process.env.NODE_ENV === 'test' ||
    process.env.BUN_ENV === 'test' ||
    process.env.SLINGSHOT_DISABLE_FATAL_PROCESS_EXIT === '1' ||
    argv.includes('bun test') ||
    argv.includes('vitest') ||
    process.argv.some(arg => /\.test\.[cm]?[jt]s$/.test(arg))
  );
}

function scheduleFatalProcessExit(): void {
  if (shouldSkipFatalProcessExit()) return;
  process.exitCode = 1;
  const timer = setTimeout(() => process.exit(1), 0);
  timer.unref?.();
}

/**
 * Install once-per-process handlers for `unhandledRejection` and
 * `uncaughtException`. Both are forwarded to the new structured `Logger` (and
 * also surfaced via the legacy `RuntimeBunLogger` for tests that watch the
 * older text-format hook). Fatal process events schedule a process exit after
 * logging so production does not continue in an undefined state. Idempotent.
 *
 * `bunRuntime()` calls this automatically by default — pass
 * `installProcessSafetyNet: false` to opt out.
 */
export function installProcessSafetyNet(): void {
  if (processHandlersInstalled) return;
  processHandlersInstalled = true;
  process.on('unhandledRejection', (reason: unknown) => {
    const fields = {
      message: reason instanceof Error ? reason.message : String(reason),
      stack: reason instanceof Error ? reason.stack : undefined,
    };
    structuredLogger.error('unhandled-rejection', fields);
    activeLogger.error('unhandled-rejection', fields);
    scheduleFatalProcessExit();
  });
  process.on('uncaughtException', (err: Error) => {
    const fields = { message: err.message, stack: err.stack };
    structuredLogger.error('uncaught-exception', fields);
    activeLogger.error('uncaught-exception', fields);
    scheduleFatalProcessExit();
  });
}

/** @internal Resets process safety-net state for test isolation. */
export function resetProcessSafetyNetForTest(): void {
  processHandlersInstalled = false;
  process.removeAllListeners('unhandledRejection');
  process.removeAllListeners('uncaughtException');
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
  activeSockets?: Map<BunRuntimeWebSocket, Deferred>,
): RuntimeWebSocketHandler {
  return {
    ...handler,
    async open(ws: RuntimeWebSocket): Promise<void> {
      const raw = ws as BunRuntimeWebSocket;
      activeSockets?.set(raw, createDeferred());
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
      const deferred = activeSockets?.get(raw);
      try {
        await handler.close(toRuntimeWebSocket(raw), code, reason);
      } catch (err) {
        logRuntimeError('websocket', 'close', err);
      } finally {
        // Resolve the per-socket drain deferred AFTER user-code close handler
        // finishes so awaiting drain code observes the user's side effects.
        deferred?.resolve();
        activeSockets?.delete(raw);
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
export function bunRuntime(options?: BunRuntimeOptions): SlingshotRuntime {
  const resolved = resolveOptions(options);
  if (resolved.installProcessSafetyNet) {
    installProcessSafetyNet();
  }
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
        const activeWebSockets = new Map<BunRuntimeWebSocket, Deferred>();
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
            // Prefer the actually bound port. With port=0 (ephemeral) this is
            // the OS-assigned port — falling back to opts.port=0 would lie.
            // Only fall back to opts.port when Bun did not surface a port AND
            // the caller explicitly asked for a non-zero port. Last-resort
            // 3000 fallback matches Node runtime parity.
            if (typeof server.port === 'number') return server.port;
            if (typeof opts.port === 'number' && opts.port !== 0) return opts.port;
            return 3000;
          },
          async stop(close?: boolean): Promise<void> {
            // Graceful (non-forced) stop. We:
            //   1. Broadcast a 1001 close frame to every tracked WebSocket so
            //      clients learn the server is going away (otherwise they
            //      would only learn on idle-timeout, minutes later).
            //   2. Hand off to `Bun.serve.stop(false)` so the listening port
            //      releases and in-flight HTTP requests can finish.
            //   3. Wait up to `gracefulCloseTimeoutMs` for every per-socket
            //      close handler to fire. If the window elapses we resolve
            //      anyway — graceful means honour the caller's intent without
            //      force-killing anything.
            if (!close) {
              if (activeWebSockets.size > 0) {
                const snapshot = Array.from(activeWebSockets.entries());
                for (const [ws] of snapshot) {
                  try {
                    ws.close(WEBSOCKET_SHUTDOWN_CODE, WEBSOCKET_SHUTDOWN_REASON);
                  } catch (err) {
                    const deferred = activeWebSockets.get(ws);
                    deferred?.resolve();
                    activeWebSockets.delete(ws);
                    logRuntimeError('websocket', 'graceful-shutdown-close', err);
                  }
                }
              }
              const stopP = Promise.resolve(server.stop(false));
              if (activeWebSockets.size > 0) {
                const allClosed = await awaitWebSocketCloseHandlers(
                  activeWebSockets,
                  resolved.gracefulCloseTimeoutMs,
                );
                if (!allClosed) {
                  structuredLogger.warn('websocket-graceful-close-timeout', {
                    timeoutMs: resolved.gracefulCloseTimeoutMs,
                    pending: activeWebSockets.size,
                  });
                }
                activeWebSockets.clear();
              }
              await stopP;
              return;
            }

            // Forced stop with no active websockets: defer to Bun directly.
            if (activeWebSockets.size === 0) {
              await Promise.resolve(server.stop(true));
              return;
            }

            // Forced stop WITH active websockets — explicit drain:
            //   1. Issue ws.close(1001, 'Server shutting down') on each
            //      tracked socket.
            //   2. Await every per-socket close handler firing (bounded by
            //      wsCloseTimeoutMs). This is what guarantees the 1001
            //      close frame flushes before we force-stop the server, and
            //      is the fix for both the indefinite stop() hang and the
            //      1001 -> 1006 clobbering under `bun test`.
            //   3. Kick off server.stop(true) to release the listening port
            //      and any non-WS connections. Note: under Bun 1.3.11 this
            //      promise NEVER resolves once a server-side ws.close() has
            //      been issued, even after every close handler has fired
            //      and the client confirmed the close. We therefore race
            //      Bun's stop(true) against a small grace window and resolve
            //      our own stop() promise either way — by then the OS port
            //      is released (verified empirically in ~10 ms) and any
            //      caller polling for it will see a connection refused.

            // Step 1: snapshot the active sockets and issue a 1001 close
            // frame on each. Snapshot first so close handlers that mutate
            // the map (delete on close) don't disturb iteration.
            const snapshot = Array.from(activeWebSockets.entries());
            for (const [ws] of snapshot) {
              try {
                ws.close(WEBSOCKET_SHUTDOWN_CODE, WEBSOCKET_SHUTDOWN_REASON);
              } catch (err) {
                // Failed to issue the close frame — resolve the deferred
                // so drain doesn't wait on a socket that will never report,
                // and remove from the active map.
                const deferred = activeWebSockets.get(ws);
                deferred?.resolve();
                activeWebSockets.delete(ws);
                logRuntimeError('websocket', 'shutdown-close', err);
              }
            }

            // Step 2: await every per-socket close handler firing, bounded
            // by wsCloseTimeoutMs.
            const allClosed = await awaitWebSocketCloseHandlers(
              activeWebSockets,
              resolved.wsCloseTimeoutMs,
            );

            // Step 3: kick off Bun's stop(true) so the listener releases.
            // Race against a small grace window — Bun 1.3.11's stop(true)
            // promise hangs indefinitely after server-side ws.close() so we
            // don't await it indefinitely. forceCloseAfterTimeout=false
            // skips even initiating the force-stop (used by tests that want
            // to verify the timeout path without triggering force).
            if (allClosed || resolved.forceCloseAfterTimeout) {
              const stopP = Promise.resolve(server.stop(true)).catch((err: unknown) => {
                logRuntimeError('websocket', 'shutdown-stop-force', err);
              });
              await Promise.race([stopP, new Promise<void>(r => setTimeout(r, BUN_STOP_GRACE_MS))]);
            }
            activeWebSockets.clear();
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
