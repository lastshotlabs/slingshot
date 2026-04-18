// packages/slingshot-ssr/src/draft/routes.ts
// Hono router for draft mode enable/disable endpoints.
//
// Mount under `/api/draft` (or any prefix) via `app.route(...)`.
// Enables and disables the draft mode cookie used by `isDraftRequest()`
// to bypass the ISR cache.
import { Hono } from 'hono';
import { draftMode, withDraftContext } from './index';

// ─── Router factory ───────────────────────────────────────────────────────────

/**
 * Build the Hono router that handles draft mode enable/disable requests.
 *
 * Exposes two endpoints:
 *
 * - `GET /api/draft/enable?secret=<token>` — validates the secret, sets the
 *   draft mode cookie, and redirects to `?redirect=<path>` (default: `/`).
 *   Returns 401 when the secret does not match.
 *
 * - `GET /api/draft/disable` — clears the draft mode cookie and redirects to
 *   `?redirect=<path>` (default: `/`). No secret required to disable.
 *
 * Mount this router under `/api/draft` on your app:
 * ```ts
 * app.route('/api/draft', buildDraftRouter(secret));
 * ```
 *
 * @param secret - The secret token that must be supplied as `?secret=` to
 *   enable draft mode. Keep this value out of client-side code. Pass it via
 *   an environment variable (e.g. `process.env.DRAFT_MODE_SECRET`).
 * @returns A Hono router to mount under `/api/draft`.
 *
 * @example Mounting in a Slingshot app
 * ```ts
 * // In your slingshot app entry or SSR plugin setup:
 * import { buildDraftRouter } from '@lastshotlabs/slingshot-ssr/draft/routes';
 *
 * app.route('/api/draft', buildDraftRouter(process.env.DRAFT_MODE_SECRET ?? ''));
 * ```
 *
 * @example Enabling draft mode from a CMS webhook or preview link
 * ```
 * GET /api/draft/enable?secret=my-secret&redirect=/posts/draft-post-slug
 * ```
 */
export function buildDraftRouter(secret: string): Hono {
  const frozenSecret = Object.freeze({ value: secret });
  const router = new Hono();

  /**
   * GET /enable?secret=<token>[&redirect=<path>]
   *
   * Validates the provided `secret` query parameter against the configured
   * draft mode secret. On success, sets the draft mode cookie and redirects
   * to the `redirect` query parameter path (default: `/`). On failure,
   * returns 401 Unauthorized.
   */
  router.get('/enable', c => {
    const providedSecret = c.req.query('secret');

    if (!providedSecret || providedSecret !== frozenSecret.value) {
      return c.json({ error: 'Unauthorized' }, 401);
    }

    const redirectTo = c.req.query('redirect') ?? '/';
    // Sanitise: only allow relative paths to prevent open redirect attacks.
    const safePath = redirectTo.startsWith('/') ? redirectTo : '/';

    return withDraftContext(c, () => {
      draftMode().enable();
      return c.redirect(safePath, 302);
    });
  });

  /**
   * GET /disable[?redirect=<path>]
   *
   * Clears the draft mode cookie and redirects to the `redirect` query
   * parameter path (default: `/`). No secret is required to disable.
   */
  router.get('/disable', c => {
    const redirectTo = c.req.query('redirect') ?? '/';
    const safePath = redirectTo.startsWith('/') ? redirectTo : '/';

    return withDraftContext(c, () => {
      draftMode().disable();
      return c.redirect(safePath, 302);
    });
  });

  return router;
}
