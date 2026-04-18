import { type JWK, exportJWK, generateKeyPair, importPKCS8, importSPKI } from 'jose';
import type { AuthResolvedConfig, OidcConfig } from '../config/authConfig';

export interface JwksKeyConfig {
  privateKey: string;
  publicKey: string;
  kid?: string;
}

type KeyMaterial = CryptoKey;
export type PublicJwk = JWK & { kty: string };

interface LoadedKeyPair {
  privateKey?: KeyMaterial;
  publicKey: KeyMaterial;
  jwk: PublicJwk;
  kid: string;
}

/**
 * Asserts that a JWK exported by `jose` contains a `kty` field and narrows its type to
 * `PublicJwk`.
 *
 * @param jwk - The raw `JWK` object returned from `jose.exportJWK()`.
 * @param context - Human-readable label for the error message (e.g. `"Primary signing key"`).
 * @returns The same object narrowed to `PublicJwk`.
 * @throws {Error} If `jwk.kty` is absent — indicates a bug in the upstream key import.
 */
function requirePublicJwk(jwk: JWK, context: string): PublicJwk {
  if (!jwk.kty) {
    throw new Error(`[slingshot-auth] ${context} produced a JWK without kty`);
  }
  return jwk as PublicJwk;
}

/**
 * Imports the primary RS256 signing key pair from PEM strings.
 *
 * @param config - The primary key config containing `privateKey` (PKCS8 PEM),
 *   `publicKey` (SPKI PEM), and optional `kid`.  Returns `null` when `config` is
 *   `undefined` (OIDC not yet configured).
 * @returns A `LoadedKeyPair` containing the imported `CryptoKey` objects and the
 *   exported public JWK with `kid`, `alg: 'RS256'`, and `use: 'sig'` set.  Returns
 *   `null` if `config` is absent.
 * @throws {Error} If `importPKCS8` or `importSPKI` fails (malformed PEM, wrong
 *   algorithm, etc.).
 */
async function loadPrimaryKey(config: JwksKeyConfig | undefined): Promise<LoadedKeyPair | null> {
  if (!config) return null;
  const kid = config.kid ?? 'key-1';
  const privateKey = await importPKCS8(config.privateKey, 'RS256');
  const publicKey = await importSPKI(config.publicKey, 'RS256');
  const jwk = requirePublicJwk(await exportJWK(publicKey), 'Primary signing key');
  return { privateKey, publicKey, jwk: { ...jwk, kid, alg: 'RS256', use: 'sig' }, kid };
}

/**
 * Imports a list of previous (rotated-out) RS256 public keys for JWT verification.
 *
 * Previous keys are public-only — they are used to verify tokens signed before the
 * most recent key rotation, not to sign new tokens.
 *
 * @param configs - Array of previous key configs, each with a `publicKey` (SPKI PEM)
 *   and optional `kid`.  Kids default to `"key-prev-1"`, `"key-prev-2"`, etc.  Returns
 *   an empty array when `configs` is `undefined` or empty.
 * @returns An array of `LoadedKeyPair` objects containing the imported `CryptoKey` and
 *   exported public JWK for each previous key.
 * @throws {Error} If any `importSPKI` call fails (malformed PEM, wrong algorithm, etc.).
 */
async function loadPreviousKeys(
  configs: Array<{ publicKey: string; kid?: string }> | undefined,
): Promise<LoadedKeyPair[]> {
  if (!configs?.length) return [];
  return Promise.all(
    configs.map(async (config, index) => {
      const kid = config.kid ?? `key-prev-${index + 1}`;
      const publicKey = await importSPKI(config.publicKey, 'RS256');
      const jwk = requirePublicJwk(await exportJWK(publicKey), `Previous signing key ${kid}`);
      return { publicKey, jwk: { ...jwk, kid, alg: 'RS256', use: 'sig' }, kid };
    }),
  );
}

