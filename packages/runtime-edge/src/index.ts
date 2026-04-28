// packages/runtime-edge/src/index.ts
import {
  type Logger,
  TimeoutError,
  createConsoleLogger,
  withTimeout,
} from '@lastshotlabs/slingshot-core';
import type { SlingshotRuntime } from '@lastshotlabs/slingshot-core';

/** Default upper-bound on a single `fileStore` call (5 s). */
const DEFAULT_FILE_STORE_TIMEOUT_MS = 5_000;

/**
 * Structured `Logger` (slingshot-core). Used for the fileStore-timeout warn
 * event. Defaults to a JSON console logger; consumers swap it via
 * {@link configureRuntimeEdgeLogger}.
 */
let edgeLogger: Logger = createConsoleLogger({ base: { runtime: 'edge' } });

/**
 * Replace the runtime's structured logger. Pass `null` to reset to the
 * default JSON console logger. Returns the previous logger so tests can
 * save and restore state.
 */
export function configureRuntimeEdgeLogger(logger: Logger | null): Logger {
  const previous = edgeLogger;
  edgeLogger = logger ?? createConsoleLogger({ base: { runtime: 'edge' } });
  return previous;
}

/**
 * Streaming descriptor returned by `fileStore`.
 *
 * Allows `readFile()` to enforce `maxFileBytes` without buffering the entire
 * payload first. If `size` is supplied (e.g. from a HEAD response or stat),
 * the runtime rejects oversized files before reading any bytes. Otherwise it
 * pulls chunks from `stream` and aborts as soon as the running byte count
 * exceeds the cap.
 */
export interface FileStoreStream {
  /**
   * Declared payload size in bytes. When present and greater than
   * `maxFileBytes`, `readFile()` rejects without reading the body.
   */
  size?: number;
  /**
   * The file body as a Web Streams ReadableStream of Uint8Array chunks.
   * `readFile()` will cancel the stream once it decides the result is
   * too large.
   */
  stream: ReadableStream<Uint8Array>;
}

/**
 * Result returned by a `fileStore` lookup.
 *
 * - `string`: a fully buffered UTF-8 payload. Suitable for small bundled
 *   assets where the size is known to be safe.
 * - `FileStoreStream`: a streaming descriptor with optional declared size.
 *   Required for any source that may return large files; the runtime will
 *   honour `maxFileBytes` before fully buffering.
 * - `null`: file not found.
 */
export type FileStoreResult = string | FileStoreStream | null;

/**
 * Options for `edgeRuntime()`.
 */
export interface EdgeRuntimeOptions {
  /**
   * Function to read a bundled file by path.
   *
   * On Cloudflare Workers, reads from KV, R2, or `env.ASSETS.fetch()`.
   * Return `null` if the file is not found.
   *
   * Prefer returning a {@link FileStoreStream} for any source that may
   * produce large files — the runtime will enforce `maxFileBytes` before
   * fully buffering. A plain `string` return is convenient for small
   * already-loaded assets but offers no protection against oversized reads.
   *
   * When omitted, `readFile()` always returns `null` — suitable for apps that
   * inline their asset manifest at build time and never need filesystem reads.
   */
  fileStore?: (path: string) => Promise<FileStoreResult>;

  /**
   * Custom password hashing implementation for edge runtimes.
   *
   * When omitted, falls back to PBKDF2-SHA256 via the Web Crypto API.
   * The default implementation is not bcrypt — it has no argon2 or bcrypt
   * dependency but is slower and uses a simpler key-derivation scheme.
   * For production deployments that require argon2-grade hashing, provide
   * your own implementation backed by an external service.
   */
  hashPassword?: (plain: string) => Promise<string>;

  /**
   * Custom password verification implementation for edge runtimes.
   *
   * Must be the counterpart of the `hashPassword` option — both must use
   * the same algorithm and encoding format. When omitted, the default PBKDF2
   * verifier is used (paired with the default `hashPassword`).
   */
  verifyPassword?: (plain: string, hash: string) => Promise<boolean>;

  /**
   * Maximum size in bytes for a `readFile()` result.
   *
   * `fileStore` returns a fully-buffered string. On Cloudflare Workers the
   * isolate heap budget is ~128 MB shared with app code; a single oversized
   * file can OOM the worker. When set, `readFile()` throws if the returned
   * string exceeds this size (measured by UTF-8 byte length). Defaults to
   * 4 * 1024 * 1024 (4 MiB). Set to 0 to disable the check.
   */
  maxFileBytes?: number;

