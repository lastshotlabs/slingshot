/**
 * CRLF / NUL injection guards for header-like and log-like sinks.
 *
 * When user-controlled values flow into HTTP headers, email headers, queue
 * message headers, or log lines without sanitization, an attacker can inject
 * carriage-return / line-feed sequences (`\r\n`, `\n`) and forge additional
 * headers, split log records, or hide malicious payloads in logs. This module
 * provides the two helpers prod-track packages should use at every boundary
 * that emits a header value or log fragment derived from external input.
 *
 * Two complementary functions are exposed:
 *
 * - {@link sanitizeHeaderValue} — strict, throws {@link HeaderInjectionError}
 *   when the input contains `\r`, `\n`, or NUL. Use at HTTP / email / queue
 *   header sinks where silent stripping would mask other bugs.
 * - {@link sanitizeLogValue} — lenient, escapes the same control characters
 *   so they appear as literal `\\r` / `\\n` / `\\0` in the log output.
 *   Logging must never throw, so this function never throws.
 */

/**
 * Thrown by {@link sanitizeHeaderValue} when a header value contains a
 * control character that would let a caller inject additional header lines.
 *
 * The error intentionally does not embed the offending value to avoid
 * leaking attacker-controlled bytes into error logs or telemetry.
 */
export class HeaderInjectionError extends Error {
  /** Logical name of the header (when the caller can supply one). */
  readonly header?: string;

  constructor(message: string, header?: string) {
    super(message);
    this.name = 'HeaderInjectionError';
    if (header !== undefined) {
      this.header = header;
    }
  }
}

const HEADER_FORBIDDEN = /[\r\n\0]/;

/**
 * Reject any string containing `\r`, `\n`, or NUL — the byte sequences that
 * terminate an HTTP / email / queue header line and let an attacker craft
 * additional headers ("response splitting" / header injection).
 *
 * Returns the input unchanged when it is safe so legitimate callers see no
 * behavior change. Throws {@link HeaderInjectionError} otherwise. The
 * surrounding code is expected to surface the error as a 4xx / config
 * rejection so the caller learns immediately rather than silently producing
 * a stripped value that may mask other validation bugs.
 *
 * @param value - Untrusted string destined for a header value.
 * @param header - Optional logical header name, included in the error so
 *   operators can pinpoint the failing sink without seeing the user input.
 */
export function sanitizeHeaderValue(value: string, header?: string): string {
  if (HEADER_FORBIDDEN.test(value)) {
    throw new HeaderInjectionError(
      header
        ? `Refusing to emit header "${header}": value contains CR, LF, or NUL`
        : 'Refusing to emit header: value contains CR, LF, or NUL',
      header,
    );
  }
  return value;
}

/**
 * Escape `\r`, `\n`, and NUL in a value destined for a log line so the
 * record cannot be split or smuggled by user-controlled bytes.
 *
 * Unlike {@link sanitizeHeaderValue}, this never throws — logging must
 * always succeed even when the input is malicious. Non-string inputs are
 * coerced via `String()` so callers can pass identifiers and error messages
 * without pre-stringifying.
 *
 * The escape representation matches the JSON-like convention (`\\r`,
 * `\\n`, `\\0`) so downstream log readers can recognise and unescape the
 * value if they need to display it verbatim.
 */
export function sanitizeLogValue(value: unknown): string {
  let str: string;
  try {
    str = typeof value === 'string' ? value : String(value);
  } catch {
    return '<unstringifiable>';
  }
  if (!HEADER_FORBIDDEN.test(str)) return str;
  return str.replace(/\r/g, '\\r').replace(/\n/g, '\\n').replace(/\0/g, '\\0');
}
