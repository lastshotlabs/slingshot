/**
 * Outcome of error classification used to decide retry vs. fail-fast.
 * `permanent: true` means the error must surface to the caller without retry.
 */
export interface ErrorClassification {
  retryable: boolean;
  permanent: boolean;
  code?: string;
}

/**
 * Allowlist of OS- and Redis-level errors we treat as transient (retryable).
 * Anything else is permanent and should fail-fast: retrying a logic bug or a
 * configuration error wastes worker capacity and obscures the real failure.
 */
const TRANSIENT_ERROR_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'EPIPE',
  'ETIMEDOUT',
  'ENOTFOUND',
  'EAI_AGAIN',
]);

const TRANSIENT_REDIS_NAMES = new Set(['ConnectionError', 'ReplyError', 'TimeoutError']);

/**
 * Classify an error as transient (retryable) or permanent (fail-fast) based on
 * known OS-level and Redis-level error codes. Used by the BullMQ adapter to decide
 * whether a failed job should be retried or surfaced immediately.
 */
export function classifyOrchestrationError(err: unknown): ErrorClassification {
  if (err === null || err === undefined) {
    return { retryable: false, permanent: true };
  }
  if (err instanceof Error) {
    const code = (err as Error & { code?: string }).code;
    if (typeof code === 'string' && TRANSIENT_ERROR_CODES.has(code)) {
      return { retryable: true, permanent: false, code };
    }
    if (TRANSIENT_REDIS_NAMES.has(err.name)) {
      return { retryable: true, permanent: false, code };
    }
    // ioredis-style 'ReadyError' / cluster reconfiguration errors
    if (/READONLY|MOVED|LOADING|MASTERDOWN|CLUSTERDOWN|TRYAGAIN/.test(err.message)) {
      return { retryable: true, permanent: false, code };
    }
    return { retryable: false, permanent: true, code };
  }
  return { retryable: false, permanent: true };
}
