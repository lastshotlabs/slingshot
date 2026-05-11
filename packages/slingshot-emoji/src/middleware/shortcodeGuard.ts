import type { MiddlewareHandler } from 'hono';

/** Shortcode format: 2-32 lowercase alphanumeric + underscores. */
const SHORTCODE_RE = /^[a-z0-9_]{2,32}$/;

/**
 * Validates the `shortcode` field on emoji create requests.
 *
 * Returns 400 when the body's `shortcode` is present and fails the format
 * check. Passes the request through otherwise — non-POST methods and bodies
 * without a `shortcode` field are not the responsibility of this guard.
 */
export const shortcodeGuard: MiddlewareHandler = async (c, next) => {
  if (c.req.method !== 'POST') return next();
  const rawBody: unknown = await c.req.json().catch(() => null);
  const shortcode =
    rawBody != null && typeof rawBody === 'object' && 'shortcode' in rawBody
      ? (rawBody as { shortcode: unknown }).shortcode
      : undefined;
  if (typeof shortcode === 'string' && !SHORTCODE_RE.test(shortcode)) {
    return c.json(
      {
        error: 'Invalid shortcode',
        detail:
          'Shortcode must be 2-32 characters and contain only lowercase letters, digits, and underscores.',
      },
      400,
    );
  }
  return next();
};
