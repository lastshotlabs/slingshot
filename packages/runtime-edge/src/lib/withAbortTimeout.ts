// packages/runtime-edge/src/lib/withAbortTimeout.ts
import { TimeoutError } from '@lastshotlabs/slingshot-core';

/**
 * Race an async operation against an AbortController-backed timeout.
 *
 * Creates an `AbortController`, passes its signal to the operation callback,
 * and aborts the controller when the deadline fires. The operation can use
 * the signal to cancel its underlying work (e.g., pass it to `fetch()` or
 * `kv.get()`). The returned promise rejects with `TimeoutError` when the
 * deadline is reached.
 *
 * When `heartbeatMs` is set and greater than `timeoutMs`, the shorter of the
 * two is used (the heartbeat acts as a global cap).
 *
 * @param op - Factory that receives an `AbortSignal` and returns the operation promise.
 * @param timeoutMs - Per-operation timeout in milliseconds. If 0 or negative,
 *   the operation runs without a timeout and a no-op signal (never aborted)
 *   is passed.
 * @param label - Optional label for the `TimeoutError` message.
 * @param heartbeatMs - Optional global heartbeat cap. The effective timeout
 *   is `Math.min(timeoutMs, heartbeatMs)` when both are positive.
 * @returns The operation's result, or rejects with `TimeoutError`.
 */
export function withAbortTimeout<T>(
  op: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
  label?: string,
  heartbeatMs: number = 0,
): Promise<T> {
  const effectiveMs =
    timeoutMs > 0 && heartbeatMs > 0
      ? Math.min(timeoutMs, heartbeatMs)
      : timeoutMs > 0
        ? timeoutMs
        : heartbeatMs;

  if (effectiveMs <= 0) {
    return op(new AbortController().signal);
  }

  const controller = new AbortController();
  const signal = controller.signal;
  const timer = setTimeout(() => controller.abort(), effectiveMs);

  const cleanup = (): void => {
    clearTimeout(timer);
  };

  const opPromise = op(signal).then(
    v => {
      cleanup();
      return v;
    },
    err => {
      cleanup();
      throw err;
    },
  );

  // Race the operation against the abort signal so we reject as soon as
  // the timeout fires, even if the op doesn't check the signal.
  return Promise.race([
    opPromise,
    new Promise<T>((_, reject) => {
      if (signal.aborted) {
        reject(new TimeoutError(effectiveMs, label));
        return;
      }
      const onAbort = (): void => {
        reject(new TimeoutError(effectiveMs, label));
      };
      signal.addEventListener('abort', onAbort, { once: true });
    }),
  ]);
}
