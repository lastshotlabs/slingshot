/**
 * Runtime-agnostic password hashing contract.
 *
 * Abstracts over Bun's `Bun.password` API so that tests and alternative runtimes
 * can substitute a faster or mock implementation without touching calling code.
 *
 * @example
 * ```ts
 * const password: RuntimePassword = {
 *   hash: (plain) => Bun.password.hash(plain),
 *   verify: (plain, hash) => Bun.password.verify(plain, hash),
 * };
 * ```
 */
export interface RuntimePassword {
  /**
   * Hash a plaintext password for storage.
   * @param plain - The plaintext password to hash.
   * @returns A promise that resolves to a one-way hash string suitable for database storage.
   *   The hash includes the algorithm identifier and parameters and is self-contained —
   *   pass it directly to `verify()` without any additional encoding.
   */
  hash(plain: string): Promise<string>;
  /**
   * Verify a plaintext password against a stored hash.
   * @param plain - The candidate plaintext password.
   * @param hash - The stored hash previously returned by `hash()`.
   * @returns A promise that resolves to `true` if `plain` matches the hash,
   *   or `false` if it does not. Never rejects for a hash/password mismatch —
   *   only rejects if the hash string is malformed or unsupported.
   */
  verify(plain: string, hash: string): Promise<boolean>;
}

/**
 * Result returned by a SQLite prepared statement `run()` call.
 */
export interface RuntimeSqliteRunResult {
  /** Number of rows modified by the statement. */
  changes: number;
}

/**
 * Runtime-agnostic SQLite database handle.
 *
 * Abstracts over Bun's `Database` API so that framework code can remain
 * runtime-portable. All SQLite interactions in slingshot go through this interface.
 */
export interface RuntimeSqliteDatabase {
  /**
   * Execute a SQL statement without returning rows.
   *
   * Parameters are bound positionally via `?` placeholders in the SQL string.
   * Throws a synchronous error if the SQL is invalid or a constraint is violated —
   * there is no Promise-based error path. Use this for fire-and-forget DDL/DML
   * where row results are not needed.
   *
   * @param sql - The SQL statement, optionally with `?` parameter placeholders.
   * @param params - Values bound to each `?` placeholder in order.
   */
  run(sql: string, ...params: unknown[]): void;
  /** Create a reusable statement that can be called with different parameters. */
  query<T = unknown>(sql: string): RuntimeSqliteStatement<T>;
  /** Prepare a statement for repeated execution with result tracking. */
  prepare<T = unknown>(sql: string): RuntimeSqlitePreparedStatement<T>;
  /**
   * Wrap a set of database operations in a transaction.
   *
   * Returns a new callable function that, when invoked, runs `fn` inside a BEGIN/COMMIT
   * block. If `fn` throws, the transaction is automatically rolled back (ROLLBACK) and the
   * error is re-thrown. The isolation level is SQLite's default serialisable isolation —
   * there is no option to change it at the adapter level.
   *
   * @param fn - A synchronous function containing the database operations to run atomically.
   * @returns A callable wrapper; invoke the returned function to execute the transaction.
   */
  transaction<T>(fn: () => T): () => T;
  /** Close the database connection and release file handles. */
  close(): void;
}

/**
 * A reusable SQLite query with typed result rows.
 * @template T - The shape of each result row.
 */
export interface RuntimeSqliteStatement<T> {
  /** Execute the query and return the first row, or `null` if no rows match. */
  get(...params: unknown[]): T | null;
  /** Execute the query and return all matching rows. */
  all(...params: unknown[]): T[];
  /**
   * Execute the statement without returning rows (for INSERT/UPDATE/DELETE).
   *
   * Parameters are bound to the `?` placeholders in the order they are provided.
   * This method discards all rows the database might return — use `get()` or `all()`
   * when you need the result rows. Throws synchronously on constraint violations or
   * SQL errors.
   */
  run(...params: unknown[]): void;
}

/**
 * A prepared SQLite statement that also returns row-change metadata.
 * @template T - The shape of each result row.
 */
export interface RuntimeSqlitePreparedStatement<T = unknown> {
  /** Execute and return the first row, or `null` if no rows match. */
  get(...params: unknown[]): T | null;
  /** Execute and return all matching rows. */
  all(...params: unknown[]): T[];
  /** Execute and return change metadata (number of affected rows). */
  run(...params: unknown[]): RuntimeSqliteRunResult;
}

