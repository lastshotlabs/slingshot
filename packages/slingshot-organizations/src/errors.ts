import { HTTPException } from 'hono/http-exception';

/**
 * Stable error code emitted in responses and logs when a slug uniqueness
 * conflict is detected.
 */
export const SLUG_CONFLICT_CODE = 'SLUG_CONFLICT' as const;

/**
 * Thrown when an organization slug collides with an existing record.
 *
 * Surfaces as HTTP 409. The pre-flight slug-availability check is a UX
 * optimisation — correctness depends on the unique constraint on the
 * `Organization.slug` index combined with this typed error. Catch the raw
 * duplicate-key error from the persistence layer and rethrow as
 * `SlugConflictError` so callers always observe a stable, machine-readable
 * conflict signal.
 *
 * Extends `HTTPException` so it is handled cleanly by Hono routes (returns
 * a 409 response with the error body) while remaining catchable as a
 * typed error in programmatic use.
 *
 * @example
 * ```ts
 * try {
 *   await orgService.createOrg({ name: 'Acme', slug: 'acme' });
 * } catch (err) {
 *   if (err instanceof SlugConflictError) {
 *     // surface a friendly conflict response
 *   }
 * }
 * ```
 */
export class SlugConflictError extends HTTPException {
  /** Machine-readable error code. */
  static readonly CODE = SLUG_CONFLICT_CODE;
  /** Instance copy for runtime branching without static lookup. */
  public readonly code: typeof SLUG_CONFLICT_CODE = SLUG_CONFLICT_CODE;

  /** The slug value that collided. */
  public readonly slug: string;

  constructor(slug: string, message?: string) {
    const body = JSON.stringify({
      error: message ?? `Slug '${slug}' is already in use`,
      code: SLUG_CONFLICT_CODE,
      slug,
    });
    super(409, {
      message: message ?? `Slug '${slug}' is already in use`,
      res: new Response(body, {
        status: 409,
        headers: { 'content-type': 'application/json' },
      }),
    });
    this.name = 'SlugConflictError';
    this.slug = slug;
  }
}

/**
 * Heuristic detection for unique-constraint / duplicate-key violations
 * thrown by entity adapters across backends.
 *
 * Detects:
 * - The in-memory adapter's `HttpError(409, ..., 'UNIQUE_VIOLATION')`
 * - Postgres `23505` SQLSTATE (unique_violation)
 * - MongoDB duplicate-key error code `11000`
 * - Generic messages containing "unique" or "duplicate" (case-insensitive)
 *
 * Does NOT match a `SlugConflictError` itself — callers should check for
 * that separately if they need to distinguish "already converted" from
 * "raw driver error".
 */
export function isUniqueViolationError(err: unknown): boolean {
  if (err === null || typeof err !== 'object') return false;
  if (err instanceof SlugConflictError) return false;
  const e = err as { code?: unknown; status?: unknown; message?: unknown };

  if (typeof e.code === 'string') {
    if (e.code === 'UNIQUE_VIOLATION') return true;
    if (e.code === '23505') return true;
  }
  if (typeof e.code === 'number' && e.code === 11000) return true;

  if (typeof e.message === 'string') {
    const m = e.message.toLowerCase();
    if (m.includes('unique constraint') || m.includes('duplicate key')) return true;
    // Looser match tolerates vendor variability where the message is shaped
    // differently but still mentions uniqueness or duplication.
    if (m.includes('unique') || m.includes('duplicate')) return true;
  }

  return false;
}