  /**
   * Maximum time in milliseconds to wait for a single `fileStore(path)` call
   * before treating the lookup as a miss.
   *
   * When the cap is reached, the in-flight promise is abandoned (the runtime
   * cannot reliably cancel a user-supplied promise), a structured warn is
   * emitted via the configured {@link Logger}, and `readFile()` returns `null`.
   * Returning `null` rather than throwing keeps the caller's manifest-resolution
   * path on its happy path: a hung KV/R2 binding manifests as a missing file
   * rather than a stalled isolate.
   *
   * Defaults to {@link DEFAULT_FILE_STORE_TIMEOUT_MS} (5 s). Set to 0 to
   * disable the timeout entirely (not recommended for production).
   */
  fileStoreTimeoutMs?: number;
}

// ---------------------------------------------------------------------------
// Web Crypto password hashing (PBKDF2-SHA-256 with random salt)
// ---------------------------------------------------------------------------

/**
 * Iteration count for newly hashed passwords. Aligned with OWASP's 2023
 * recommendation for PBKDF2-SHA-256 (>= 600 000). Older hashes that pre-date
 * this constant still verify because the iteration count is now stored
 * alongside the hash; legacy two-part hashes (`salt:hash`) verify with
 * {@link LEGACY_PBKDF2_ITERATIONS}.
 *
 * @internal
 */
const PBKDF2_ITERATIONS = 600_000;

/**
 * Iteration count used by hashes produced before the iteration count was
 * embedded in the stored format. Required for verification of legacy rows.
 *
 * @internal
 */
const LEGACY_PBKDF2_ITERATIONS = 100_000;

/**
 * Storage-format prefix that signals an iteration-count-embedded hash.
 * Format: `pbkdf2-sha256$<iter>$<saltB64>$<hashB64>`. Hashes without this
 * prefix are treated as legacy `<saltB64>:<hashB64>` rows.
 *
 * @internal
 */
const PBKDF2_PREFIX = 'pbkdf2-sha256$';

/**
 * Hash a plaintext password using PBKDF2-SHA-256 via the Web Crypto API.
 *
 * Produces a `pbkdf2-sha256$<iter>$<salt-b64>$<hash-b64>` string. The salt is
 * 16 random bytes; the iteration count (currently {@link PBKDF2_ITERATIONS},
 * 600 000 — OWASP's recommended minimum for SHA-256) is embedded so a future
 * iteration-count bump remains backwards compatible.
 *
 * This is not bcrypt or argon2. It is deliberately simple so it works without
 * any native modules on edge runtimes. For higher-security requirements, provide
 * a custom `hashPassword` via `EdgeRuntimeOptions`.
 *
 * @internal
 */
async function hashWithWebCrypto(plain: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(plain),
    'PBKDF2',
    false,
    ['deriveBits'],
  );
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations: PBKDF2_ITERATIONS, hash: 'SHA-256' },
    key,
    256,
  );
  const hashArr = new Uint8Array(bits);
  // Encode using btoa on individual byte values to avoid spread args on large arrays
  const saltB64 = btoa(Array.from(salt, b => String.fromCharCode(b)).join(''));
  const hashB64 = btoa(Array.from(hashArr, b => String.fromCharCode(b)).join(''));
  return `${PBKDF2_PREFIX}${PBKDF2_ITERATIONS}$${saltB64}$${hashB64}`;
}

/**
 * Verify a plaintext password against a hash produced by `hashWithWebCrypto`.
 *
 * Accepts both the modern `pbkdf2-sha256$<iter>$<salt>$<hash>` format and the
 * legacy `<salt>:<hash>` format (verified at the historical iteration count).
 *
 * @param plain - The candidate plaintext password.
 * @param stored - The stored hash.
 * @returns `true` if `plain` matches the stored hash.
 * @internal
 */