/**
 * Runtime-agnostic file system contract.
 *
 * Used by framework utilities that write files (generated configs, SSH keys, etc.).
 * Abstracts over `Bun.write` / `Bun.file` so code stays runtime-portable.
 */
export interface RuntimeFs {
  /** Write `data` to the file at `path`, creating it if it does not exist. */
  write(path: string, data: string | Uint8Array): Promise<void>;
  /** Read the file at `path` as raw bytes, or `null` if the file does not exist. */
  readFile(path: string): Promise<Uint8Array | null>;
  /** Return `true` if the file or directory at `path` exists. */
  exists(path: string): Promise<boolean>;
}

/**
 * Runtime-agnostic glob file scanner.
 * Used for auto-discovery of route files, model schemas, etc.
 */
export interface RuntimeGlob {
  /**
   * Scan for files matching `pattern`.
   * @param pattern - Glob pattern (e.g. `**\/*.route.ts`).
   * @param options - Optional working directory override.
   * @returns An async iterable or promise of matched paths.
   */
  scan(pattern: string, options?: { cwd?: string }): AsyncIterable<string> | Promise<string[]>;
}

/**
 * Options passed to `RuntimeServerFactory.listen()` to start the HTTP server.
 */
export interface RuntimeServerOptions {
  /** TCP port to listen on. */
  port?: number;
  /** Hostname/interface to bind (defaults to `0.0.0.0`). */
  hostname?: string;
  /** Unix domain socket path (alternative to TCP). */
  unix?: string;
  /** TLS key and certificate for HTTPS. */
  tls?: { key?: string | Uint8Array; cert?: string | Uint8Array };
  /**
   * Maximum allowed request body size in bytes.
   *
   * Requests with a body larger than this value are rejected before the fetch handler
   * is called. Units are bytes. Defaults to `128 * 1024 * 1024` (128 MiB) when omitted,
   * matching Bun's built-in default. Set to a lower value for APIs that should not accept
   * large uploads (e.g. JSON-only endpoints).
   */
  maxRequestBodySize?: number;
  /** The HTTP fetch handler — receives every inbound request. */
  fetch: (req: Request) => Response | Promise<Response>;
  /** Global error handler — produces an error response for unhandled exceptions. */
  error?: (err: Error) => Response;
  /**
   * WebSocket lifecycle handler.
   *
   * Optional — omit when the server does not serve any WebSocket endpoints.
   * Must be provided when any route calls `server.upgrade()`. If a WebSocket upgrade
   * is attempted without a handler configured, the runtime will throw at upgrade time.
   */
  websocket?: RuntimeWebSocketHandler;
}

/**
 * WebSocket lifecycle callbacks for the runtime server.
 *
 * Matches Bun's server-side WebSocket API shape so it can be forwarded directly.
 */
export interface RuntimeWebSocketHandler {
  /** Called when a client WebSocket connection is established. */
  open(ws: RuntimeWebSocket): void | Promise<void>;
  /** Called when the client sends a message. */
  message(ws: RuntimeWebSocket, message: string | Buffer): void | Promise<void>;
  /**
   * Called when the connection closes.
   *
   * @param ws - The closed WebSocket handle.
   * @param code - The WebSocket close code per RFC 6455 (e.g. `1000` = normal closure,
   *   `1001` = going away, `1006` = abnormal closure without a close frame).
   * @param reason - A human-readable string describing the reason for closure.
   *   May be empty. Do not use this string for programmatic logic — use `code` instead.
   */
  close(ws: RuntimeWebSocket, code: number, reason: string): void | Promise<void>;
  /** Called on a pong frame response (optional). */
  pong?(ws: RuntimeWebSocket): void;
  /**
   * Idle timeout in seconds before the server closes an inactive connection.
   *
   * The server closes any connection that has not received a message or ping within
   * this many seconds. The `close` handler is called with code `1001` when the
   * timeout fires. Omit or set to `0` to disable idle timeout (not recommended for
   * public-facing servers).
   */
  idleTimeout?: number;
  /** Enable per-message deflate compression. */
  perMessageDeflate?: boolean;
  /** When true, published messages are delivered to the publishing socket too. */
  publishToSelf?: boolean;
}

/**
 * Server-side handle for an open WebSocket connection.
 * @template T - Typed connection data attached at upgrade time.
 */
