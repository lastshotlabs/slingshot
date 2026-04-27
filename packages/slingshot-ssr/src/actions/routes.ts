// packages/slingshot-ssr/src/actions/routes.ts
// Hono router for the POST /_snapshot/action server action endpoint.
import path from 'node:path';
import { Hono } from 'hono';
import { withActionContext } from './context';
import { resolveAction } from './registry';

// ─── Types ────────────────────────────────────────────────────────────────────

/**
 * Minimal ISR invalidation interface required by the action router.
 *
 * Matches the shape of `IsrInvalidators` from `../isr/revalidate` — defined
 * structurally here to avoid a circular import between `actions/routes` and `isr/`.
 */
export interface ActionIsrInvalidators {
  /** Invalidate the ISR cache entry for a specific URL pathname. */
  revalidatePath(path: string): Promise<void>;
  /** Invalidate all ISR cache entries tagged with the given tag. */
  revalidateTag(tag: string): Promise<void>;
}

/**
 * Configuration for the server action router.
 *
 * Frozen at creation time (Rule 12).
 */
export interface ActionRouterConfig {
  /**
   * Trusted origins for CSRF protection.
   *
   * Requests whose `Origin` header does not match the server's origin (scheme +
   * hostname + port) and is not in this list are rejected with 403.
   *
   * Values must be full origins, not bare hostnames — include the scheme and,
   * if non-standard, the port: `'https://app.example.com'` not `'app.example.com'`.
   *
   * Pass an empty array to allow same-origin requests only (default).
   *
   * @example `['https://app.example.com', 'https://staging.example.com:8443']`
   */
  readonly trustedOrigins: readonly string[];
  /**
   * Absolute path to the directory containing server action modules.
   *
   * Module names in action requests are resolved relative to this directory.
   * For example, module name `"posts"` resolves to `{serverActionsDir}/posts.js`
   * (or `.ts` in Bun).
   *
   * @default `process.cwd() + '/server/actions'`
   */
  readonly serverActionsDir: string;
  /**
   * ISR invalidation utilities for `revalidatePath()` and `revalidateTag()`.
   *
   * When provided, server actions that call `revalidatePath()` or
   * `revalidateTag()` will have access to the ISR cache adapter via
   * `withActionContext()`. When omitted, those ambient calls throw with a
   * clear error explaining that ISR is not configured.
   *
   * Pass the `IsrInvalidators` stored in `pluginState` under
   * `SSR_ISR_INVALIDATORS_STATE_KEY`.
   */
  readonly isrInvalidators?: ActionIsrInvalidators;
}

/** JSON body for `application/json` action requests. @internal */
interface ActionJsonBody {
  module: string;
  action: string;
  args: unknown[];
}

// ─── Redirect signal ──────────────────────────────────────────────────────────

/**
 * Throw `ActionRedirect` from a server action to redirect the client.
 *
 * In JSON mode the response is `{ redirect: "/path" }` with HTTP 200.
 * In form/progressive-enhancement mode the server responds with a real HTTP
 * redirect to the given path.
 *
 * @example
 * ```ts
 * 'use server';
 * import { ActionRedirect } from '@lastshotlabs/slingshot-ssr/actions';
 *
 * export async function deletePost(id: string) {
 *   await postRepo.delete(id);
 *   throw new ActionRedirect('/posts');
 * }
 * ```
 */
export class ActionRedirect extends Error {
  /** The path to redirect to. */
  readonly destination: string;

  constructor(destination: string) {
    super(`ActionRedirect: ${destination}`);
    this.name = 'ActionRedirect';
    this.destination = destination;
  }
}

// ─── Origin check ─────────────────────────────────────────────────────────────

/**
 * Returns `true` when the `Origin` header is acceptable.
 *
 * Same-origin requests (no Origin header, or Origin matches the request's full
 * origin — scheme + hostname + port) are always allowed. Additional origins in
 * `trustedOrigins` are also allowed.
 *
 * Full origin comparison (not just hostname) prevents scheme or port confusion
 * attacks where `https://example.com:444` would incorrectly match `https://example.com`
 * if only hostnames were compared.
 *
 * @internal
 */
