import { getSigningPrivateKey, getVerifyPublicKeys, isJwksLoaded } from '@auth/lib/jwks';
import { SignJWT, jwtVerify } from 'jose';
import type { JWTPayload } from 'jose';
import type { SigningConfig } from '@lastshotlabs/slingshot-core';
import type { AuthResolvedConfig } from '../config/authConfig';
import { getSigningSecret } from '../infra/signing';

function requireSecrets(signing?: SigningConfig | null): string[] {
  const raw = getSigningSecret(signing);
  if (!raw) {
    throw new Error(
      `[security] No JWT secret configured. Provide a signing config via createApp({ security: { signing: { secret: "..." } } }) or configure a SecretRepository with JWT_SECRET.`,
    );
  }
  const secrets = Array.isArray(raw) ? raw : [raw];
  if (secrets[0].length < 32) {
    throw new Error(
      `[security] JWT secret is too short (${secrets[0].length} chars). Must be at least 32 characters. ` +
        `Generate one with: node -e "console.log(require('crypto').randomBytes(64).toString('hex'))"`,
    );
  }
  return secrets;
}

/** Returns the active (first) signing secret as a Uint8Array. */
function getSecret(signing?: SigningConfig | null): Uint8Array {
  return new TextEncoder().encode(requireSecrets(signing)[0]);
}

/** Returns all secrets (active + rotated) as Uint8Arrays for HMAC verification. */
function getAllSecrets(signing?: SigningConfig | null): Uint8Array[] {
  return requireSecrets(signing).map(s => new TextEncoder().encode(s));
}

function getAlgorithm(config?: AuthResolvedConfig): 'HS256' | 'HS384' | 'HS512' | 'RS256' {
  if (config?.jwt?.algorithm) return config.jwt.algorithm;
  // Default to RS256 when OIDC is configured (asymmetric keys available), HS256 otherwise.
  // RS256 is safer for multi-service architectures because verification keys cannot forge tokens.
  return config?.oidc?.signingKey ? 'RS256' : 'HS256';
}

/**
 * Validates that the configured JWT signing secret is present and long enough.
 * Called once during plugin startup — throws immediately so misconfigured deployments
 * fail at boot rather than at the first login attempt.
 *
 * No-op when `config.jwt.algorithm` is `"RS256"` (RSA key validation happens
 * separately via `loadJwksKey()`).
 *
 * @param config - The resolved auth configuration.
 * @param signing - Optional signing config supplying the JWT secret.
 *
 * @throws {Error} When the secret is missing or shorter than 32 characters.
 *
 * @example
 * // Called automatically by createAuthPlugin — not normally needed by consumers.
 * validateJwtSecrets(resolvedConfig, signingConfig);
 */
export function validateJwtSecrets(
  config: AuthResolvedConfig,
  signing?: SigningConfig | null,
): void {
  if (getAlgorithm(config) !== 'RS256') {
    getSecret(signing);
  }
}

/**
 * JWT claims payload. `sub` (subject / user ID) is required; `sid` (session ID) and
 * `scope` (M2M scopes) are optional. Additional custom claims are supported via the
 * index signature — reserved JOSE claims (`exp`, `iat`, `iss`, `aud`, etc.) are
 * stripped by `createSessionForUser` before signing.
 */
export type TokenClaims = { sub: string; sid?: string; scope?: string; [key: string]: unknown };

/**
 * Signs a JWT with the configured algorithm and expiry.
 *
 * Every token includes `iat` (issued at), `nbf` (not before, set to `iat`), `exp`
 * (expiry), and `jti` (unique token ID for replay detection). Supports HMAC
 * algorithms (HS256/HS384/HS512) and RS256 (OIDC). For RS256, an OIDC key must be
 * loaded via `loadJwksKey()` before calling this function.
 *
 * @param claims - JWT payload. Must include `sub`. Additional claims are passed through.
 * @param expirySeconds - Token lifetime in seconds. Defaults to `"1h"` when `undefined`.
 * @param config - Resolved auth config supplying the algorithm and optional issuer/audience.
 * @param signing - Optional signing config supplying the secret. Required for HMAC algorithms.
 * @returns The signed JWT string.
 *
 * @throws {Error} When the signing secret is missing or too short.
 * @throws {Error} When `algorithm` is `"RS256"` but OIDC keys have not been loaded.
 *
 * @remarks
 * **RS256 key selection**: when `config.jwt.algorithm` is `"RS256"`, the `signing`
 * parameter is ignored entirely. The private key is read from the OIDC key store loaded
 * by `loadJwksKey()`. All entries in `signing.secret` (including rotated secrets) are
 * irrelevant for RS256 — only the RSA private key matters. The signed token uses
 * `kid: "key-1"` in the protected header for JWKS resolution by relying parties.
 *
 * For HMAC algorithms (`HS256`, `HS384`, `HS512`), `signing.secret[0]` is used as the
 * signing secret. Rotated secrets (indices 1+) are only used for *verification*, never
 * for signing — all new tokens are always signed with the first secret.
 *
 * @example
 * const token = await signToken(
 *   { sub: 'user-123', sid: 'session-456' },
 *   900,
 *   resolvedConfig,
 *   signingConfig,
 * );
 */