async function verifyWithWebCrypto(plain: string, stored: string): Promise<boolean> {
  try {
    let saltB64: string | undefined;
    let hashB64: string | undefined;
    let iterations = LEGACY_PBKDF2_ITERATIONS;

    if (stored.startsWith(PBKDF2_PREFIX)) {
      // Modern format: `pbkdf2-sha256$<iter>$<salt-b64>$<hash-b64>`.
      const parts = stored.slice(PBKDF2_PREFIX.length).split('$');
      if (parts.length !== 3) return false;
      const [iterStr, saltPart, hashPart] = parts;
      const parsed = Number(iterStr);
      if (!Number.isInteger(parsed) || parsed < 1) return false;
      iterations = parsed;
      saltB64 = saltPart;
      hashB64 = hashPart;
    } else {
      // Legacy format: `<salt-b64>:<hash-b64>` at LEGACY_PBKDF2_ITERATIONS.
      const parts = stored.split(':');
      if (parts.length !== 2) return false;
      [saltB64, hashB64] = parts;
    }

    if (!saltB64 || !hashB64) return false;

    const salt = new Uint8Array(
      atob(saltB64)
        .split('')
        .map(c => c.charCodeAt(0)),
    );
    const expectedHash = new Uint8Array(
      atob(hashB64)
        .split('')
        .map(c => c.charCodeAt(0)),
    );

    const key = await crypto.subtle.importKey(
      'raw',
      new TextEncoder().encode(plain),
      'PBKDF2',
      false,
      ['deriveBits'],
    );
    const bits = await crypto.subtle.deriveBits(
      { name: 'PBKDF2', salt, iterations, hash: 'SHA-256' },
      key,
      256,
    );
    const actualHash = new Uint8Array(bits);

    if (actualHash.length !== expectedHash.length) return false;
    // Constant-time comparison to prevent timing attacks
    let diff = 0;
    for (let i = 0; i < actualHash.length; i++) {
      diff |= actualHash[i] ^ expectedHash[i];
    }
    return diff === 0;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Stubs for runtime capabilities unavailable on edge
// ---------------------------------------------------------------------------

/**
 * Stub `RuntimeFs` for edge runtimes.
 *
 * Edge runtimes have no access to the host filesystem. Any direct filesystem
 * operation throws with a clear message. Use `fileStore` in `EdgeRuntimeOptions`
 * for bundled asset access instead.
 *
 * @internal
 */
const edgeFs = Object.freeze({
  write(path: string, data: string | Uint8Array): Promise<void> {
    void path;
    void data;
    return Promise.reject(
      new Error(
        '[runtime-edge] Filesystem writes are not supported on edge runtimes. ' +
          'Use an external storage service (KV, R2, etc.) instead.',
      ),
    );
  },
  readFile(path: string): Promise<Uint8Array | null> {
    void path;
    return Promise.resolve(null);
  },
  exists(path: string): Promise<boolean> {
    void path;
    return Promise.resolve(false);
  },
});

/**
 * Stub `RuntimeGlob` for edge runtimes.
 *
 * Glob scanning is not possible on edge runtimes — there is no accessible
 * filesystem. Route discovery must happen at build time.
 *
 * @internal
 */
const edgeGlob = Object.freeze({
  scan(pattern: string, options?: { cwd?: string }): Promise<string[]> {
    void pattern;
    void options;
    return Promise.reject(
      new Error(
        '[runtime-edge] Glob scanning is not supported on edge runtimes. ' +
          'Route discovery must happen at build time.',
      ),
    );
  },
});

/**
 * Stub SQLite factory for edge runtimes.
 *
 * SQLite requires filesystem access and native binaries — neither is available
 * on edge runtimes. Use a database proxy (e.g. Cloudflare D1, PlanetScale, or
 * Neon) and access it through the appropriate driver.
 *
 * @internal
 */
const edgeSqlite = Object.freeze({
  open(path: string): never {
    void path;
    throw new Error(
      '[runtime-edge] SQLite is not supported on edge runtimes. ' +
        'Use a cloud database (Cloudflare D1, PlanetScale, Neon, etc.) instead.',
    );
  },
});

/**
 * Stub HTTP server factory for edge runtimes.
 *
 * Edge runtimes do not use `listen()` — the runtime itself manages the HTTP
 * server lifecycle. Export a `fetch` handler instead.
 *
 * @internal
 */
const edgeServer = Object.freeze({
  listen(): never {
    throw new Error(
      '[runtime-edge] RuntimeServerFactory.listen() is not supported on edge runtimes. ' +
        'Export a `fetch` handler from your Worker entry module instead.',
    );
  },
});

// ---------------------------------------------------------------------------
// Public factory
// ---------------------------------------------------------------------------

/**
 * Create a `SlingshotRuntime` implementation for edge runtimes.
 *
 * Provides runtime capabilities compatible with Cloudflare Workers and
 * Deno Deploy. Uses the Web Crypto API for password hashing — no native
 * modules, no Node.js built-ins.
 *
 * **Limitations vs. Bun/Node runtimes:**
 * - `supportsAsyncLocalStorage` is `false`. Use explicit context passing
 *   instead of `AsyncLocalStorage` for per-request state propagation.
 * - SQLite is not supported. Use a cloud database instead.
 * - HTTP server factory (`runtime.server.listen()`) is not callable.
 *   Export a `fetch` handler from your Worker entry module.
 * - Glob scanning is not supported. Route discovery must happen at build time.
 * - Filesystem writes are not supported. Use KV, R2, or another storage service.
 * - `readFile()` always returns `null` unless `fileStore` is provided.
 *
 * @param options - Optional configuration for file access and password hashing.
 * @returns A frozen `SlingshotRuntime` backed by Web Crypto and edge-compatible stubs.
 *
 * @example Cloudflare Workers
 * ```ts
 * import { edgeRuntime } from '@lastshotlabs/slingshot-runtime-edge';
 *
 * export default {
 *   async fetch(request: Request, env: Env): Promise<Response> {
 *     const runtime = edgeRuntime({
 *       fileStore: (path) =>
 *         env.ASSETS.fetch(new URL(path, request.url).toString())
 *           .then(r => r.ok ? r.text() : null),
 *     });
 *     // ...
 *   }
 * };
 * ```
 *
 * @example No file store (manifest inlined at build time)
 * ```ts
 * import { edgeRuntime } from '@lastshotlabs/slingshot-runtime-edge';
 * const runtime = edgeRuntime(); // readFile() always returns null
 * ```
 */
export function edgeRuntime(options: EdgeRuntimeOptions = {}): SlingshotRuntime {
  const hasCustomHash = typeof options.hashPassword === 'function';
  const hasCustomVerify = typeof options.verifyPassword === 'function';
  if (hasCustomHash !== hasCustomVerify) {
    throw new Error(
      '[runtime-edge] hashPassword and verifyPassword must both be provided or both omitted. ' +
        'Mixing one custom function with the default PBKDF2 implementation will cause auth failures.',
    );
  }

  const fileStore = options.fileStore ?? (() => Promise.resolve(null));
  const hashFn = options.hashPassword ?? hashWithWebCrypto;
  const verifyFn = options.verifyPassword ?? verifyWithWebCrypto;
  const maxFileBytes = options.maxFileBytes ?? 4 * 1024 * 1024;
  const fileStoreTimeoutMs =
    typeof options.fileStoreTimeoutMs === 'number' && options.fileStoreTimeoutMs >= 0
      ? options.fileStoreTimeoutMs
      : DEFAULT_FILE_STORE_TIMEOUT_MS;

  return Object.freeze({
    password: Object.freeze({
      /**
       * Hash a plaintext password using PBKDF2-SHA-256 (or a custom implementation).
       */
      hash(plain: string): Promise<string> {
        return hashFn(plain);
      },
      /**
       * Verify a plaintext password against a stored hash.
       */
      verify(plain: string, hash: string): Promise<boolean> {
        return verifyFn(plain, hash);
      },
    }),
    sqlite: edgeSqlite,
    server: edgeServer,
    fs: edgeFs,
    glob: edgeGlob,
    /**
     * Read a bundled file by path via the configured `fileStore`.
     *
     * Returns `null` for any path not found in the bundle. On Cloudflare Workers,
     * wire this to `env.ASSETS.fetch()` or a KV namespace.
     *
     * Throws if the result exceeds `maxFileBytes` (default 4 MiB). Edge isolates
     * have ~128 MB of heap shared with app code; an oversized buffered read can
     * OOM the worker.
     *
     * Cap enforcement strategy (in order of preference):
     * 1. If the store returns a {@link FileStoreStream} with a declared `size`
     *    larger than `maxFileBytes`, the stream is cancelled and the call
     *    rejects without reading the body.
     * 2. If the store returns a stream without a declared size, chunks are
     *    pulled and accumulated; the stream is cancelled and the call
     *    rejects as soon as accumulated bytes exceed `maxFileBytes`.
     * 3. If the store returns a plain string, the buffered byte length is
     *    checked after the fact (legacy path — prefer streaming for any
     *    source that may produce large files).
     */
    async readFile(path: string): Promise<string | null> {
      // P-EDGE-3: bound fileStore latency. A user-supplied store backed by
      // KV/R2 over the network can stall on bad bindings or transient
      // service errors; without a timeout the request handler stays open
      // until the platform forcibly recycles the isolate, dropping every
      // queued caller in the meantime. Treat a timeout as a miss (return
      // null) rather than throwing — the calling manifest-resolution path
      // already handles missing files gracefully.
      let result: FileStoreResult;
      try {
        if (fileStoreTimeoutMs > 0) {
          result = await withTimeout(
            Promise.resolve().then(() => fileStore(path)),
            fileStoreTimeoutMs,
            `fileStore('${path}')`,
          );
        } else {
          result = await fileStore(path);
        }
      } catch (err) {
        if (err instanceof TimeoutError) {
          edgeLogger.warn('file-store-timeout', {
            path,
            timeoutMs: fileStoreTimeoutMs,
          });
          return null;
        }
        throw err;
      }
      if (result === null) return null;

      const tooLarge = (bytes: number): Error =>
        new Error(
          `[runtime-edge] readFile('${path}') returned ${bytes} bytes; ` +
            `exceeds maxFileBytes=${maxFileBytes}. ` +
            `Stream large assets at the platform level (e.g. env.ASSETS.fetch()) ` +
            `or raise maxFileBytes if you've confirmed the isolate has headroom.`,
        );

      if (typeof result === 'string') {
        if (maxFileBytes > 0) {
          // UTF-8 byte length, not character count. crypto.subtle / TextEncoder
          // are available in every supported edge runtime.
          const byteLength = new TextEncoder().encode(result).byteLength;
          if (byteLength > maxFileBytes) throw tooLarge(byteLength);
        }
        return result;
      }

      // Streaming path. Honour declared size first to reject before reading
      // any body bytes.
      const { size, stream } = result;
      if (maxFileBytes > 0 && typeof size === 'number' && size > maxFileBytes) {
        // Cancel the underlying source so the platform can release resources.
        await stream.cancel().catch(() => {});
        throw tooLarge(size);
      }

      // Pull chunks and abort early if cumulative bytes exceed the cap.
      const reader = stream.getReader();
      const chunks: Uint8Array[] = [];
      let total = 0;
      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          if (!value) continue;
          total += value.byteLength;
          if (maxFileBytes > 0 && total > maxFileBytes) {
            await reader.cancel().catch(() => {});
            throw tooLarge(total);
          }
          chunks.push(value);
        }
      } finally {
        reader.releaseLock();
      }

      // Concatenate and decode. We could decode incrementally with a
      // TextDecoder stream but the cap guarantees the buffer is bounded.
      const merged = new Uint8Array(total);
      let offset = 0;
      for (const chunk of chunks) {
        merged.set(chunk, offset);
        offset += chunk.byteLength;
      }
      return new TextDecoder().decode(merged);
    },
    /**
     * Edge runtimes do not support `AsyncLocalStorage`.
     *
     * Always `false`. This flag is read by `slingshot-ssr` to determine whether
     * ALS-dependent features are available:
     *
     * - **Server action revalidation** (`revalidatePath` / `revalidateTag`):
     *   calls inside server actions will be silent no-ops with a console
     *   warning. No crash occurs; ISR cache entries are simply not invalidated
     *   on mutation.
     *
     * - **Draft mode** (`draftMode()`): returns `{ isEnabled: false }` with
     *   no-op `enable()` / `disable()` methods. Cookie-based draft previews
     *   are not available in edge deployments.
     *
     * Apps that require cache invalidation in edge deployments should use
     * tag-based ISR invalidation via the KV adapter (e.g. Cloudflare KV)
     * instead of relying on in-process ALS context.
     */
    supportsAsyncLocalStorage: false as const,
  });
}