/**
 * Returns a new `OidcConfig` with the primary signing key set.
 *
 * Pure function — does not mutate the input.  Used during OIDC bootstrap to attach a
 * pre-existing PEM key pair (e.g. from an environment variable or a secret store) to the
 * OIDC config before it is frozen.
 *
 * @param oidc - The current (unfrozen) OIDC config to extend.
 * @param config - Key config with `privateKey` (PKCS8 PEM), `publicKey` (SPKI PEM), and
 *   optional `kid`.
 * @returns A new `OidcConfig` with `signingKey` set to `config`.
 *
 * @example
 * const updatedOidc = loadJwksKey(oidcConfig, {
 *   privateKey: process.env.OIDC_PRIVATE_KEY!,
 *   publicKey:  process.env.OIDC_PUBLIC_KEY!,
 *   kid: 'key-2024',
 * });
 */
export function loadJwksKey(oidc: OidcConfig, config: JwksKeyConfig): OidcConfig {
  return { ...oidc, signingKey: config };
}

/**
 * Returns a new `OidcConfig` with one additional previous (verification-only) public key
 * appended.
 *
 * Pure function — does not mutate the input.  Call once per previous key during OIDC
 * bootstrap to allow tokens signed with old key pairs to remain verifiable after a key
 * rotation.
 *
 * @param oidc - The current (unfrozen) OIDC config to extend.
 * @param config - Previous key config with `publicKey` (SPKI PEM) and optional `kid`.
 * @returns A new `OidcConfig` with the key appended to `previousKeys`.
 *
 * @example
 * let oidcConfig = loadJwksKey(base, newKeyConfig);
 * oidcConfig = loadPreviousKey(oidcConfig, { publicKey: oldPublicKeyPem, kid: 'key-2023' });
 */
export function loadPreviousKey(
  oidc: OidcConfig,
  config: { publicKey: string; kid?: string },
): OidcConfig {
  return {
    ...oidc,
    previousKeys: [...(oidc.previousKeys ?? []), config],
  };
}

/**
 * Generates a fresh RS256 4096-bit key pair and loads it into the OIDC config.
 *
 * Intended for development and ephemeral environments where no persistent key is
 * configured.  In production, pre-generate a key pair, store the PEMs in a secret
 * manager, and supply them via `loadJwksKey()` instead.
 *
 * @param oidc - The current (unfrozen) OIDC config to extend with the generated key.
 * @returns An object containing:
 *   - `oidc` — Updated `OidcConfig` with the generated key set as the primary signing key.
 *   - `privateKey` — PKCS8 PEM string for the private key (log/store if persistence is needed).
 *   - `publicKey`  — SPKI PEM string for the public key.
 * @throws {Error} If key generation fails (crypto API unavailable in the runtime).
 *
 * @example
 * const { oidc: updatedOidc } = await generateAndLoadKeyPair(oidcConfig);
 * resolvedConfig = { ...resolvedConfig, oidc: updatedOidc };
 */
export async function generateAndLoadKeyPair(
  oidc: OidcConfig,
): Promise<{ oidc: OidcConfig; privateKey: string; publicKey: string }> {
  const { privateKey: pk, publicKey: pubk } = await generateKeyPair('RS256', {
    modulusLength: 4096,
    extractable: true,
  });
  const { exportSPKI, exportPKCS8 } = await import('jose');
  const privatePem = await exportPKCS8(pk);
  const publicPem = await exportSPKI(pubk);
  return {
    oidc: loadJwksKey(oidc, { privateKey: privatePem, publicKey: publicPem, kid: 'key-1' }),
    privateKey: privatePem,
    publicKey: publicPem,
  };
}

