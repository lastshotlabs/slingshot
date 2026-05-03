import type { StorageAdapter } from '@lastshotlabs/slingshot-core';
import { DEFAULT_MAX_ENTRIES, evictOldest } from '@lastshotlabs/slingshot-core';
import { type CircuitBreakerState, CircuitOpenError, createCircuitBreaker } from './circuitBreaker';

/**
 * Structured error thrown when the memory storage circuit breaker is open.
 * Callers can pattern-match on `code === 'MEMORY_CIRCUIT_OPEN'` to fail fast.
 */
export class MemoryCircuitOpenError extends Error {
  readonly code = 'MEMORY_CIRCUIT_OPEN' as const;
  readonly retryAfterMs: number;
  constructor(message: string, retryAfterMs: number) {
    super(message);
    this.name = 'MemoryCircuitOpenError';
    this.retryAfterMs = retryAfterMs;
  }
}

/**
 * A circuit breaker wrapper that converts generic `CircuitOpenError` into
 * `MemoryCircuitOpenError` so callers can pattern-match on the memory code.
 */
function createMemoryCircuitBreaker(inner: ReturnType<typeof createCircuitBreaker>): {
  guard<T>(fn: () => Promise<T>, op: string): Promise<T>;
  getHealth(): CircuitBreakerState;
} {
  return {
    async guard<T>(fn: () => Promise<T>, op: string): Promise<T> {
      try {
        return await inner.guard(fn, op);
      } catch (err) {
        if (err instanceof CircuitOpenError) {
          throw new MemoryCircuitOpenError(err.message, err.retryAfterMs);
        }
        throw err;
      }
    },
    getHealth: () => inner.getState(),
  };
}

/** Snapshot of the memory adapter circuit breaker state. */
export interface MemoryCircuitBreakerHealth {
  readonly state: 'closed' | 'open' | 'half-open';
  readonly consecutiveFailures: number;
  /** Epoch ms when the breaker last opened. `undefined` while closed. */
  readonly openedAt: number | undefined;
  /** Earliest epoch ms at which a half-open probe will be allowed. */
  readonly nextProbeAt: number | undefined;
}

/**
 * Memory storage adapter augmented with circuit breaker observability.
 *
 * The returned object satisfies `StorageAdapter` and exposes a stable
 * `getCircuitBreakerHealth()` helper so callers (health endpoints, metrics)
 * can surface breaker state without poking at internals.
 */
export interface MemoryStorageAdapter extends StorageAdapter {
  /** Inspect the circuit breaker — stable observability surface. */
  getCircuitBreakerHealth(): MemoryCircuitBreakerHealth;
}

/**
 * Create a `StorageAdapter` that stores files in-process in memory.
 *
 * Suitable for development and tests only.
 *
 * @param options - Optional configuration.
 * @returns A fresh in-memory storage adapter.
 */
export function memoryStorage(
  options: {
    /**
     * Circuit breaker — number of consecutive operation failures before the
     * breaker opens and short-circuits subsequent calls. Default: 5.
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
  } = {},
): MemoryStorageAdapter {
  const store = new Map<string, { data: Buffer; mimeType: string; size: number }>();

  const breaker = createMemoryCircuitBreaker(
    createCircuitBreaker({
      threshold: options.circuitBreakerThreshold ?? 5,
      cooldownMs: options.circuitBreakerCooldownMs ?? 30_000,
      now: options.now ?? (() => Date.now()),
    }),
  );

  return {
    getCircuitBreakerHealth: () => breaker.getHealth(),

    async put(key, data, meta) {
      return breaker.guard(async () => {
        let buffer: Buffer;

        if (data instanceof Blob) {
          buffer = Buffer.from(await data.arrayBuffer());
        } else if (data instanceof ReadableStream) {
          const chunks: Uint8Array[] = [];
          const reader = (data as ReadableStream<Uint8Array>).getReader();
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            chunks.push(value);
          }
          buffer = Buffer.concat(chunks);
        } else {
          buffer = data;
        }

        evictOldest(store, DEFAULT_MAX_ENTRIES);
        store.set(key, { data: buffer, mimeType: meta.mimeType, size: meta.size });
        return {};
      }, 'put');
    },

    async get(key) {
      return breaker.guard(async () => {
        const entry = store.get(key);
        if (!entry) return null;

        const stream = new ReadableStream({
          start(controller) {
            controller.enqueue(entry.data);
            controller.close();
          },
        });

        return { stream, mimeType: entry.mimeType, size: entry.size };
      }, 'get');
    },

    async delete(key) {
      return breaker.guard(async () => {
        store.delete(key);
      }, 'delete');
    },
  };
}
