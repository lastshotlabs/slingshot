import type { z } from 'zod';

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
export class HttpError extends Error {
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
export class ValidationError extends HttpError {
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