function isOriginAllowed(
  originHeader: string | undefined,
  requestUrl: string,
  trustedOrigins: readonly string[],
): boolean {
  // No Origin header — same-origin form submit or server-to-server. Allow.
  if (!originHeader) return true;

  let requestOrigin: string;
  try {
    // URL.origin normalizes scheme + hostname + port into a single string,
    // e.g. "https://example.com" or "https://example.com:8443".
    requestOrigin = new URL(originHeader).origin;
  } catch {
    // Malformed Origin — reject.
    return false;
  }

  // Same origin as the request URL — compare full origins, not just hostnames.
  try {
    const serverOrigin = new URL(requestUrl).origin;
    if (requestOrigin === serverOrigin) return true;
  } catch {
    // If we can't parse the request URL fall through to the trusted list check.
  }

  return trustedOrigins.includes(requestOrigin);
}

/**
 * Convert a caller-supplied redirect target into a safe same-origin path.
 *
 * External origins and malformed values collapse to `/` so router-owned
 * redirects cannot be turned into open redirects via forged `Referer` headers
 * or unsafe `ActionRedirect` destinations.
 */
function toSafeRedirectPath(target: string | undefined, requestUrl: string): string {
  if (!target) return '/';

  let requestOrigin: string;
  try {
    requestOrigin = new URL(requestUrl).origin;
  } catch {
    requestOrigin = 'http://localhost';
  }

  try {
    const resolved = new URL(target, requestOrigin);
    if (resolved.origin !== requestOrigin) return '/';
    return `${resolved.pathname}${resolved.search}${resolved.hash}`;
  } catch {
    return '/';
  }
}

// ─── Module resolution ────────────────────────────────────────────────────────

/**
 * Resolve an action module name to an absolute file path.
 *
 * Module names are path-safe: they must not contain `..` or absolute path
 * segments. Any attempt to traverse outside `serverActionsDir` is rejected
 * by returning `null`.
 *
 * @internal
 */
function resolveModulePath(serverActionsDir: string, moduleName: string): string | null {
  // Reject names that are clearly path traversal attempts or absolute paths.
  const useWin32Path = hasWindowsPathSyntax(serverActionsDir) || hasWindowsPathSyntax(moduleName);
  const pathApi = useWin32Path ? path.win32 : path.posix;

  if (moduleName.includes('..') || pathApi.isAbsolute(moduleName) || moduleName.includes('\0')) {
    return null;
  }

  const resolved = pathApi.resolve(serverActionsDir, moduleName);

  // Ensure the resolved path is still inside serverActionsDir.
  const relative = pathApi.relative(serverActionsDir, resolved);
  if (relative.startsWith('..') || pathApi.isAbsolute(relative)) {
    return null;
  }

  return resolved;
}

function hasWindowsPathSyntax(value: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(value) || value.startsWith('\\\\');
}

// ─── Router factory ───────────────────────────────────────────────────────────

/**
 * Build the Hono router that handles `POST /_snapshot/action`.
 *
 * Mount this under `/_snapshot` on your app:
 * ```ts
 * app.route('/_snapshot', buildActionRouter(config));
 * ```
 *
 * **Request formats:**
 *
 * JSON (fetch from JS client):
 * ```
 * POST /_snapshot/action
 * Content-Type: application/json
 * { "module": "posts", "action": "createPost", "args": [...] }
 * ```
 *
 * Form (progressive enhancement, no JS):
 * ```
 * POST /_snapshot/action
 * Content-Type: multipart/form-data
 * _module=posts&_action=createPost&<form fields>
 * ```
 *
 * **Responses:**
 * - `200 { "result": ... }` — success
 * - `200 { "redirect": "/path" }` — action threw `ActionRedirect` (JSON mode)
 * - `302 Location: /path` — action threw `ActionRedirect` (form mode)
 * - `400 { "error": "..." }` — malformed request
 * - `403 { "error": "Forbidden" }` — cross-origin request
 * - `404 { "error": "..." }` — module or action not found
 * - `500 { "error": "..." }` — action threw an unexpected error
 *
 * @param config - Router configuration. Frozen at call time.
 * @returns A Hono router to mount under `/_snapshot`.
 */
