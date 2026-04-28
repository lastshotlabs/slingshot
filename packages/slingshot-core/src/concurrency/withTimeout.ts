/**
 * Promise and AbortSignal timeout helpers.
 *
 * `withTimeout` wraps an arbitrary promise and rejects with {@link TimeoutError}
 * if the configured deadline elapses before the promise settles. The internal
 * timer is always cleared when the wrapped promise resolves or rejects, so a
 * fast-settling promise will not produce a delayed rejection from a stale
 * timer.
 *
 * `timeoutSignal` returns an `AbortSignal` that is aborted after `timeoutMs`.
 * Useful for libraries (HTTP clients, streams) that accept an `AbortSignal`
 * directly and do not need a wrapping promise.
 */

/**
 * Thrown by {@link withTimeout} when the configured timeout elapses before the
 * wrapped promise settles.
 */
export class TimeoutError extends Error {
  constructor(
    public readonly timeoutMs: number,
    public readonly label?: string,
  ) {
    super(label ? `Timed out after ${timeoutMs}ms: ${label}` : `Timed out after ${timeoutMs}ms`);
    this.name = 'TimeoutError';
  }
}

/**
 * Wrap a promise with an upper-bound timeout. Resolves or rejects with the
 * underlying promise's outcome if it settles before `timeoutMs`. Otherwise
 * rejects with a {@link TimeoutError}. The internal timer is cleared as soon
 * as the underlying promise settles, so this helper does not leak timers.
 *
 * @param promise - The promise to race against the timeout.
 * @param timeoutMs - Maximum time in milliseconds to wait before rejecting.
 * @param label - Optional label used in the timeout error message.
 */
export function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label?: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new TimeoutError(timeoutMs, label));
    }, timeoutMs);
    promise.then(
      value => {
        clearTimeout(timer);
        resolve(value);
      },
      err => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

/**
 * Create an {@link AbortSignal} that aborts after `timeoutMs`. The returned
 * signal is independent — callers do not need to dispose of anything when the
 * operation completes early.
 */
export function timeoutSignal(timeoutMs: number): AbortSignal {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new TimeoutError(timeoutMs)), timeoutMs);
  if (typeof (timer as unknown as { unref?: () => void }).unref === 'function') {
    (timer as unknown as { unref: () => void }).unref();
  }
  return controller.signal;
}
