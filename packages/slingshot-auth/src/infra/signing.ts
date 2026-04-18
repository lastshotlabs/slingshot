import type { SigningConfig } from '@lastshotlabs/slingshot-core';

/**
 * Extracts the raw signing secret (or array of secrets for rotation) from a resolved
 * `SigningConfig`.
 *
 * There is **no `process.env` fallback** — secret resolution happens during framework
 * bootstrap when the secrets provider injects `JWT_SECRET` (or equivalent) into the
 * `SigningConfig.secret` field. If `signing` is absent or its `secret` is unset, `null`
 * is returned and the caller is responsible for surfacing a helpful error.
 *
 * @param signing - The resolved `SigningConfig` from the auth runtime or Hono context,
 *   or `null` / `undefined` if signing is not configured.
 * @returns The secret as a `string` (single secret), `string[]` (rotating secrets —
 *   first element is the active signing key, rest are for verification only), or `null`
 *   when no signing config is present.
 *
 * @throws Never throws — callers that require a non-null secret should throw themselves
 *   with an appropriate error message (see usage in `getCsrfSecret`).
 *
 * @example
 * import { getSigningSecret } from '@lastshotlabs/slingshot-auth/plugin';
 *
 * const secret = getSigningSecret(runtime.signing);
 * if (!secret) throw new Error('Signing secret not configured');
 * const activeKey = Array.isArray(secret) ? secret[0] : secret;
 */
export function getSigningSecret(signing?: SigningConfig | null): string | string[] | null {
  return signing?.secret ?? null;
}
