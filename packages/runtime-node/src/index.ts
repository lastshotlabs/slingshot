/**
 * This file is intentionally large. It packs multiple runtime subsystems into a
 * single module to keep the public API surface simple (one `import` provides
 * everything) and because the factory pattern used here — `nodeRuntime()` —
 * must close over all subsystem state.
 *
 * Subsystems contained in this file:
 *   - Logger (text-format and structured)
 *   - Process safety net (unhandledRejection, uncaughtException)
 *   - Password hashing via argon2
 *   - SQLite via better-sqlite3
 *   - HTTP/WebSocket server via @hono/node-server + ws
 *   - Filesystem via node:fs/promises
 *   - Glob via fast-glob
 *
 * See the peer files in src/ for shared error types and the README for usage.
 */

import { createRequire } from 'node:module';
import type BetterSqlite3 from 'better-sqlite3';
import { type Logger, createConsoleLogger } from '@lastshotlabs/slingshot-core';
import type {
  RuntimeFs,
  RuntimeGlob,
  RuntimePassword,
  RuntimeServerFactory,
  RuntimeServerInstance,
  RuntimeSqliteDatabase,
  RuntimeSqlitePreparedStatement,
  RuntimeSqliteRunResult,
  RuntimeSqliteStatement,
  RuntimeWebSocket,
  SlingshotRuntime,
} from '@lastshotlabs/slingshot-core';

/**
 * Runtime-specific error classes thrown by the Node adapter for server,
 * WebSocket, request-body, and shutdown failures.
 */
export {
  NodeRuntimeError,
  NodeServerError,
  NodeWebSocketError,
  NodeContentLengthError,
  NodeRequestBodyTooLargeError,
  NodeShutdownError,
} from './errors';

// ---------------------------------------------------------------------------
// Logger — structured, redirectable, no-op-friendly
// ---------------------------------------------------------------------------

/**
 * Structured logging hook. The runtime emits operational events (websocket
 * handler errors, upgrade timeouts, body-size rejections, drain timeouts) to
 * the configured logger. Defaults to {@link defaultLogger} which mirrors the
 * previous `console.warn` / `console.error` behaviour.
 *
 * Pass a custom logger via {@link configureRuntimeNodeLogger} to forward into
 * pino, bunyan, OpenTelemetry logs, etc. — see the README for examples.
 */
export interface RuntimeNodeLogger {
  warn(event: string, fields?: Record<string, unknown>): void;
  error(event: string, fields?: Record<string, unknown>): void;
}

function formatLogLine(event: string, fields?: Record<string, unknown>): string {
  if (!fields) return `[runtime-node] ${event}`;
  // Promote scalar field values into the message line so log scrapers and
  // simple text-based assertions can match on phase/key/etc. without parsing
  // an object stringified to `[object Object]`.
  const parts: string[] = [];
  for (const [k, v] of Object.entries(fields)) {
    if (v === undefined) continue;
    if (k === 'stack') continue; // stack appended separately
    if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
      parts.push(`${k}=${String(v)}`);
    }
  }
  const summary = parts.length > 0 ? ` ${parts.join(' ')}` : '';
  return `[runtime-node] ${event}${summary}`;
}

const defaultLogger: RuntimeNodeLogger = {
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

let activeLogger: RuntimeNodeLogger = defaultLogger;

/**
 * Replace the runtime's structured logger. Pass `null` to reset to the default
 * console-backed logger. Returns the previous logger so tests can save and
 * restore the state.
 */
export function configureRuntimeNodeLogger(logger: RuntimeNodeLogger | null): RuntimeNodeLogger {
  const previous = activeLogger;
  activeLogger = logger ?? defaultLogger;
  return previous;
}

function logWebSocketHandlerError(
  phase: 'open' | 'message' | 'close' | 'pong',
  error: unknown,
): void {
  activeLogger.error('websocket-handler-error', {
    phase,
    message: error instanceof Error ? error.message : String(error),
    stack: error instanceof Error ? error.stack : undefined,
  });
}

// Structured `Logger` (slingshot-core) used for cross-cutting events that
// don't belong on the legacy text-format `RuntimeNodeLogger` surface
// (process safety net, upgrade timeouts with rich fields, fetch error
// callback throws). Lives alongside `activeLogger` for backwards
// compatibility — keep both wired so existing consumers continue to work.
let structuredLogger: Logger = createConsoleLogger({ base: { runtime: 'node' } });

/**
 * Replace the structured `Logger`. Pass `null` to reset to the default JSON
 * console logger. Returns the previous logger so tests can save and restore
 * state.
 */
export function configureRuntimeNodeStructuredLogger(logger: Logger | null): Logger {
  const previous = structuredLogger;
  structuredLogger = logger ?? createConsoleLogger({ base: { runtime: 'node' } });
  return previous;
}

// ---------------------------------------------------------------------------
// Process-level safety net
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
 * `uncaughtException`. Both are forwarded to the structured logger, then a
 * process exit is scheduled so production does not continue in an undefined
 * state.
 *
 * Idempotent — safe to call across multiple `nodeRuntime()` invocations in the
 * same process.
 */
export function installProcessSafetyNet(): void {
  if (processHandlersInstalled) return;
  processHandlersInstalled = true;
  process.on('unhandledRejection', (reason: unknown) => {
    activeLogger.error('unhandled-rejection', {
      message: reason instanceof Error ? reason.message : String(reason),
      stack: reason instanceof Error ? reason.stack : undefined,
    });
    scheduleFatalProcessExit();
  });
  process.on('uncaughtException', (err: Error) => {
    activeLogger.error('uncaught-exception', { message: err.message, stack: err.stack });
    scheduleFatalProcessExit();
  });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function toBufferChunk(value: unknown): Buffer | null {
  if (typeof value === 'string') return Buffer.from(value);
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof ArrayBuffer) return Buffer.from(value);
  if (ArrayBuffer.isView(value)) {
    return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  }
  return null;
}

function stringifyWsPayload(rawData: unknown): string {
  if (typeof rawData === 'string') return rawData;

  const singleChunk = toBufferChunk(rawData);
  if (singleChunk) return singleChunk.toString();

  if (Array.isArray(rawData)) {
    const chunks: Buffer[] = [];
    for (const entry of rawData) {
      const chunk = toBufferChunk(entry);
      if (!chunk) {
        throw new TypeError('Unsupported WebSocket message chunk type');
      }
      chunks.push(chunk);
    }
    return Buffer.concat(chunks).toString();
  }

  throw new TypeError('Unsupported WebSocket message payload type');
}

function resolveNodeRequestListener(
  first: unknown,
  second?: unknown,
): ((...args: unknown[]) => void) | null {
  if (typeof second === 'function') return second as (...args: unknown[]) => void;
  if (typeof first === 'function') return first as (...args: unknown[]) => void;
  return null;
}

function resolveListenPort(port: number | undefined): number {
  return port ?? 3000;
}

function attachNodeRequestListener(
  server: { on(event: 'request', listener: (...args: unknown[]) => void): unknown },
  first: unknown,
  second?: unknown,
): void {
  const listener = resolveNodeRequestListener(first, second);
  if (listener) {
    server.on('request', listener);
  }
}

function deleteChannelIfEmpty(
  channels: Map<string, Set<unknown>>,
  channel: string,
  subs: Set<unknown> | undefined,
): void {
  if (subs?.size === 0) channels.delete(channel);
}

function isEnoentError(err: unknown): err is NodeJS.ErrnoException {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as NodeJS.ErrnoException).code === 'ENOENT'
  );
}

