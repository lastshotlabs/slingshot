/**
 * Returns whether verbose (non-production) logging is enabled.
 *
 * Verbose mode is active when `LOGGING_VERBOSE=true` is set, or when
 * `NODE_ENV` is not `"production"`.  Setting `LOGGING_VERBOSE=false`
 * explicitly silences verbose output even in development.
 */
function isVerbose(): boolean {
  const v = process.env.LOGGING_VERBOSE;
  return v !== undefined ? v === 'true' : process.env.NODE_ENV !== 'production';
}

/**
 * Conditionally logs to `console.log` when verbose mode is active.
 *
 * Verbose mode is controlled by the `LOGGING_VERBOSE` environment variable.
 * When not set it defaults to `true` in non-production environments and
 * `false` in production, preventing noisy auth logs from reaching prod logs.
 *
 * @param args - Arguments forwarded directly to `console.log`.
 *
 * @example
 * log('[auth] login attempt for', email);
 */
export const log = (...args: unknown[]) => {
  if (isVerbose()) console.log(...args);
};

/**
 * Conditionally logs auth trace lines that may include user or session IDs.
 *
 * Like `log()`, but additionally requires `LOGGING_AUTH_TRACE=true` to be set.
 * This provides a second gate so that PII-containing lines (user IDs, session
 * IDs) are never emitted unless explicitly opted in, even in development.
 *
 * `LOGGING_AUTH_TRACE` is read on each call, so toggling it at runtime
 * takes effect immediately.
 *
 * @param args - Arguments forwarded to `log` (and ultimately `console.log`).
 *
 * @example
 * authTrace('[session] created session', sessionId, 'for user', userId);
 */
export const authTrace = (...args: unknown[]) => {
  if (process.env.LOGGING_AUTH_TRACE === 'true') log(...args);
};
