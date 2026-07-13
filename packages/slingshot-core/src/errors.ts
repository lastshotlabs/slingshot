import type { z } from 'zod';

/**
 * Base error class for all Slingshot errors.
 *
 * Carries a machine-readable `code` string for programmatic discrimination
 * and an optional `cause` for error chaining. Feature packages should extend
 * this class (or one of the HTTP-aware subclasses) rather than throwing
 * generic `Error` instances.
 *
 * @example
 * ```ts
 * import { SlingshotError } from '@lastshotlabs/slingshot-core';
 *
 * throw new SlingshotError('CONFIG_INVALID', 'mountPath must start with /');
 * ```
 */
export class SlingshotError extends Error {
  readonly code: string;
  override readonly cause?: Error;

  constructor(code: string, message: string, cause?: Error) {
    super(message);
    this.name = 'SlingshotError';
    this.code = code;
    this.cause = cause;
  }
}

/**
 * A typed HTTP error that carries a status code and optional machine-readable error code.
 *
 * Thrown from route handlers or middleware when a request cannot be fulfilled.
 * The framework's error handler converts `HttpError` instances into structured JSON responses.
 *
 * @example
 * ```ts
 * import { HttpError } from '@lastshotlabs/slingshot-core';
 *
 * throw new HttpError(404, 'Post not found', 'POST_NOT_FOUND');
 * ```
 */
/**
 * Cross-module brand for {@link HttpError}, keyed via the global symbol registry
 * (`Symbol.for`) so it is identical across every copy of this module. `instanceof`
 * is unreliable when the same package is loaded more than once in a process —
 * notably Node's ESM/CJS dual-instance hazard, where an `HttpError` thrown by one
 * copy is not an `instanceof` the `HttpError` class imported by another. The brand
 * survives that; see {@link isHttpError}.
 */
const HTTP_ERROR_BRAND: unique symbol = Symbol.for('@lastshotlabs/slingshot.HttpError');

export class HttpError extends Error {
  /** @internal Cross-module brand — see {@link isHttpError}. */
  readonly [HTTP_ERROR_BRAND] = true;

  /**
   * @param status - HTTP status code (e.g. 400, 403, 404, 500).
   * @param message - Human-readable error message sent to the client.
   * @param code - Optional machine-readable error code for client-side branching.
   */
  constructor(
    public status: number,
    message: string,
    public code?: string,
  ) {
    super(message);
  }
}

/**
 * Recognize an {@link HttpError} regardless of which copy of this module created
 * it. Prefer this over `instanceof HttpError` anywhere an error may cross a module
 * boundary (framework error handlers, runtime adapters) — under Node, `instanceof`
 * silently returns `false` for a genuine `HttpError` from a duplicate module
 * instance, which would otherwise surface a 401/404 as a generic 500.
 */
export function isHttpError(err: unknown): err is HttpError {
  return (
    typeof err === 'object' &&
    err !== null &&
    (err as Record<symbol, unknown>)[HTTP_ERROR_BRAND] === true
  );
}

/**
 * An `HttpError` subclass for Zod validation failures.
 *
 * Constructed with the raw `ZodIssue[]` array from a failed parse so that the
 * validation error formatter can produce structured per-field error details.
 * Always uses HTTP 400.
 *
 * @example
 * ```ts
 * import { ValidationError } from '@lastshotlabs/slingshot-core';
 *
 * const result = schema.safeParse(body);
 * if (!result.success) throw new ValidationError(result.error.issues);
 * ```
 */
/** Cross-module brand for {@link ValidationError}; see {@link HttpError}'s brand. */
const VALIDATION_ERROR_BRAND: unique symbol = Symbol.for('@lastshotlabs/slingshot.ValidationError');

export class ValidationError extends HttpError {
  /** @internal Cross-module brand — see {@link isValidationError}. */
  readonly [VALIDATION_ERROR_BRAND] = true;

  /** The raw Zod issues that caused validation to fail. */
  public readonly issues: z.core.$ZodIssue[];
  /**
   * @param issues - The Zod issues array from a failed `safeParse`.
   */
  constructor(issues: z.core.$ZodIssue[]) {
    super(400, 'Validation failed');
    this.issues = issues;
  }
}

/**
 * Recognize a {@link ValidationError} across module boundaries — the duplicate-copy
 * counterpart to {@link isHttpError}. Check this before {@link isHttpError} so the
 * structured Zod `issues` payload is not lost (`ValidationError` is also an `HttpError`).
 */
export function isValidationError(err: unknown): err is ValidationError {
  return (
    isHttpError(err) && (err as unknown as Record<symbol, unknown>)[VALIDATION_ERROR_BRAND] === true
  );
}

/**
 * Thrown when a method is called on an adapter that does not support the requested feature.
 *
 * Use this when implementing optional adapter capabilities that a caller may invoke
 * conditionally. Throwing this error surfaces a clear, actionable message instead of
 * a silent no-op or opaque crash.
 *
 * @example
 * ```ts
 * import { UnsupportedAdapterFeatureError } from '@lastshotlabs/slingshot-core';
 *
 * async listSessions(): Promise<SessionRecord[]> {
 *   throw new UnsupportedAdapterFeatureError('listSessions', 'MemoryAuthAdapter');
 * }
 * ```
 */
export class UnsupportedAdapterFeatureError extends Error {
  /**
   * @param feature - The unsupported feature or method name.
   * @param adapter - The adapter class or name that does not support it.
   */
  constructor(feature: string, adapter: string) {
    super(`${feature} is not supported by the ${adapter} adapter`);
    this.name = 'UnsupportedAdapterFeatureError';
  }
}