/**
 * Parse a `Content-Length` header to a non-negative integer, or `null` if the
 * header is missing or malformed. Used by the request body limiter.
 */
function parseContentLength(header: string | null): number | null {
  if (!header) return null;
  const trimmed = header.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  const n = Number.parseInt(trimmed, 10);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

function makePayloadTooLargeResponse(req: Request, received: number, maxBody: number): Response {
  activeLogger.warn('request-body-too-large', {
    declared: received,
    maxBody,
    method: req.method,
    url: req.url,
  });
  return new Response('Payload Too Large', { status: 413 });
}

function concatBodyChunks(chunks: Uint8Array[], total: number): Uint8Array {
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

async function enforceRequestBodyLimit(req: Request, maxBody: number): Promise<Request | Response> {
  const declared = parseContentLength(req.headers.get('content-length'));
  if (declared !== null && declared > maxBody) {
    return makePayloadTooLargeResponse(req, declared, maxBody);
  }

  if (req.method === 'GET' || req.method === 'HEAD' || !req.body) {
    return req;
  }

  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBody) {
        await reader.cancel().catch(() => {});
        return makePayloadTooLargeResponse(req, total, maxBody);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const body = concatBodyChunks(chunks, total);
  const bodyBuffer = new ArrayBuffer(body.byteLength);
  new Uint8Array(bodyBuffer).set(body);
  const init: RequestInit & { duplex: 'half' } = { body: bodyBuffer, duplex: 'half' };
  return new Request(req, init);
}

/** @internal Exposes low-level Node runtime helpers for unit-test access. Not part of the public API. */
export const runtimeNodeInternals = {
  toBufferChunk,
  stringifyWsPayload,
  resolveListenPort,
  resolveNodeRequestListener,
  attachNodeRequestListener,
  deleteChannelIfEmpty,
  parseContentLength,
  enforceRequestBodyLimit,
};

// ---------------------------------------------------------------------------
// Password — argon2
// ---------------------------------------------------------------------------

/**
 * Creates a `RuntimePassword` implementation backed by the `argon2` package.
 *
 * Both `hash` and `verify` dynamically `import('argon2')` at call time so the
 * dependency is a true peer dep — if `argon2` is not installed the error is
 * surfaced at first use rather than at module load time.
 *
 * @throws {Error} If the `argon2` package is not installed, `import('argon2')`
 *   throws a module-not-found error at first call to `hash` or `verify`. The
 *   error surfaces at use time, not when `createNodePassword()` is called,
 *   because the import is dynamic.
 */
function createNodePassword(): RuntimePassword {
  return {
    async hash(plain: string): Promise<string> {
      const argon2 = await import('argon2');
      return argon2.hash(plain);
    },
    async verify(plain: string, hash: string): Promise<boolean> {
      const argon2 = await import('argon2');
      try {
        return await argon2.verify(hash, plain);
      } catch {
        return false;
      }
    },
  };
}

// ---------------------------------------------------------------------------
// SQLite — better-sqlite3
// ---------------------------------------------------------------------------

function adaptNodeSqlite(db: BetterSqlite3.Database): RuntimeSqliteDatabase {
  return {
    run(sql: string, ...params: unknown[]): void {
      db.prepare(sql).run(...params);
    },
    query<T = unknown>(sql: string): RuntimeSqliteStatement<T> {
      const stmt = db.prepare<unknown[], T>(sql);
      return {
        get(...params: unknown[]): T | null {
          return stmt.get(...params) ?? null;
        },
        all(...params: unknown[]): T[] {
          return stmt.all(...params);
        },
        run(...params: unknown[]): void {
          stmt.run(...params);
        },
      };
    },
    prepare<T = unknown>(sql: string): RuntimeSqlitePreparedStatement<T> {
      const stmt = db.prepare<unknown[], T>(sql);
      return {
        get(...params: unknown[]): T | null {
          return stmt.get(...params) ?? null;
        },
        all(...params: unknown[]): T[] {
          return stmt.all(...params);
        },
        run(...params: unknown[]): RuntimeSqliteRunResult {
          const result = stmt.run(...params);
          return { changes: result.changes };
        },
      };
    },
    transaction<T>(fn: () => T): () => T {
      return db.transaction(fn);
    },
    close(): void {
      db.close();
    },
  };
}

// ---------------------------------------------------------------------------
// Runtime-level options
// ---------------------------------------------------------------------------

/**
 * Per-runtime knobs for the Node.js runtime. None are required — defaults
 * match the documented behaviour. Pass via `nodeRuntime(options)`.
 */
export interface NodeRuntimeOptions {
  /**
   * Maximum time in milliseconds to wait for a pending WebSocket upgrade
   * handshake to complete (i.e. for the fetch handler to call `upgrade()`)
   * before destroying the underlying socket.
   *
   * Mirrors `RuntimeServerOptions.upgradeTimeoutMs` from `@lastshotlabs/slingshot-core`.
   * When both are provided the per-listen `upgradeTimeoutMs` wins. Defaults
   * to `30_000` (30 s).
   */
  wsUpgradeTimeoutMs?: number;
  /**
   * Maximum time in milliseconds `instance.stop()` will wait for in-flight
   * WebSocket upgrade handshakes to settle before forcibly destroying the
   * sockets and continuing teardown. Defaults to `5_000` (5 s).
   */
  gracefulUpgradeDrainMs?: number;
}

interface ResolvedNodeRuntimeOptions {
  wsUpgradeTimeoutMs: number;
  gracefulUpgradeDrainMs: number;
}

function resolveNodeRuntimeOptions(opts?: NodeRuntimeOptions): ResolvedNodeRuntimeOptions {
  return {
    wsUpgradeTimeoutMs:
      typeof opts?.wsUpgradeTimeoutMs === 'number' && opts.wsUpgradeTimeoutMs > 0
        ? opts.wsUpgradeTimeoutMs
        : 30_000,
    gracefulUpgradeDrainMs:
      typeof opts?.gracefulUpgradeDrainMs === 'number' && opts.gracefulUpgradeDrainMs >= 0
        ? opts.gracefulUpgradeDrainMs
        : 5_000,
  };
}

// ---------------------------------------------------------------------------
// HTTP server — @hono/node-server + ws
// ---------------------------------------------------------------------------

/**
 * Creates a `RuntimeServerFactory` backed by `@hono/node-server`.
 *
 * Implements the full {@link RuntimeServerOptions} contract:
 * - `maxRequestBodySize` — requests whose body exceeds the limit are rejected
 *   with `413 Payload Too Large` before reaching the handler. Defaults to
 *   128 MiB to match the Bun runtime.
 * - `tls` — when present, the server is started over HTTPS.
 * - `error` — async rejections in `fetch` are forwarded to this callback.
 * - `websocket.idleTimeout` — server-driven ping every `idleTimeout/2` seconds;
 *   any connection without a pong response within `idleTimeout` is closed
 *   with code `1001` (going away).
 * - `websocket.perMessageDeflate` — forwarded to `ws.WebSocketServer`.
 * - `websocket.publishToSelf` — when true, `instance.publish()` delivers the
 *   message to the publishing socket as well as other subscribers.
 *
 * The returned `RuntimeServerInstance.stop()` accepts a graceful timeout:
 * - `stop()` — wait for in-flight requests to finish naturally.
 * - `stop(true)` — force-close all sockets immediately (Node ≥18.2).
 * - `stop({ timeoutMs })` — drain for up to `timeoutMs` ms then force-close any
 *   remaining sockets. Recommended for production deploys behind a load balancer.
 */
function createNodeServer(runtimeOpts: ResolvedNodeRuntimeOptions): RuntimeServerFactory {
  return {
    async listen(opts): Promise<RuntimeServerInstance> {
      const { serve, getRequestListener } = await import('@hono/node-server');

      // Validate mutually exclusive transport options up-front. `unix` and
      // `port`/`hostname` bind to fundamentally different transports, so
      // accepting both produces confusing behaviour where one silently wins.
      if (opts.unix !== undefined && (opts.port !== undefined || opts.hostname !== undefined)) {
        throw new Error(
          '[runtime-node] RuntimeServerOptions.unix is mutually exclusive with port/hostname',
        );
      }

      const maxHeaderSize = opts.maxHeaderSize ?? 16_384;
      const headersTimeoutMs = opts.headersTimeout ?? 60_000;
      const requestTimeoutMs = opts.requestTimeout ?? 300_000;

      let httpServer: import('node:http').Server;
      if (opts.tls) {
        const https = await import('node:https');
        const tlsServer = https.createServer({
          key: opts.tls.key as string | Buffer | undefined,
          cert: opts.tls.cert as string | Buffer | undefined,
          maxHeaderSize,
        });
        // https.Server extends http.Server at runtime, but the @types/node
        // class hierarchy does not declare the inheritance, so widen here.
        httpServer = tlsServer as unknown as import('node:http').Server;
      } else {
        const { createServer } = await import('node:http');
        httpServer = createServer({ maxHeaderSize });
      }

      // Slowloris / slow-request hardening. Both are writeable properties on
      // http.Server post-construction; setting them before listen() ensures
      // the very first connection is governed by the configured limits.
      httpServer.headersTimeout = headersTimeoutMs;
      httpServer.requestTimeout = requestTimeoutMs;

      let port = resolveListenPort(opts.port);
      const maxBody = opts.maxRequestBodySize ?? 128 * 1024 * 1024;
      const errorHandler = opts.error;
      const upgradedRequests = new WeakSet<Request>();

      const alreadySentResponse = (): Response =>
        new Response(null, { headers: { 'x-hono-already-sent': 'true' } });

      // Track in-flight fetch handlers so graceful drain can wait for them.
      // httpServer.close() waits for sockets to drain, but a slow handler that
      // hasn't yet written the response holds the socket open — we want stop()
      // to expose that explicitly so callers can observe drain progress.
      let inFlight = 0;
      let drainResolve: (() => void) | undefined;
      const onHandlerEnd = (): void => {
        inFlight -= 1;
        if (inFlight === 0 && drainResolve) {
          drainResolve();
          drainResolve = undefined;
        }
      };

      const fetchHandler = async (req: Request): Promise<Response> => {
        inFlight += 1;
        try {
          const limitedReq = await enforceRequestBodyLimit(req, maxBody);
          if (limitedReq instanceof Response) return limitedReq;
          const response = await opts.fetch(limitedReq);
          if (upgradedRequests.has(limitedReq)) return alreadySentResponse();
          return response;
        } catch (err) {
          if (upgradedRequests.has(req)) return alreadySentResponse();
          const wrapped = err instanceof Error ? err : new Error(String(err));
          if (errorHandler) {
            // P-NODE-4: a user error callback that itself throws/rejects must
            // not silently disappear. Surface it through the structured logger
            // and (when no global `uncaughtException` handler is installed)
            // emit the uncaughtException event so the host application's
            // crash-handling path observes it. Without this, double-error
            // scenarios are completely invisible.
            try {
              return await errorHandler(wrapped);
            } catch (callbackErr) {
              const innerErr =
                callbackErr instanceof Error ? callbackErr : new Error(String(callbackErr));
              structuredLogger.error('fetch-error-callback-threw', {
                originalError: wrapped.message,
                callbackError: innerErr.message,
                stack: innerErr.stack,
              });
              activeLogger.error('fetch-error-callback-threw', {
                originalError: wrapped.message,
                callbackError: innerErr.message,
                stack: innerErr.stack,
              });
              if (process.listenerCount('uncaughtException') === 0) {
                // No global handler — re-emit so the default Node behaviour
                // (or a later-installed handler) sees the failure.
                process.emit('uncaughtException', innerErr);
              } else {
                process.emit('uncaughtException', innerErr);
              }
              return new Response('Internal Server Error', { status: 500 });
            }
          }
          activeLogger.error('fetch-handler-error', {
            message: wrapped.message,
            stack: wrapped.stack,
          });
          return new Response('Internal Server Error', { status: 500 });
        } finally {
          onHandlerEnd();
        }
      };

      // Track active sockets so graceful drain can wait for in-flight responses
      // to complete before closing the server.
      const activeSockets = new Set<import('node:net').Socket>();
      httpServer.on('connection', socket => {
        activeSockets.add(socket);
        socket.once('close', () => activeSockets.delete(socket));
      });
      httpServer.on('secureConnection', socket => {
        // TLSSocket extends net.Socket at runtime; the @types/node hierarchy
        // does not let TS infer the structural relationship from this listener
        // overload, so we narrow at the boundary.
        const netSocket = socket as unknown as import('node:net').Socket;
        activeSockets.add(netSocket);
        socket.once('close', () => activeSockets.delete(netSocket));
      });

      // -- WebSocket support via `ws` --
      type WsWebSocket = import('ws').WebSocket;
      let wss: import('ws').WebSocketServer | undefined;
      const channels = new Map<string, Set<WsWebSocket>>();
      const allSockets = new Set<WsWebSocket>();
      const wsHandler = opts.websocket;
      const publishToSelf = wsHandler?.publishToSelf === true;

      // Track which RuntimeWebSocket handle published the current message so
      // publish() can skip it when publishToSelf is false. Set by RuntimeWebSocket.send
      // callers via a wrapper - we use a WeakMap from raw ws to the RuntimeWebSocket.
      const wsToRt = new WeakMap<WsWebSocket, RuntimeWebSocket>();

      const pendingUpgrades = new Map<
        string,
        {
          req: import('node:http').IncomingMessage;
          socket: import('node:stream').Duplex;
          head: Buffer;
          timer: ReturnType<typeof setTimeout>;
          resolveUpgrade: () => void;
          removeCloseListener: () => void;
          /** Atomic cleanup — see clearPendingUpgrade(). */
          cleanedUp: boolean;
        }
      >();
      // P-NODE-3: track in-flight upgrade-handshake promises so graceful
      // stop can await their settlement instead of severing the underlying
      // socket mid-handshake (which would leave a half-completed connection
      // and leak handler state).
      const pendingUpgradePromises = new Set<Promise<void>>();

      // P-NODE-6: a single helper to atomically remove a pending upgrade
      // from the map AND clear the timer. Either the timer firing OR an
      // early socket-close event can arrive first; both must be safe to
      // call in either order without double-destroying the socket or
      // leaking the timer reference.
      const clearPendingUpgrade = (
        key: string,
        opts: { destroySocket: boolean; reason?: string } = { destroySocket: false },
      ): void => {
        const pending = pendingUpgrades.get(key);
        if (!pending || pending.cleanedUp) return;
        pending.cleanedUp = true;
        clearTimeout(pending.timer);
        pendingUpgrades.delete(key);
        pending.removeCloseListener();
        pending.resolveUpgrade();
        if (opts.destroySocket) {
          try {
            pending.socket.destroy();
          } catch {
            // ignore — socket may already be torn down
          }
        }
      };

      // Idle-timeout heartbeat machinery. We track per-socket "alive" markers
      // and ping at idleTimeout/2 intervals; any socket that has not pong'd
      // since the last sweep is closed with code 1001. The timer is created
      // exactly once per `listen()` call (not per-upgrade) and is cleared in
      // `stop()`. We also flip `heartbeatStopped` to guard the interval
      // callback against late firings — Node may dispatch a queued tick after
      // `clearInterval` if the server is stopping while a tick is in flight.
      const aliveSockets = new WeakSet<WsWebSocket>();
      let heartbeatTimer: ReturnType<typeof setInterval> | undefined;
      let heartbeatStopped = false;

      if (wsHandler) {
        const { Writable } = await import('node:stream');
        const { ServerResponse } = await import('node:http');
        const { WebSocketServer } = await import('ws');
        wss = new WebSocketServer({
          noServer: true,
          perMessageDeflate: wsHandler.perMessageDeflate === true,
        });

        // P-NODE-2: configurable upgrade timeout (default 30s). Per-listen
        // `opts.upgradeTimeoutMs` wins over runtime-level `wsUpgradeTimeoutMs`,
        // which itself is read from `nodeRuntime({ wsUpgradeTimeoutMs })`.
        const upgradeTimeoutMs = opts.upgradeTimeoutMs ?? runtimeOpts.wsUpgradeTimeoutMs;

        httpServer.on('upgrade', (req, socket, head) => {
          const key = req.headers['sec-websocket-key'];
          if (!key) {
            socket.destroy();
            return;
          }

          // Resolve the remote IP at upgrade time — by stop() the socket may
          // be destroyed, so capture the value now to surface in logs. The
          // `socket` parameter is a Duplex but on the upgrade path it's a
          // net.Socket / TLSSocket instance, both of which expose
          // `remoteAddress`. Narrow at the boundary.
          const remoteAddress =
            (socket as unknown as { remoteAddress?: string }).remoteAddress ?? null;

          // P-NODE-3: each upgrade gets a deferred we resolve from the
          // upgrade() entrypoint OR from the timer/socket-close cleanup.
          // Tracked in `pendingUpgradePromises` so graceful stop can await.
          let resolvePromise!: () => void;
          const upgradePromise = new Promise<void>(r => {
            resolvePromise = r;
          });
          pendingUpgradePromises.add(upgradePromise);
          upgradePromise.then(() => pendingUpgradePromises.delete(upgradePromise));

          const timer = setTimeout(() => {
            // Idempotent — `clearPendingUpgrade` checks `cleanedUp`.
            clearPendingUpgrade(key, { destroySocket: true });
            structuredLogger.warn('websocket-upgrade-timeout', {
              key,
              timeoutMs: upgradeTimeoutMs,
              remoteAddress,
            });
            // Legacy text-format hook for tests that watch the older logger.
            activeLogger.warn('websocket-upgrade-timeout', {
              key,
              timeoutMs: upgradeTimeoutMs,
              remoteAddress: remoteAddress ?? 'unknown',
            });
          }, upgradeTimeoutMs);

          // P-NODE-6: if the underlying socket closes before either the
          // timer fires or `upgrade()` is called, drop the pending entry
          // and clear the timer atomically. Without this the timer would
          // fire on a destroyed socket and emit a misleading timeout warn.
          const onSocketClose = (): void => {
            clearPendingUpgrade(key, { destroySocket: false });
          };
          socket.once('close', onSocketClose);

          pendingUpgrades.set(key, {
            req,
            socket,
            head,
            timer,
            resolveUpgrade: resolvePromise,
            removeCloseListener() {
              try {
                socket.removeListener('close', onSocketClose);
              } catch {
                // ignore
              }
            },
            cleanedUp: false,
          });

          const dummySocket = new Writable({
            write(_chunk: unknown, _encoding: string, cb: () => void) {
              cb();
            },
          });

          const res = new ServerResponse(req);
          // assignSocket() requires a net.Socket but ServerResponse only
          // writes to it — a Writable stub is functionally equivalent for
          // the upgrade path where the real socket is owned by the WS upgrade.
          res.assignSocket(dummySocket as unknown as import('node:net').Socket);
          httpServer.emit('request', req, res);
        });

        const idleTimeoutSec = wsHandler.idleTimeout;
        if (idleTimeoutSec && idleTimeoutSec > 0) {
          const intervalMs = Math.max(1000, Math.floor((idleTimeoutSec * 1000) / 2));
          heartbeatTimer = setInterval(() => {
            // Late-firing guard. Node may dispatch a queued tick after
            // `clearInterval` if the server is stopping while the tick is
            // already on the macrotask queue. A no-op return prevents the
            // sweep from racing with socket teardown that's already
            // happening in `stop()`.
            if (heartbeatStopped) return;
            for (const ws of allSockets) {
              if (!aliveSockets.has(ws)) {
                // terminate() over close() — close() waits up to 30s for the
                // peer's close frame, which a paused/unreachable client will
                // never send. terminate() drops the socket immediately and
                // still fires the 'close' event (with code 1006).
                try {
                  ws.terminate();
                } catch {
                  // ignore — socket may already be torn down
                }
                continue;
              }
              aliveSockets.delete(ws);
              try {
                ws.ping();
              } catch {
                // ignore — handled on next sweep
              }
            }
          }, intervalMs);
          // Don't keep the event loop alive solely for heartbeat ticks.
          (heartbeatTimer as { unref?: () => void }).unref?.();
        }
      }

      await new Promise<void>((resolve, reject) => {
        const onError = (err: Error) => reject(err);
        httpServer.on('error', onError);

        if (opts.unix !== undefined) {
          // Unix-socket bind: bypass `serve()` (which always calls
          // `httpServer.listen(port, hostname, ...)`) and wire the request
          // listener up directly via @hono/node-server's `getRequestListener`.
          // This keeps Request/Response translation identical to the TCP path.
          const listener = getRequestListener(fetchHandler);
          attachNodeRequestListener(
            httpServer as {
              on(event: 'request', listener: (...args: unknown[]) => void): unknown;
            },
            listener,
          );
          httpServer.listen(opts.unix, () => {
            httpServer.removeListener('error', onError);
            resolve();
          });
          return;
        }

        serve(
          {
            fetch: fetchHandler,
            port,
            hostname: opts.hostname,
            createServer: ((first: unknown, second?: unknown) => {
              attachNodeRequestListener(
                httpServer as {
                  on(event: 'request', listener: (...args: unknown[]) => void): unknown;
                },
                first,
                second,
              );
              return httpServer;
            }) as typeof import('node:http').createServer,
          },
          info => {
            port = info.port;
            httpServer.removeListener('error', onError);
            resolve();
          },
        );
      });

      function wrapWs(ws: WsWebSocket, data: unknown): RuntimeWebSocket {
        const handler = wsHandler;
        if (!handler) {
          throw new Error('WebSocket handler is not configured');
        }
        const subscribedChannels = new Set<string>();
        allSockets.add(ws);
        aliveSockets.add(ws);

        const rtWs: RuntimeWebSocket = {
          data,
          send(d: string | Buffer) {
            try {
              ws.send(d);
            } catch (err) {
              logWebSocketHandlerError('message', err);
            }
          },
          close(code?: number, reason?: string) {
            ws.close(code, reason);
          },
          ping() {
            ws.ping();
          },
          subscribe(channel: string) {
            subscribedChannels.add(channel);
            let subs = channels.get(channel);
            if (!subs) {
              subs = new Set();
              channels.set(channel, subs);
            }
            subs.add(ws);
          },
          unsubscribe(channel: string) {
            subscribedChannels.delete(channel);
            const subs = channels.get(channel);
            subs?.delete(ws);
            deleteChannelIfEmpty(channels as Map<string, Set<unknown>>, channel, subs);
          },
        };

        wsToRt.set(ws, rtWs);

        ws.on('message', rawData => {
          aliveSockets.add(ws);
          void Promise.resolve(handler.message(rtWs, stringifyWsPayload(rawData))).catch(
            (error: unknown) => {
              logWebSocketHandlerError('message', error);
            },
          );
        });
        ws.on('pong', () => {
          aliveSockets.add(ws);
          if (handler.pong) {
            try {
              handler.pong(rtWs);
            } catch (error) {
              logWebSocketHandlerError('pong', error);
            }
          }
        });
        // Tracks whether the per-socket cleanup has run already. Both `close`
        // and `error` can fire on the same socket (and `error` is sometimes
        // emitted without a subsequent `close`). Without this guard the close
        // handler would run twice — emitting two close events to the user
        // handler and double-decrementing channel counters.
        let cleanedUp = false;
        const cleanupSocket = (code: number | undefined, reason: unknown): void => {
          if (cleanedUp) return;
          cleanedUp = true;
          // Always clean up channel membership — not only those the user
          // explicitly unsubscribed from. Without this every disconnected client
          // would leak into the channel map (the original report's leak).
          for (const [name, subs] of channels) {
            if (subs.delete(ws)) {
              deleteChannelIfEmpty(channels as Map<string, Set<unknown>>, name, subs);
            }
          }
          allSockets.delete(ws);
          subscribedChannels.clear();
          void Promise.resolve(
            handler.close(rtWs, code ?? 1006, stringifyWsPayload(reason ?? '')),
          ).catch((error: unknown) => {
            logWebSocketHandlerError('close', error);
          });
        };

        ws.on('close', (code, reason) => {
          cleanupSocket(code, reason);
        });
        // `error` may fire without a corresponding `close` (e.g. abrupt
        // socket-level errors). Run the same cleanup so the socket is removed
        // from `allSockets` and the heartbeat sweeper does not keep pinging a
        // dead WebSocket on subsequent ticks.
        ws.on('error', () => {
          cleanupSocket(1006, '');
        });

        return rtWs;
      }

      const stop = async (
        opts?: boolean | { timeoutMs?: number; closeActiveConnections?: boolean },
      ): Promise<void> => {
        const force = opts === true || (typeof opts === 'object' && opts?.closeActiveConnections);
        const timeoutMs = typeof opts === 'object' ? opts?.timeoutMs : undefined;

        // P-NODE-3: drain pending upgrade handshakes. Mark each as cleaned
        // up (atomic with timer-clear via `clearPendingUpgrade`), destroy
        // the socket, then await every in-flight upgrade promise so the
        // graceful path doesn't return before handshake handlers settle.
        for (const key of Array.from(pendingUpgrades.keys())) {
          clearPendingUpgrade(key, { destroySocket: true });
        }
        if (pendingUpgradePromises.size > 0) {
          const drainMs = runtimeOpts.gracefulUpgradeDrainMs;
          let timer: ReturnType<typeof setTimeout> | undefined;
          const timeout = new Promise<'timeout'>(resolve => {
            timer = setTimeout(() => resolve('timeout'), drainMs);
          });
          const drained = Promise.allSettled(Array.from(pendingUpgradePromises)).then(
            () => 'drained' as const,
          );
          try {
            const outcome = await Promise.race([drained, timeout]);
            if (outcome === 'timeout') {
              structuredLogger.warn('websocket-upgrade-drain-timeout', {
                drainMs,
                remaining: pendingUpgradePromises.size,
              });
            }
          } finally {
            if (timer) clearTimeout(timer);
          }
        }
        // Stop the heartbeat sweeper before closing sockets. We flip the
        // `heartbeatStopped` flag first so a tick that was already on the
        // macrotask queue when `clearInterval` was called returns immediately
        // without sweeping the (now being torn down) socket set.
        heartbeatStopped = true;
        if (heartbeatTimer) {
          clearInterval(heartbeatTimer);
          heartbeatTimer = undefined;
        }
        // Close all open websockets cleanly so handshake completion fires.
        if (wss) {
          for (const ws of allSockets) {
            try {
              ws.close(1001, 'server shutting down');
            } catch {
              // ignore
            }
          }
          wss.close();
        }

        // Wait for in-flight fetch handlers before tearing down sockets.
        // httpServer.close() resolves on socket close, not handler completion —
        // a slow handler mid-write can have its socket ripped away on a force
        // timeout. Tracking inFlight lets us guarantee handler completion (or
        // a clean timeout) before falling through to socket teardown.
        if (inFlight > 0 && !force) {
          await new Promise<void>(resolveDrain => {
            let drainTimer: ReturnType<typeof setTimeout> | undefined;
            const settle = () => {
              drainResolve = undefined;
              if (drainTimer) clearTimeout(drainTimer);
              resolveDrain();
            };
            drainResolve = settle;
            if (timeoutMs) {
              drainTimer = setTimeout(() => {
                activeLogger.warn('graceful-stop-handler-timeout', {
                  timeoutMs,
                  inFlight,
                });
                settle();
              }, timeoutMs);
            }
          });
        }

        await new Promise<void>(resolve => {
          let drainTimer: ReturnType<typeof setTimeout> | undefined;
          let resolved = false;
          const settle = () => {
            if (resolved) return;
            resolved = true;
            if (drainTimer) clearTimeout(drainTimer);
            resolve();
          };
          if (timeoutMs && !force) {
            drainTimer = setTimeout(() => {
              activeLogger.warn('graceful-stop-timeout', {
                timeoutMs,
                remainingSockets: activeSockets.size,
              });
              (httpServer as { closeAllConnections?: () => void }).closeAllConnections?.();
              for (const socket of activeSockets) {
                socket.destroy();
              }
              settle();
            }, timeoutMs);
          }
          if (force) {
            (httpServer as { closeAllConnections?: () => void }).closeAllConnections?.();
            for (const socket of activeSockets) {
              socket.destroy();
            }
          }

          httpServer.close(() => {
            settle();
          });
        });
      };

      return {
        get port(): number {
          return port;
        },
        // Cast retains compatibility with the contract's
        // `(closeActiveConnections?: boolean) => Promise<void>` while exposing
        // the richer object-form locally.
        stop: stop as RuntimeServerInstance['stop'],
        upgrade(req: Request, upgradeOpts: { data: unknown }): boolean {
          if (!wss || !wsHandler) return false;
          const key = req.headers.get('sec-websocket-key');
          if (!key) return false;
          const pending = pendingUpgrades.get(key);
          if (!pending) return false;
          // P-NODE-6: atomic cleanup — clears timer, removes from map, and
          // disposes the socket-close listener installed during upgrade.
          clearPendingUpgrade(key, { destroySocket: false });
          try {
            wss.handleUpgrade(pending.req, pending.socket, pending.head, ws => {
              const rtWs = wrapWs(ws, upgradeOpts.data);
              void Promise.resolve(wsHandler.open(rtWs)).catch((error: unknown) => {
                logWebSocketHandlerError('open', error);
              });
            });
            upgradedRequests.add(req);
          } catch (err) {
            activeLogger.error('websocket-upgrade-failed', {
              message: err instanceof Error ? err.message : String(err),
              stack: err instanceof Error ? err.stack : undefined,
            });
            return false;
          }
          return true;
        },
        publish(channel: string, message: string, fromWs?: WsWebSocket): void {
          const subs = channels.get(channel);
          if (!subs) return;
          for (const ws of subs) {
            if (!publishToSelf && fromWs && ws === fromWs) continue;
            // ws.OPEN === 1
            if (ws.readyState !== 1) continue;
            // Per-subscriber try/catch — a single bad subscriber must not
            // crash the entire fan-out. ws.send() can throw synchronously
            // when the underlying socket is half-closed or write-buffered
            // beyond the high-water mark.
            try {
              ws.send(message);
            } catch (err) {
              activeLogger.error('publish-send-failed', {
                channel,
                message: err instanceof Error ? err.message : String(err),
              });
            }
          }
        },
      } satisfies RuntimeServerInstance;
    },
  };
}

// ---------------------------------------------------------------------------
// Filesystem — Node.js built-ins
// ---------------------------------------------------------------------------

function createNodeFs(): RuntimeFs {
  return {
    async write(path: string, data: string | Uint8Array): Promise<void> {
      const { writeFile } = await import('node:fs/promises');
      await writeFile(path, data);
    },
    async readFile(path: string): Promise<Uint8Array | null> {
      const { readFile } = await import('node:fs/promises');
      try {
        return new Uint8Array(await readFile(path));
      } catch (err: unknown) {
        if (isEnoentError(err)) {
          return null;
        }
        throw err;
      }
    },
    async exists(path: string): Promise<boolean> {
      const { access } = await import('node:fs/promises');
      try {
        await access(path);
        return true;
      } catch {
        return false;
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Glob — fast-glob
// ---------------------------------------------------------------------------

function createNodeGlob(): RuntimeGlob {
  return {
    async scan(pattern: string, options?: { cwd?: string }): Promise<string[]> {
      const fg = await import('fast-glob');
      return fg.default(pattern, { cwd: options?.cwd, dot: false });
    },
  };
}

// ---------------------------------------------------------------------------
// Public factory
// ---------------------------------------------------------------------------

/**
 * Creates a `SlingshotRuntime` implementation powered by the Node.js runtime.
 *
 * Provides the following capabilities using Node.js built-ins and peer dependencies:
 * - **password** — `argon2` (peer dep: `argon2`) for hashing and verification
 * - **sqlite** — `better-sqlite3` (peer dep: `better-sqlite3`) with WAL mode enabled
 * - **server** — `@hono/node-server` (peer dep: `@hono/node-server`) wrapping Node's `http.Server`
 * - **fs** — `node:fs/promises` for async file I/O with ENOENT-safe `readFile`
 * - **glob** — `fast-glob` (peer dep: `fast-glob`) for file pattern scanning
 *
 * **Runtime contract enforcement.** Unlike earlier versions, this runtime fully
 * implements the `RuntimeServerOptions` and `RuntimeWebSocketHandler` contract:
 * `maxRequestBodySize` (413 enforcement), `idleTimeout` (server-side
 * heartbeat), `perMessageDeflate` (compression), and `publishToSelf` (publish
 * fan-out) all behave as documented.
 *
 * **Graceful shutdown.** `instance.stop({ timeoutMs })` drains in-flight
 * connections for up to `timeoutMs` before force-closing leftover sockets. The
 * runtime does **not** register `SIGTERM` or `SIGINT` handlers — process
 * lifecycle belongs to the calling app. In production, register handlers:
 *
 * ```ts
 * const server = await runtime.server.listen({ ...opts });
 * const drain = async () => {
 *   try { await server.stop({ timeoutMs: 25_000 }); } finally { process.exit(0); }
 * };
 * process.once('SIGTERM', drain);
 * process.once('SIGINT', drain);
 * ```
 *
 * Optionally call `installProcessSafetyNet()` to forward unhandled rejections
 * and uncaught exceptions to the structured logger.
 *
 * **Structured logging.** Operational events (websocket handler errors,
 * upgrade timeouts, body-size rejections, drain timeouts, fetch handler
 * exceptions) are emitted via {@link configureRuntimeNodeLogger}. The default
 * logger writes to `console.warn` / `console.error`; production deployments
 * should swap in a logger that forwards to pino/bunyan/OpenTelemetry.
 */
export function nodeRuntime(options?: NodeRuntimeOptions): SlingshotRuntime {
  const resolvedRuntimeOpts = resolveNodeRuntimeOptions(options);
  return {
    password: createNodePassword(),
    sqlite: {
      open(path: string): RuntimeSqliteDatabase {
        const req = createRequire(import.meta.url);
        const Database = req('better-sqlite3') as typeof BetterSqlite3;
        const db = new Database(path);
        // In-memory databases (':memory:') do not support WAL — skip the
        // check for them, matching runtime-bun parity.
        if (path !== ':memory:') {
          db.pragma('journal_mode = WAL');
          const journalRows = db.pragma('journal_mode') as Array<{ journal_mode: string }>;
          const mode = journalRows[0]?.journal_mode?.toLowerCase();
          if (mode && mode !== 'wal') {
            db.close();
            throw new Error(
              `[runtime-node] failed to enable WAL journal mode (got ${mode}); ` +
                `verify the database file is on a writable, non-network filesystem`,
            );
          }
        }
        return adaptNodeSqlite(db);
      },
    },
    server: createNodeServer(resolvedRuntimeOpts),
    fs: createNodeFs(),
    glob: createNodeGlob(),
    async readFile(path: string): Promise<string | null> {
      const { readFile } = await import('node:fs/promises');
      try {
        return await readFile(path, 'utf8');
      } catch (err: unknown) {
        if (isEnoentError(err)) {
          return null;
        }
        throw err;
      }
    },
    supportsAsyncLocalStorage: true,
  };
}
