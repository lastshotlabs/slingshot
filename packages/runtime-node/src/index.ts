import { createRequire } from 'node:module';
import type BetterSqlite3 from 'better-sqlite3';
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

function logWebSocketHandlerError(
  phase: 'open' | 'message' | 'close' | 'pong',
  error: unknown,
): void {
  console.error(`[runtime-node] websocket ${phase} handler failed:`, error);
}

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
 * @returns A `RuntimePassword` that hashes with argon2id (argon2's default) and
 *   verifies with constant-time comparison.
 *
 * @throws {Error} If the `argon2` package is not installed, `import('argon2')` throws
 *   a module-not-found error at first call to `hash` or `verify`. The error surfaces at
 *   use time, not when `createNodePassword()` is called, because the import is dynamic.
 *
 * @remarks
 * Requires `argon2` to be installed: `npm install argon2` / `bun add argon2`.
 *
 * @example
 * ```ts
 * // Used internally by nodeRuntime() — not needed in application code.
 * const password = createNodePassword();
 * const hash = await password.hash('mysecret');
 * const ok = await password.verify('mysecret', hash); // true
 * ```
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

/**
 * Wraps a `better-sqlite3` `Database` in the `RuntimeSqliteDatabase` interface.
 *
 * Adapts `better-sqlite3`'s synchronous API to the `RuntimeSqliteDatabase` contract
 * so it can be consumed by slingshot adapters that only depend on the abstract interface.
 * All `params` spread arguments are forwarded unchanged.
 *
 * @param db - An open `better-sqlite3` `Database` instance.
 * @returns A `RuntimeSqliteDatabase` that delegates to `db` for all operations.
 *
 * @remarks
 * `better-sqlite3` uses `prepare().run()` to execute DML; this adapter calls
 * `db.prepare(sql).run(...params)` inside `run()` so every call re-prepares the
 * statement. For hot paths, use `prepare()` directly.
 *
 * @example
 * ```ts
 * // Used internally by nodeRuntime() — not needed in application code.
 * const Database = require('better-sqlite3');
 * const db = new Database('./data.db');
 * const runtimeDb = adaptNodeSqlite(db);
 * ```
 */
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
// HTTP server — @hono/node-server + ws
// ---------------------------------------------------------------------------

/**
 * Creates a `RuntimeServerFactory` backed by `@hono/node-server`.
 *
 * `listen()` starts an HTTP (or HTTPS when `opts.tls` is provided) server on
 * the requested port (defaulting to 3000) and resolves with a
 * `RuntimeServerInstance` once the port is bound. If the port is 0, the OS
 * assigns an ephemeral port; the actual port is returned via `instance.port`.
 *
 * When `opts.websocket` is provided, WebSocket support is enabled via the `ws`
 * peer dependency. Upgrade requests are handled directly on the Node HTTP
 * server's `upgrade` event. Channel-based pub/sub is available via
 * `instance.publish()` and the `subscribe`/`unsubscribe` methods on each
 * `RuntimeWebSocket`.
 *
 * @returns A `RuntimeServerFactory` that wraps `@hono/node-server`'s `serve()`.
 *
 * @remarks
 * Requires `@hono/node-server` as a peer dependency. When WebSocket support is
 * used, `ws` must also be installed.
 *
 * @example
 * ```ts
 * const server = createNodeServer();
 * const instance = await server.listen({ fetch: app.fetch, port: 3000 });
 * console.log(instance.port); // 3000
 * await instance.stop();
 * ```
 */
function createNodeServer(): RuntimeServerFactory {
  return {
    async listen(opts): Promise<RuntimeServerInstance> {
      const { serve } = await import('@hono/node-server');

      // TLS: create an HTTPS server when tls key/cert are provided
      let httpServer: import('node:http').Server;
      if (opts.tls) {
        const https = await import('node:https');
        const tlsServer = https.createServer({
          key: opts.tls.key as string | Buffer | undefined,
          cert: opts.tls.cert as string | Buffer | undefined,
        });
        httpServer = tlsServer as unknown as import('node:http').Server;
      } else {
        const { createServer } = await import('node:http');
        httpServer = createServer();
      }

      let port = opts.port ?? 3000;

      // Wrap the fetch handler to forward uncaught errors to opts.error when provided.
      // Without this, errors from the fetch handler are swallowed by @hono/node-server.
      const errorHandler = opts.error;
      const fetchHandler = errorHandler
        ? async (req: Request) => {
            try {
              return await opts.fetch(req);
            } catch (err) {
              return errorHandler(err instanceof Error ? err : new Error(String(err)));
            }
          }
        : opts.fetch;

      await new Promise<void>((resolve, reject) => {
        const errorHandler = (err: Error) => reject(err);
        httpServer.on('error', errorHandler);
        serve(
          {
            fetch: fetchHandler,
            port,
            hostname: opts.hostname,
            // @hono/node-server calls createServer(serverOptions, requestListener).
            // We return our pre-created server but must register the listener so
            // incoming requests are actually handled. Handle both 1-arg and 2-arg
            // calling conventions defensively.
            createServer: ((first: unknown, second?: unknown) => {
              const listener =
                typeof second === 'function'
                  ? (second as (...args: unknown[]) => void)
                  : typeof first === 'function'
                    ? (first as (...args: unknown[]) => void)
                    : null;
              if (listener) {
                httpServer.on('request', listener);
              }
              return httpServer;
            }) as typeof import('node:http').createServer,
          },
          info => {
            port = info.port;
            httpServer.removeListener('error', errorHandler);
            resolve();
          },
        );
      });

      // -- WebSocket support via `ws` --
      type WsWebSocket = import('ws').WebSocket;
      let wss: import('ws').WebSocketServer | undefined;
      const channels = new Map<string, Set<WsWebSocket>>();
      const wsHandler = opts.websocket;

      // Pending upgrade requests waiting for the fetch handler to call upgrade().
      // Keyed by sec-websocket-key (unique per handshake).
      const pendingUpgrades = new Map<
        string,
        {
          req: import('node:http').IncomingMessage;
          socket: import('node:stream').Duplex;
          head: Buffer;
          timer: ReturnType<typeof setTimeout>;
        }
      >();

      if (wsHandler) {
        const { Writable } = await import('node:stream');
        const { ServerResponse } = await import('node:http');
        const { WebSocketServer } = await import('ws');
        wss = new WebSocketServer({ noServer: true });

        httpServer.on('upgrade', (req, socket, head) => {
          const key = req.headers['sec-websocket-key'];
          if (!key) {
            socket.destroy();
            return;
          }

          const timer = setTimeout(() => {
            pendingUpgrades.delete(key);
            socket.destroy();
          }, 30_000);

          pendingUpgrades.set(key, { req, socket, head, timer });

          // Create a dummy socket so @hono/node-server doesn't write to the
          // real socket that ws will take over.
          const dummySocket = new Writable({
            write(_chunk: unknown, _encoding: string, cb: () => void) {
              cb();
            },
          });

          const res = new ServerResponse(req);
          res.assignSocket(dummySocket as unknown as import('node:net').Socket);
          httpServer.emit('request', req, res);
        });
      }

      /** Wrap a raw `ws` WebSocket in the RuntimeWebSocket contract. */
      function wrapWs(ws: WsWebSocket, data: unknown): RuntimeWebSocket {
        const handler = wsHandler;
        if (!handler) {
          throw new Error('[runtime-node] WebSocket handler is unavailable during upgrade');
        }
        const subscribedChannels = new Set<string>();

        const rtWs: RuntimeWebSocket = {
          data,
          send(d: string | Buffer) {
            ws.send(d);
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
            if (subs?.size === 0) channels.delete(channel);
          },
        };

        ws.on('message', rawData => {
          void Promise.resolve(handler.message(rtWs, stringifyWsPayload(rawData))).catch(
            (error: unknown) => {
              logWebSocketHandlerError('message', error);
            },
          );
        });
        ws.on('close', (code, reason) => {
          for (const ch of subscribedChannels) {
            const subs = channels.get(ch);
            subs?.delete(ws);
            if (subs?.size === 0) channels.delete(ch);
          }
          void Promise.resolve(handler.close(rtWs, code, stringifyWsPayload(reason))).catch(
            (error: unknown) => {
              logWebSocketHandlerError('close', error);
            },
          );
        });
        if (handler.pong) {
          ws.on('pong', () => {
            try {
              handler.pong?.(rtWs);
            } catch (error) {
              logWebSocketHandlerError('pong', error);
            }
          });
        }

        return rtWs;
      }

      return {
        get port(): number {
          return port;
        },
        stop(closeActiveConnections?: boolean): Promise<void> {
          for (const [key, pending] of pendingUpgrades) {
            clearTimeout(pending.timer);
            pending.socket.destroy();
            pendingUpgrades.delete(key);
          }
          return new Promise(resolve => {
            if (closeActiveConnections) {
              // Node 18.2+ API — force-close all active connections
              (httpServer as { closeAllConnections?: () => void }).closeAllConnections?.();
            }
            wss?.close();
            httpServer.close(() => resolve());
          });
        },
        upgrade(req: Request, upgradeOpts: { data: unknown }): boolean {
          if (!wss || !wsHandler) return false;
          const key = req.headers.get('sec-websocket-key');
          if (!key) return false;
          const pending = pendingUpgrades.get(key);
          if (!pending) return false;
          clearTimeout(pending.timer);
          pendingUpgrades.delete(key);
          wss.handleUpgrade(pending.req, pending.socket, pending.head, ws => {
            const rtWs = wrapWs(ws, upgradeOpts.data);
            void Promise.resolve(wsHandler.open(rtWs)).catch((error: unknown) => {
              logWebSocketHandlerError('open', error);
            });
          });
          return true;
        },
        publish(channel: string, message: string): void {
          const subs = channels.get(channel);
          if (!subs) return;
          for (const ws of subs) {
            // ws.OPEN === 1
            if (ws.readyState === 1) {
              ws.send(message);
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

/**
 * Creates a `RuntimeFs` implementation backed by `node:fs/promises`.
 *
 * - `write` — `fs.writeFile` (creates or overwrites).
 * - `readFile` — `fs.readFile` wrapped to return `null` on `ENOENT` rather than throwing.
 * - `exists` — `fs.access` returning `true` / `false`.
 *
 * All `fs` imports are done lazily via dynamic `import()` so the module loads
 * without side effects in environments that polyfill Node.js APIs.
 *
 * @returns A `RuntimeFs` backed by Node.js built-in file-system APIs.
 *
 * @remarks
 * `readFile` returns `null` specifically on `ENOENT` (file not found). All other
 * `fs.readFile` errors (e.g. `EACCES` for permission denied, `EISDIR` for a directory
 * path) are re-thrown as-is and are not swallowed. `exists` uses `fs.access` and
 * catches all errors to return `false` — it does not distinguish ENOENT from other
 * access errors.
 *
 * @example
 * ```ts
 * // Used internally by nodeRuntime() — not needed in application code.
 * const fs = createNodeFs();
 * await fs.write('./output.json', JSON.stringify(data));
 * const bytes = await fs.readFile('./output.json');
 * ```
 */
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
        if (
          typeof err === 'object' &&
          err !== null &&
          'code' in err &&
          (err as NodeJS.ErrnoException).code === 'ENOENT'
        ) {
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

/**
 * Creates a `RuntimeGlob` implementation backed by `fast-glob`.
 *
 * `scan(pattern, options)` delegates to `fast-glob` with `dot: false` (hidden
 * files excluded by default). The `cwd` option is forwarded unchanged.
 *
 * @returns A `RuntimeGlob` that uses `fast-glob` for file pattern scanning.
 *
 * @remarks
 * Requires `fast-glob` to be installed as a peer dependency:
 * `npm install fast-glob` / `bun add fast-glob`.
 *
 * @example
 * ```ts
 * // Used internally by nodeRuntime() — not needed in application code.
 * const glob = createNodeGlob();
 * const files = await glob.scan('**\/*.ts', { cwd: './src' });
 * ```
 */
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
 * All peer dependencies are loaded lazily at call time so missing deps throw at the point
 * of use rather than at import time.
 *
 * @returns A fully-implemented `SlingshotRuntime` backed by Node.js APIs.
 *
 * @remarks
 * This runtime is intended for use in Node.js environments only. For Bun, use
 * `bunRuntime()` from `@lastshotlabs/slingshot-runtime-bun`.
 *
 * Peer dependency failures (missing `argon2`, `better-sqlite3`, `@hono/node-server`,
 * or `fast-glob`) surface at **first use** of the respective capability, not when
 * `nodeRuntime()` is called. The runtime object is constructed eagerly, but each
 * sub-factory (`createNodePassword`, `createNodeServer`, etc.) defers its peer-dep
 * imports to the first method invocation via dynamic `import()`.
 *
 * @example
 * ```ts
 * import { nodeRuntime } from '@lastshotlabs/slingshot-runtime-node';
 * import { createServer } from '@lastshotlabs/slingshot-core';
 *
 * const server = await createServer({ runtime: nodeRuntime(), ...config });
 * ```
 */
export function nodeRuntime(): SlingshotRuntime {
  return {
    password: createNodePassword(),
    sqlite: {
      open(path: string): RuntimeSqliteDatabase {
        // Synchronous open — better-sqlite3 is a native CJS addon that must
        // be loaded via require(). Use the top-level createRequire so this
        // works in Node.js ESM where bare `require` is not available.
        const req = createRequire(import.meta.url);
        const Database = req('better-sqlite3') as typeof BetterSqlite3;
        const db = new Database(path);
        db.pragma('journal_mode = WAL');
        return adaptNodeSqlite(db);
      },
    },
    server: createNodeServer(),
    fs: createNodeFs(),
    glob: createNodeGlob(),
    async readFile(path: string): Promise<string | null> {
      const { readFile } = await import('node:fs/promises');
      try {
        return await readFile(path, 'utf8');
      } catch {
        return null;
      }
    },
    supportsAsyncLocalStorage: true,
  };
}