export function buildActionRouter(config: ActionRouterConfig): Hono {
  const frozenConfig = Object.freeze({ ...config }) as Readonly<ActionRouterConfig>;
  const router = new Hono();

  router.post('/action', async c => {
    // ── CSRF origin check ──────────────────────────────────────────────────
    const originHeader = c.req.header('origin');
    if (!isOriginAllowed(originHeader, c.req.url, frozenConfig.trustedOrigins)) {
      return c.json({ error: 'Forbidden' }, 403);
    }

    const contentType = c.req.header('content-type') ?? '';
    const isFormSubmit =
      contentType.includes('multipart/form-data') ||
      contentType.includes('application/x-www-form-urlencoded');

    // ── Parse request ──────────────────────────────────────────────────────
    let moduleName: string;
    let actionName: string;
    let actionArgs: unknown[];

    if (isFormSubmit) {
      // Progressive enhancement: module + action come from hidden form fields.
      const formData = await c.req.formData();
      const moduleField = formData.get('_module');
      const actionField = formData.get('_action');
      moduleName = typeof moduleField === 'string' ? moduleField : '';
      actionName = typeof actionField === 'string' ? actionField : '';
      // Pass the full FormData as the single argument (mirrors `<form action={fn}>` React behaviour).
      actionArgs = [formData];
    } else {
      // JSON mode.
      let body: ActionJsonBody;
      try {
        body = await c.req.json();
      } catch {
        return c.json({ error: 'Invalid JSON body' }, 400);
      }

      if (
        typeof body.module !== 'string' ||
        typeof body.action !== 'string' ||
        !Array.isArray(body.args)
      ) {
        return c.json(
          { error: 'Request must include module (string), action (string), and args (array)' },
          400,
        );
      }

      ({ module: moduleName, action: actionName, args: actionArgs } = body);
    }

    if (!moduleName || !actionName) {
      return c.json({ error: 'module and action are required' }, 400);
    }

    // ── Resolve module ─────────────────────────────────────────────────────
    const modulePath = resolveModulePath(frozenConfig.serverActionsDir, moduleName);
    if (modulePath === null) {
      return c.json({ error: `Invalid module name: ${moduleName}` }, 400);
    }

    const fn = await resolveAction(modulePath, actionName);
    if (fn === null) {
      return c.json({ error: `Action not found: ${moduleName}#${actionName}` }, 404);
    }

    // ── Invoke action ──────────────────────────────────────────────────────
    // Wrap the action in withActionContext() so that revalidatePath() and
    // revalidateTag() — which use AsyncLocalStorage — resolve to the ISR adapter
    // rather than throwing "called outside of a server action context".
    // Without ISR invalidators, actions still run, but revalidation helpers
    // should fail loudly instead of silently becoming no-ops.
    const invokeAction = () => Promise.resolve(fn(...actionArgs));
    try {
      const result = frozenConfig.isrInvalidators
        ? await withActionContext(frozenConfig.isrInvalidators, invokeAction)
        : await invokeAction();

      if (isFormSubmit) {
        // Form mode: redirect back to referer (or root) after success.
        const referer = toSafeRedirectPath(c.req.header('referer'), c.req.url);
        return c.redirect(referer, 302);
      }

      return c.json({ result }, 200);
    } catch (err: unknown) {
      if (err instanceof ActionRedirect) {
        const destination = toSafeRedirectPath(err.destination, c.req.url);
        if (isFormSubmit) {
          return c.redirect(destination, 302);
        }
        return c.json({ redirect: destination }, 200);
      }

      const message = err instanceof Error ? err.message : String(err);
      const publicMessage = process.env.NODE_ENV === 'production' ? 'Action failed' : message;

      if (isFormSubmit) {
        // For progressive enhancement, redirect back with an error query param.
        const referer = toSafeRedirectPath(c.req.header('referer'), c.req.url);
        const url = new URL(referer, 'http://localhost');
        url.searchParams.set('_error', publicMessage);
        return c.redirect(url.pathname + url.search, 302);
      }

      return c.json({ error: publicMessage }, 500);
    }
  });

  return router;
}
