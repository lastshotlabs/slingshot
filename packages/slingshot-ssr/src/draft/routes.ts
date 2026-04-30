// packages/slingshot-ssr/src/draft/routes.ts
// Hono router for draft mode enable/disable endpoints.
//
// Mount under `/api/draft` (or any prefix) via `app.route(...)`.
// Enables and disables the draft mode cookie used by `isDraftRequest()`
// to bypass the ISR cache.
import { type Context, Hono } from 'hono';
import { draftMode, withDraftContext } from './index';

// ─── Router factory ───────────────────────────────────────────────────────────

const DRAFT_SECRET_HEADER = 'x-draft-mode-secret';

async function readDraftSecret(c: Context): Promise<string | undefined> {
  const headerSecret = c.req.header(DRAFT_SECRET_HEADER);
  if (headerSecret) return headerSecret;

  if (c.req.method !== 'POST') return undefined;

  const contentType = c.req.header('content-type') ?? '';
  try {
    if (contentType.includes('application/json')) {
      const body = (await c.req.json()) as unknown;
      if (
        body &&
        typeof body === 'object' &&
        typeof (body as { secret?: unknown }).secret === 'string'
      ) {
        return (body as { secret: string }).secret;
      }
    }
  } catch {
    return undefined;
  }

  return undefined;
}

function secretsMatch(providedSecret: string | undefined, expectedSecret: string): boolean {
  if (!providedSecret || !expectedSecret) return false;

  const encoder = new TextEncoder();
  const provided = encoder.encode(providedSecret);
  const expected = encoder.encode(expectedSecret);
  const length = Math.max(provided.length, expected.length);
  let mismatch = provided.length ^ expected.length;

  for (let i = 0; i < length; i += 1) {
    mismatch |= (provided[i] ?? 0) ^ (expected[i] ?? 0);
  }

  return mismatch === 0;
}

/**
 * Build the Hono router that handles draft mode enable/disable requests.
 *
 * Exposes two endpoints:
 *
 * - `POST /api/draft/enable` — validates the secret from the
 *   `X-Draft-Mode-Secret` header or JSON request body, sets the draft mode cookie,
 *   and redirects to `?redirect=<path>` (default: `/`). Returns 401 when the
 *   secret does not match.
 *
 * - `GET /api/draft/disable` — clears the draft mode cookie and redirects to
 *   `?redirect=<path>` (default: `/`). No secret required to disable.
 *
 * Mount this router under `/api/draft` on your app:
 * ```ts
 * app.route('/api/draft', buildDraftRouter(secret));
 * ```
 *
 * @param secret - The secret token required to enable draft mode. Keep this
 *   value out of client-side code and URLs. Pass it via an environment
 *   variable (e.g. `process.env.DRAFT_MODE_SECRET`).
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
 * @example Enabling draft mode from a CMS webhook
 * ```sh
 * curl -X POST /api/draft/enable?redirect=/posts/draft-post-slug \
 *   -H "X-Draft-Mode-Secret: $DRAFT_MODE_SECRET"
 * ```
 */
export function buildDraftRouter(secret: string): Hono {
  const frozenSecret = Object.freeze({ value: secret });
  const router = new Hono();

  /**
   * POST /enable[?redirect=<path>]
   *
   * Validates the provided header/JSON-body secret against the configured draft mode
   * secret. On success, sets the draft mode cookie and redirects to the
   * `redirect` query parameter path (default: `/`). On failure, returns 401
   * Unauthorized.
   */
  const handleEnable = async (c: Context) => {
    if (c.req.query('secret') !== undefined) {
      return c.json({ error: 'Draft mode secret must not be sent in the URL' }, 400);
    }

    const providedSecret = await readDraftSecret(c);
    if (!secretsMatch(providedSecret, frozenSecret.value)) {
      return c.json({ error: 'Unauthorized' }, 401);
    }

    const redirectTo = c.req.query('redirect') ?? '/';
    // Sanitise: only allow relative paths to prevent open redirect attacks.
    const safePath = redirectTo.startsWith('/') ? redirectTo : '/';

    return withDraftContext(c, () => {
      draftMode().enable();
      return c.redirect(safePath, 302);
    });
  };

  router.get('/enable', c => {
    if (c.req.query('secret') !== undefined) {
      return c.json({ error: 'Draft mode secret must not be sent in the URL' }, 400);
    }
    c.header('Allow', 'POST');
    return c.json({ error: 'Method Not Allowed' }, 405);
  });
  router.post('/enable', handleEnable);

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
