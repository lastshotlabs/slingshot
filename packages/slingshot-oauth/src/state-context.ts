// state-context — carry per-request context through the OAuth `state` token.
//
// The `state` parameter is, fundamentally, a CSRF nonce — a random value
// the api stores at flow-start and validates at callback to prove the
// callback originated from a flow this api initiated. Because the
// state-store backends (memory, sqlite, redis, mongo) treat `state` as
// an opaque string key, we can append a context suffix without
// touching any storage schema:
//
//   <random>.<base64url(json(context))>
//
// On callback the api parses the suffix, then **re-validates** every
// security-sensitive field (e.g. `returnTo` against
// `allowedRedirectUrls`). The suffix is *not* a trusted channel — an
// attacker who fabricates a callback URL could fabricate the suffix
// too. The CSRF check still relies entirely on the random prefix being
// present in the state store.
//
// Why this lives here and not in slingshot-auth: it's an OAuth-flow
// concern (the only consumers are slingshot-oauth's start/callback
// routes), and keeping the state-store interface minimal keeps the
// four backend implementations stable. Future per-flow context
// (preferred locale, MFA-stepup intent, …) lands in the same
// `OAuthFlowContext` shape.

const SEPARATOR = '.';

/**
 * Per-flow context carried through the OAuth state token.
 *
 * Add fields conservatively — every field is attacker-controllable
 * (the suffix is base64-encoded JSON, not signed) and must be
 * re-validated at callback time. `returnTo` is allowlisted against
 * `allowedRedirectUrls`; future fields should follow the same pattern.
 */
export interface OAuthFlowContext {
  /**
   * Absolute URL the callback should redirect to after a successful
   * exchange. Validated against `allowedRedirectUrls` on the callback
   * — a tampered value rejects, never falls through to the configured
   * default (which would silently undo the safety check).
   */
  returnTo?: string;
}

/**
 * Append an encoded context suffix to a random state value.
 *
 * The returned string is what gets passed to the OAuth provider AND
 * stored in the state-store. Both legs see the same opaque value, so
 * existing CSRF checks (which compare the callback's `?state=` to the
 * stored row) keep working.
 *
 * @param state - The random nonce from `generateState()`.
 * @param context - Per-flow context. Pass `{}` to skip the suffix.
 */
export function encodeStateWithContext(state: string, context: OAuthFlowContext): string {
  if (!context || Object.keys(context).length === 0) return state;
  const json = JSON.stringify(context);
  const suffix = base64UrlEncode(json);
  return `${state}${SEPARATOR}${suffix}`;
}

/**
 * Parse the context suffix off a state value (if present).
 *
 * Returns `{}` for legacy state values without a suffix and for any
 * suffix that fails to parse — callers must still validate every
 * field returned (see `OAuthFlowContext`'s field docs).
 */
export function parseStateContext(state: string): OAuthFlowContext {
  const sep = state.indexOf(SEPARATOR);
  if (sep < 0) return {};
  const suffix = state.slice(sep + 1);
  if (!suffix) return {};
  try {
    const json = base64UrlDecode(suffix);
    const parsed = JSON.parse(json) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const out: OAuthFlowContext = {};
      const r = (parsed as Record<string, unknown>).returnTo;
      if (typeof r === 'string') out.returnTo = r;
      return out;
    }
    return {};
  } catch {
    return {};
  }
}

function base64UrlEncode(input: string): string {
  return Buffer.from(input, 'utf8')
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function base64UrlDecode(input: string): string {
  const padded = input + '='.repeat((4 - (input.length % 4)) % 4);
  const restored = padded.replace(/-/g, '+').replace(/_/g, '/');
  return Buffer.from(restored, 'base64').toString('utf8');
}