/**
 * Imports and returns the primary RS256 private signing key from the resolved config.
 *
 * Used by the OIDC/JWT signing path to sign ID tokens and access tokens.
 *
 * @param config - The resolved auth config.  `config.oidc.signingKey` must be set.
 * @returns The imported `CryptoKey` for the RS256 private signing key.
 * @throws {Error} If `config.oidc.signingKey` is absent — i.e. `loadJwksKey()` or
 *   `generateAndLoadKeyPair()` was not called before bootstrap completed.
 *
 * @example
 * const privateKey = await getSigningPrivateKey(resolvedConfig);
 * const jwt = await new SignJWT(payload).setProtectedHeader({ alg: 'RS256' }).sign(privateKey);
 */
export async function getSigningPrivateKey(config?: AuthResolvedConfig): Promise<KeyMaterial> {
  const primary = await loadPrimaryKey(config?.oidc?.signingKey);
  if (!primary?.privateKey) {
    throw new Error('RS256 requires OIDC key configuration — call loadJwksKey() first');
  }
  return primary.privateKey;
}

/**
 * Imports and returns all RS256 public keys available for JWT verification.
 *
 * Includes the current primary key (if configured) followed by all previous keys in
 * the order they were added via `loadPreviousKey()`.  Used by the OIDC token-verify
 * path to validate tokens signed with any key in the rotation window.
 *
 * @param config - The resolved auth config.  Both `config.oidc.signingKey` and
 *   `config.oidc.previousKeys` are consulted.
 * @returns An ordered array of `CryptoKey` objects for JWT verification.  Empty if
 *   no OIDC keys are configured.
 *
 * @example
 * const publicKeys = await getVerifyPublicKeys(resolvedConfig);
 * // Try each key until one succeeds:
 * for (const key of publicKeys) {
 *   try { return await jwtVerify(token, key); } catch { /* try next *\/ }
 * }
 */
export async function getVerifyPublicKeys(config?: AuthResolvedConfig): Promise<KeyMaterial[]> {
  const oidc = config?.oidc;
  const primary = await loadPrimaryKey(oidc?.signingKey);
  const previous = await loadPreviousKeys(oidc?.previousKeys);
  const keys: KeyMaterial[] = [];
  if (primary) keys.push(primary.publicKey);
  keys.push(...previous.map(key => key.publicKey));
  return keys;
}

/**
 * Returns the JSON Web Key Set (JWKS) for the `/.well-known/jwks.json` endpoint.
 *
 * Includes the current primary public key (if configured) followed by any previous
 * public keys in rotation order.  All keys carry `alg: 'RS256'` and `use: 'sig'`.
 *
 * @param config - The resolved auth config.  Both `config.oidc.signingKey` and
 *   `config.oidc.previousKeys` are consulted.
 * @returns An object with a `keys` array of `PublicJwk` entries suitable for the
 *   JWKS endpoint response body.
 *
 * @example
 * app.get('/.well-known/jwks.json', async c => {
 *   const jwks = await getJwks(resolvedConfig);
 *   return c.json(jwks);
 * });
 */
export async function getJwks(config?: AuthResolvedConfig): Promise<{ keys: PublicJwk[] }> {
  const oidc = config?.oidc;
  const primary = await loadPrimaryKey(oidc?.signingKey);
  const previous = await loadPreviousKeys(oidc?.previousKeys);
  const keys: PublicJwk[] = [];
  if (primary) keys.push(primary.jwk);
  keys.push(...previous.map(key => key.jwk));
  return { keys };
}

/**
 * Returns `true` if a primary OIDC signing key has been loaded into the config.
 *
 * A quick guard used before attempting to sign tokens — avoids a misleading
 * "RS256 requires OIDC key configuration" runtime error by allowing callers to
 * check readiness eagerly (e.g. for health checks or boot assertions).
 *
 * @param config - The resolved auth config to inspect.
 * @returns `true` when `config.oidc.signingKey` is set; `false` otherwise.
 *
 * @example
 * if (!isJwksLoaded(resolvedConfig)) {
 *   throw new Error('OIDC signing key not configured');
 * }
 */
export function isJwksLoaded(config?: AuthResolvedConfig): boolean {
  return !!config?.oidc?.signingKey;
}
