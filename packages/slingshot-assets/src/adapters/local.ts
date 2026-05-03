import { unlink } from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';
import type { RuntimeFs, StorageAdapter } from '@lastshotlabs/slingshot-core';
import { HttpError } from '@lastshotlabs/slingshot-core';
import {
  type CircuitBreaker,
  type CircuitBreakerState,
  CircuitOpenError,
  createCircuitBreaker,
  withRetry,
} from './circuitBreaker';

/** Default RuntimeFs implementation using Bun's file APIs. */
const defaultFs: RuntimeFs = {
  async write(path: string, data: string | Uint8Array): Promise<void> {
    if (typeof Bun === 'undefined') {
      throw new Error(
        '[slingshot-assets] localStorage defaultFs requires a Bun runtime. ' +
          'Pass a custom `fs` implementation or use the S3 adapter on non-Bun runtimes.',
      );
    }
    await Bun.write(path, data);
  },
  async readFile(path: string): Promise<Uint8Array | null> {
    if (typeof Bun === 'undefined') {
      throw new Error(
        '[slingshot-assets] localStorage defaultFs requires a Bun runtime. ' +
          'Pass a custom `fs` implementation or use the S3 adapter on non-Bun runtimes.',
      );
    }
    const file = Bun.file(path);
    if (!(await file.exists())) return null;
    return new Uint8Array(await file.arrayBuffer());
  },
  async exists(path: string): Promise<boolean> {
    if (typeof Bun === 'undefined') {
      throw new Error(
        '[slingshot-assets] localStorage defaultFs requires a Bun runtime. ' +
          'Pass a custom `fs` implementation or use the S3 adapter on non-Bun runtimes.',
      );
    }
    return Bun.file(path).exists();
  },
};

/**
 * Structured error thrown when the local filesystem circuit breaker is open.
 * Callers can pattern-match on `code === 'LOCAL_CIRCUIT_OPEN'` to fail fast
 * without waiting for the underlying request retries.
 */
export class LocalCircuitOpenError extends Error {
  readonly code = 'LOCAL_CIRCUIT_OPEN' as const;
  readonly retryAfterMs: number;
  constructor(message: string, retryAfterMs: number) {
    super(message);
    this.name = 'LocalCircuitOpenError';
    this.retryAfterMs = retryAfterMs;
  }
}

/**
 * A circuit breaker wrapper that converts generic `CircuitOpenError` into
 * `LocalCircuitOpenError` so callers can pattern-match on the local code.
 */
function createLocalCircuitBreaker(inner: CircuitBreaker): {
  guard<T>(fn: () => Promise<T>, op: string): Promise<T>;
  getHealth(): CircuitBreakerState;
} {
  return {
    async guard<T>(fn: () => Promise<T>, op: string): Promise<T> {
      try {
        return await inner.guard(fn, op);
      } catch (err) {
        if (err instanceof CircuitOpenError) {
          throw new LocalCircuitOpenError(err.message, err.retryAfterMs);
        }
        throw err;
      }
    },
    getHealth: () => inner.getState(),
  };
}

/** Snapshot of the local adapter circuit breaker state. */
export interface LocalCircuitBreakerHealth {
  readonly state: 'closed' | 'open' | 'half-open';
  readonly consecutiveFailures: number;
  /** Epoch ms when the breaker last opened. `undefined` while closed. */
  readonly openedAt: number | undefined;
  /** Earliest epoch ms at which a half-open probe will be allowed. */
  readonly nextProbeAt: number | undefined;
}

/**
 * Configuration for the local filesystem storage adapter.
 */
export interface LocalStorageConfig {
  /** Root directory that stores all uploaded files. */
  readonly directory: string;
  /** Optional public base URL used to build `put()` results. */
  readonly baseUrl?: string;
  /** Runtime filesystem abstraction, mainly for tests. */
  readonly fs?: RuntimeFs;
  /**
   * Number of retry attempts for filesystem `put()`, `get()`, and `delete()`
   * operations before propagating the error. Each retry waits
   * `baseDelayMs × 2^attempt` before retrying. Default: 3.
   */
  readonly retryAttempts?: number;
  /**
   * Base delay in milliseconds for exponential backoff retry.
   * Default: 100 ms.
   */
  readonly retryBaseDelayMs?: number;
  /**
   * Circuit breaker — number of consecutive failed operations (after retries
   * exhaust) before the breaker opens and short-circuits subsequent calls.
   * Default: 5.
   */
  readonly circuitBreakerThreshold?: number;
  /**
   * Circuit breaker — cooldown duration in ms before allowing a half-open
   * probe after the breaker opens. Default: 30 000 ms.
   */
  readonly circuitBreakerCooldownMs?: number;
  /**
   * Circuit breaker — clock used for cooldown comparisons. Override in tests
   * for deterministic state machines. Default: `Date.now`.
   */
  readonly now?: () => number;
}

/**
 * Resolve a storage key to an absolute filesystem path under `directory`.
 *
 * Rejects empty keys, absolute paths, and any path that would escape the configured root.
 *
 * @param directory - Root directory for stored files.
 * @param key - Relative storage key.
 * @returns Absolute filesystem path for the key.
 */