export async function signToken(
  claims: TokenClaims,
  expirySeconds: number | undefined,
  config: AuthResolvedConfig,
  signing?: SigningConfig | null,
): Promise<string> {
  const expiry = expirySeconds;
  const algorithm = getAlgorithm(config);

  if (algorithm === 'RS256') {
    if (!isJwksLoaded(config)) {
      throw new Error('RS256 requires OIDC key configuration — call loadJwksKey() first');
    }
    const privateKey = await getSigningPrivateKey(config);
    const jwt = new SignJWT(claims)
      .setProtectedHeader({ alg: 'RS256', kid: 'key-1' })
      .setIssuedAt()
      .setNotBefore('0s')
      .setJti(crypto.randomUUID())
      .setExpirationTime(expiry ? `${expiry}s` : '1h');
    const { issuer: rs256Issuer, audience: rs256Audience } = config.jwt ?? {};
    if (rs256Issuer) jwt.setIssuer(rs256Issuer);
    if (rs256Audience) jwt.setAudience(rs256Audience);
    return jwt.sign(privateKey);
  }

  const jwt = new SignJWT(claims)
    .setProtectedHeader({ alg: algorithm })
    .setIssuedAt()
    .setNotBefore('0s')
    .setJti(crypto.randomUUID())
    .setExpirationTime(expiry ? `${expiry}s` : '1h');

  const { issuer, audience } = config.jwt ?? {};
  if (issuer) jwt.setIssuer(issuer);
  if (audience) jwt.setAudience(audience);

  return jwt.sign(getSecret(signing));
}

/**
 * Verifies a JWT and returns its decoded payload.
 *
 * Validates the signature, expiry, issuer, and audience (when configured). For RS256,
 * all loaded public keys are tried in order — supports key rotation with zero downtime.
 *
 * @param token - The raw JWT string to verify.
 * @param config - Resolved auth config supplying algorithm, issuer, and audience.
 * @param signing - Optional signing config supplying the HMAC secret.
 * @returns The decoded `JWTPayload` on success.
 *
 * @throws {Error} When the token is expired, tampered, or fails signature verification.
 * @throws {Error} When `algorithm` is `"RS256"` and no loaded key can verify the token.
 *
 * @remarks
 * **Clock tolerance**: verification allows a configurable clock skew window
 * (`config.jwt.clockTolerance`, default 60 seconds) so that minor clock drift
 * between services does not reject valid tokens. Set to `0` to disable.
 *
 * **RS256 key rotation**: when `config.jwt.algorithm` is `"RS256"`, this function
 * iterates over all public keys loaded by `loadJwksKey()` in order and tries each one.
 * The first key that produces a valid signature wins. Keys that fail are silently skipped
 * (`continue`). This allows zero-downtime key rotation: add the new key to the JWKS
 * endpoint, wait for tokens signed with the old key to expire naturally, then remove the
 * old key. Tokens signed with either key will verify successfully during the overlap window.
 *
 * If no loaded key validates the token, the function throws
 * `"JWT verification failed with all available keys"`.
 *
 * **HMAC key rotation**: when `signing.secret` is an array, all secrets are tried in
 * order during verification. `signing.secret[0]` is the active signing key; indices 1+
 * are previous keys kept for verification during rotation windows. Deploy a new secret
 * at index 0 and move the old secret to index 1 — existing tokens will continue to
 * verify until they expire naturally.
 *
 * @example
 * const payload = await verifyToken(cookieToken, resolvedConfig, signingConfig);
 * const userId = payload.sub; // string
 * const sessionId = payload.sid as string | undefined;
 */
export const verifyToken = async (
  token: string,
  config: AuthResolvedConfig,
  signing?: SigningConfig | null,
): Promise<JWTPayload> => {
  const algorithm = getAlgorithm(config);
  const clockTolerance = config.jwt?.clockTolerance ?? 60;

  if (algorithm === 'RS256') {
    if (!isJwksLoaded(config)) {
      throw new Error('RS256 requires OIDC key configuration');
    }
    const publicKeys = await getVerifyPublicKeys(config);
    const opts: Parameters<typeof jwtVerify>[2] = { algorithms: ['RS256'], clockTolerance };
    const { issuer: rs256VerifyIssuer, audience: rs256VerifyAudience } = config.jwt ?? {};
    if (rs256VerifyIssuer) opts.issuer = rs256VerifyIssuer;
    if (rs256VerifyAudience) opts.audience = rs256VerifyAudience;

    for (const key of publicKeys) {
      try {
        const { payload } = await jwtVerify(token, key, opts);
        return payload;
      } catch {
        continue;
      }
    }
    throw new Error('JWT verification failed with all available keys');
  }

  const { issuer: verifyIssuer, audience: verifyAudience } = config.jwt ?? {};
  const opts: Parameters<typeof jwtVerify>[2] = { algorithms: [algorithm], clockTolerance };
  if (verifyIssuer) opts.issuer = verifyIssuer;
  if (verifyAudience) opts.audience = verifyAudience;

  // Try all configured HMAC secrets in order to support key rotation.
  // The first secret (index 0) is the active signing key; indices 1+ are
  // previous keys kept for verification during rotation windows.
  const secrets = getAllSecrets(signing);
  for (const secret of secrets) {
    try {
      const { payload } = await jwtVerify(token, secret, opts);
      return payload;
    } catch (err) {
      if (secrets.length === 1) throw err; // single secret — propagate the original error
      continue;
    }
  }
  throw new Error('JWT verification failed with all configured secrets');
};