export interface RuntimeWebSocket<T = unknown> {
  /** Typed data attached to this connection during the HTTP upgrade. */
  readonly data: T;
  /** Send a text or binary message to the client. */
  send(data: string | Buffer): void;
  /** Close the connection with an optional status code and reason. */
  close(code?: number, reason?: string): void;
  /** Send a ping frame to check liveness. */
  ping(): void;
  /**
   * Subscribe this socket to a named pub/sub channel.
   *
   * After subscribing, messages published to `channel` via `server.publish(channel, msg)`
   * are delivered to this socket's `message` handler. A socket may subscribe to multiple
   * channels simultaneously. Subscribing to a channel the socket is already subscribed to
   * is a no-op.
   */
  subscribe(channel: string): void;
  /**
   * Unsubscribe this socket from a named pub/sub channel.
   *
   * After unsubscribing, further publishes to `channel` will not be delivered to this socket.
   * Unsubscribing from a channel the socket is not subscribed to is a no-op.
   */
  unsubscribe(channel: string): void;
}

/**
 * A running HTTP server instance.
 * Returned by `RuntimeServerFactory.listen()`.
 */
export interface RuntimeServerInstance {
  /** The actual port the server is listening on. */
  readonly port: number;
  /**
   * Stop accepting new connections.
   * @param closeActiveConnections - When true, close already-open connections immediately.
   */
  stop(closeActiveConnections?: boolean): void | Promise<void>;
  /**
   * Upgrade an HTTP request to a WebSocket connection.
   * @param req - The incoming HTTP request.
   * @param opts - Data to attach to the WebSocket connection.
   * @returns `true` if the upgrade succeeded.
   */
  upgrade?(req: Request, opts: { data: unknown }): boolean;
  /**
   * Publish a message to all subscribers of a pub/sub channel.
   * @param channel - The channel name.
   * @param message - The message to broadcast.
   */
  publish?(channel: string, message: string): void;
}

/**
 * Factory for starting an HTTP (and optionally WebSocket) server.
 *
 * Abstracts over Bun's `Bun.serve()` API so framework bootstrap code can remain
 * runtime-portable and testable with mock implementations.
 */
export interface RuntimeServerFactory {
  /**
   * Start the server with the given options.
   * @param opts - Server configuration including the fetch handler and optional WS handler.
   * @returns The running server instance (synchronously or asynchronously).
   */
  listen(opts: RuntimeServerOptions): RuntimeServerInstance | Promise<RuntimeServerInstance>;
}

/**
 * Aggregated Slingshot runtime capabilities.
 *
 * Slingshot requires a runtime that provides password hashing, SQLite, an HTTP server,
 * filesystem access, and glob scanning. The canonical implementation is Bun; other
 * runtimes can provide compatible shims for testing or alternative deployment targets.
 *
 * @remarks
 * This interface is resolved from the app config at startup and injected into
 * framework internals. Plugin code should not depend on it directly — use the
 * higher-level APIs exposed by `SlingshotContext` instead.
 */
export interface SlingshotRuntime {
  /** Password hashing implementation (wraps `Bun.password` in production). */
  readonly password: RuntimePassword;
  /** SQLite database factory. */
  readonly sqlite: { open(path: string): RuntimeSqliteDatabase };
  /** HTTP server factory. */
  readonly server: RuntimeServerFactory;
  /** Filesystem utilities. */
  readonly fs: RuntimeFs;
  /** Glob file scanner. */
  readonly glob: RuntimeGlob;

  /**
   * Read a file as a UTF-8 string.
   *
   * Used by SSR for static file serving and asset manifest reading.
   * Returns `null` if the file does not exist.
   *
   * Edge runtimes return `null` for any path not present in their bundled asset
   * store — they have no access to the host filesystem.
   *
   * @param path - Absolute path to the file (or a virtual path in edge runtimes).
   * @returns The file contents as a string, or `null` if the file is not found.
   */
  readFile(path: string): Promise<string | null>;

  /**
   * Whether this runtime natively supports Node.js `AsyncLocalStorage`.
   *
   * `true` on Bun and Node.js runtimes (both ship `AsyncLocalStorage`).
   * `false` on edge runtimes (Cloudflare Workers, Deno Deploy) that use a
   * different per-request context mechanism and do not expose `AsyncLocalStorage`
   * as a first-class API.
   *
   * SSR middleware uses this flag to decide whether to use `AsyncLocalStorage`
   * for request-scoped context propagation. On edge runtimes, an alternative
   * mechanism (e.g. explicit context passing) should be used instead.
   */
  readonly supportsAsyncLocalStorage: boolean;
}