function resolveKey(directory: string, key: string): string {
  if (!key || !key.trim()) throw new HttpError(400, 'Invalid storage key');

  // Reject NUL bytes — some Node fs APIs misbehave on these (truncation,
  // bypass of suffix checks, etc.). Belt-and-braces alongside the
  // base-directory containment check below.
  if (key.includes('\0')) throw new HttpError(400, 'Invalid storage key');

  const normalized = key.replace(/\\/g, '/');
  if (normalized.startsWith('/') || /^[a-zA-Z]:/.test(normalized) || normalized.startsWith('//')) {
    throw new HttpError(400, 'Invalid storage key');
  }

  const root = resolve(directory);
  const candidate = resolve(root, normalized);
  if (candidate === root || !candidate.startsWith(root + sep)) {
    throw new HttpError(400, 'Invalid storage key');
  }

  return candidate;
}

/**
 * Check whether an error is a transient filesystem error that is safe to retry.
 *
 * We retry on permission, resource-busy, descriptor-exhaustion, and I/O errors.
 * We do NOT retry on `ENOENT`, `ENOTDIR`, `EROFS`, or `EEXIST` — those are
 * logic errors that retrying will not fix.
 */
function isRetryableFsError(err: unknown): boolean {
  if (err instanceof HttpError) return false;
  if (err && typeof err === 'object') {
    const code = (err as { code?: string }).code;
    if (typeof code === 'string') {
      return (
        code === 'EACCES' ||
        code === 'EBUSY' ||
        code === 'EMFILE' ||
        code === 'ENOSPC' ||
        code === 'EPERM' ||
        code === 'EAGAIN' ||
        code === 'EWOULDBLOCK' ||
        code === 'EIO'
      );
    }
  }
  // For errors without a code (e.g. generic Error), retry — they could be
  // transient runtime issues.
  return true;
}

/**
 * Local storage adapter augmented with circuit breaker observability.
 *
 * The returned object satisfies `StorageAdapter` and exposes a stable
 * `getCircuitBreakerHealth()` helper so callers (health endpoints, metrics)
 * can surface breaker state without poking at internals.
 */
export interface LocalStorageAdapter extends StorageAdapter {
  /** Inspect the circuit breaker — stable observability surface. */
  getCircuitBreakerHealth(): LocalCircuitBreakerHealth;
}

/**
 * Create a `StorageAdapter` backed by the local filesystem.
 *
 * The adapter wraps every filesystem operation (put/get/delete) in a circuit
 * breaker. After `circuitBreakerThreshold` consecutive operation failures
 * (each one already retried up to `retryAttempts` times with exponential
 * backoff) the breaker opens for `circuitBreakerCooldownMs` and rejects
 * subsequent calls with `LocalCircuitOpenError` (`code: 'LOCAL_CIRCUIT_OPEN'`)
 * until the cooldown elapses, then admits a single half-open probe.
 *
 * @param config - Local storage configuration.
 * @returns A storage adapter that reads and writes under `config.directory`.
 */
export function localStorage(config: LocalStorageConfig): LocalStorageAdapter {
  const fs = config.fs ?? defaultFs;
  const retryAttempts = config.retryAttempts ?? 3;
  const retryBaseDelayMs = config.retryBaseDelayMs ?? 100;

  const breaker = createLocalCircuitBreaker(
    createCircuitBreaker({
      threshold: config.circuitBreakerThreshold ?? 5,
      cooldownMs: config.circuitBreakerCooldownMs ?? 30_000,
      now: config.now ?? (() => Date.now()),
    }),
  );

  return {
    getCircuitBreakerHealth: () => breaker.getHealth(),

    async put(key, data) {
      const filePath = resolveKey(config.directory, key);
      return breaker.guard(async () => {
        const directoryPath = dirname(filePath);

        if (directoryPath) {
          const { mkdir } = await import('node:fs/promises');
          await withRetry(
            () => mkdir(directoryPath, { recursive: true }),
            retryAttempts,
            retryBaseDelayMs,
            isRetryableFsError,
          );
        }

        await withRetry(
          async () => {
            if (data instanceof Blob) {
              const buffer = await data.arrayBuffer();
              await fs.write(filePath, new Uint8Array(buffer));
            } else if (data instanceof ReadableStream) {
              const response = new Response(data);
              const buffer = await response.arrayBuffer();
              await fs.write(filePath, new Uint8Array(buffer));
            } else {
              await fs.write(filePath, data);
            }
          },
          retryAttempts,
          retryBaseDelayMs,
          isRetryableFsError,
        );

        const url = config.baseUrl ? `${config.baseUrl.replace(/\/$/, '')}/${key}` : undefined;
        return url === undefined ? {} : { url };
      }, 'put');
    },

    async get(key) {
      const filePath = resolveKey(config.directory, key);
      return breaker.guard(async () => {
        const bytes = await withRetry(
          () => fs.readFile(filePath),
          retryAttempts,
          retryBaseDelayMs,
          isRetryableFsError,
        );
        if (bytes === null) return null;

        const stream = new ReadableStream({
          start(controller) {
            controller.enqueue(bytes);
            controller.close();
          },
        });

        return { stream, size: bytes.byteLength };
      }, 'get');
    },

    async delete(key) {
      const filePath = resolveKey(config.directory, key);
      return breaker.guard(async () => {
        try {
          await withRetry(
            () => unlink(filePath),
            retryAttempts,
            retryBaseDelayMs,
            isRetryableFsError,
          );
        } catch {
          // Missing files are a safe no-op.
        }
      }, 'delete');
    },
  };
}
