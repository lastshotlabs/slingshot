// packages/runtime-edge/src/index.ts
import type { SlingshotRuntime } from '@lastshotlabs/slingshot-core';

/**
 * Options for `edgeRuntime()`.
 */
export interface EdgeRuntimeOptions {
  /**
   * Function to read a bundled file by path.
   *
   * On Cloudflare Workers, reads from KV or `__STATIC_CONTENT__`.
   * Return `null` if the file is not found.
   *
   * When omitted, `readFile()` always returns `null` — suitable for apps that
   * inline their asset manifest at build time and never need filesystem reads.
   */
  fileStore?: (path: string) => Promise<string | null>;

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
}

// ---------------------------------------------------------------------------
// Web Crypto password hashing (PBKDF2-SHA-256 with random salt)
// ---------------------------------------------------------------------------

/**
 * Hash a plaintext password using PBKDF2-SHA-256 via the Web Crypto API.
 *
 * Produces a `base64(salt):base64(hash)` string. The salt is 16 random bytes;
 * 100 000 iterations of PBKDF2 with SHA-256 produces a 256-bit (32-byte) derived key.
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
    { name: 'PBKDF2', salt, iterations: 100_000, hash: 'SHA-256' },
    key,
    256,
  );
  const hashArr = new Uint8Array(bits);
  // Encode using btoa on individual byte values to avoid spread args on large arrays
  const saltB64 = btoa(Array.from(salt, b => String.fromCharCode(b)).join(''));
  const hashB64 = btoa(Array.from(hashArr, b => String.fromCharCode(b)).join(''));
  return `${saltB64}:${hashB64}`;
}

/**
 * Verify a plaintext password against a hash produced by `hashWithWebCrypto`.
 *
 * @param plain - The candidate plaintext password.
 * @param stored - The stored hash in `base64(salt):base64(hash)` format.
 * @returns `true` if `plain` matches the stored hash.
 * @internal
 */
async function verifyWithWebCrypto(plain: string, stored: string): Promise<boolean> {
  try {
    const [saltB64, hashB64] = stored.split(':');
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
      { name: 'PBKDF2', salt, iterations: 100_000, hash: 'SHA-256' },
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
     */
    readFile(path: string): Promise<string | null> {
      return fileStore(path);
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
