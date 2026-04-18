import { type JWK, exportJWK, generateKeyPair, importPKCS8, importSPKI } from 'jose';
import type { AuthResolvedConfig, OidcConfig } from '@lastshotlabs/slingshot-auth';

/**
 * RS256 key pair for OIDC token signing.
 *
 * Both `privateKey` and `publicKey` are PEM-encoded strings. Obtain them
 * via `generateAndLoadKeyPair` or by loading them from secure secret storage.
 */
export interface JwksKeyConfig {
  /** PEM-encoded PKCS#8 private key used to sign ID tokens. */
  privateKey: string;
  /** PEM-encoded SPKI public key published in the JWKS endpoint. */
  publicKey: string;
  /** Key ID to embed in the `kid` header of issued JWTs. Defaults to `"key-1"`. */
  kid?: string;
}

/**
 * Runtime key material for RS256 OIDC operations. Holds the Web Crypto API `CryptoKey`
 * object — either a private signing key or a public verification key depending on context.
 *
 * @remarks
 * Private keys are `CryptoKey` instances imported via `importPKCS8` with algorithm
 * `{ name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }` and `['sign']` usage.
 * Public keys are imported via `importSPKI` with the same algorithm and `['verify']` usage.
 * Both are `extractable: false` unless `generateKeyPair` is used for key generation,
 * in which case they are `extractable: true` to allow PEM export.
 */
type KeyMaterial = CryptoKey;
/**
 * A JSON Web Key guaranteed to contain the required `kty` field.
 * Used as the element type of the JWKS `keys` array.
 *
 * @remarks
 * Guaranteed fields (always present after export by this module):
 * - `kid` — key ID string, set from `JwksKeyConfig.kid` or auto-generated.
 * - `kty` — key type (always `"RSA"` for RS256 keys).
 * - `alg` — algorithm (always `"RS256"`).
 * - `use` — public key use (always `"sig"`).
 *
 * Optional fields present for RSA keys (populated by `jose`'s `exportJWK`):
 * - `n` — RSA modulus (Base64url-encoded).
 * - `e` — RSA public exponent (Base64url-encoded).
 *
 * For EC keys (not currently used by this module) `x` and `y` would be present instead.
 */
export type PublicJwk = JWK & { kty: string };

/**
 * Internal representation of a loaded RS256 key pair, combining the raw `CryptoKey`
 * instances with the exported `PublicJwk` and the `kid` string for the JWKS response.
 *
 * `privateKey` is absent for previous/rotation-only keys that only need to support
 * token verification, not signing.
 */
interface LoadedKeyPair {
  /**
   * RS256 private `CryptoKey` for signing ID tokens.
   *
   * `undefined` for previous/rotation keys loaded via `loadPreviousKeys` — those
   * keys are public-only and exist solely to verify tokens issued before key rotation.
   * Only the primary key loaded via `loadPrimaryKey` carries a private key.
   */
  privateKey?: KeyMaterial;
  /** RS256 public `CryptoKey` for verifying token signatures. Always present. */
  publicKey: KeyMaterial;
  /** Exported `PublicJwk` with `kty`, `kid`, `alg: "RS256"`, and `use: "sig"` populated. */
  jwk: PublicJwk;
  /** Key ID string embedded in issued JWTs (`kid` header) and in the JWKS `kid` field. */
  kid: string;
}

/**
 * Asserts that a `JWK` value exported by `jose` has the required `kty` field,
 * and returns it cast to `PublicJwk`.
 *
 * @param jwk - The raw `JWK` value from `jose`'s `exportJWK`.
 * @param context - Human-readable context string included in the thrown error message
 *   (e.g. `"Primary signing key"` or `"Previous signing key key-prev-1"`).
 * @returns The same object reference narrowed to `PublicJwk`.
 * @throws {Error} If `jwk.kty` is missing or falsy. This should never occur in
 *   practice when using `jose`'s `exportJWK` with a valid `CryptoKey`, but the guard
 *   exists because the `JWK` type from `jose` makes `kty` optional.
 *
 * @remarks
 * This function does not throw when `privateKey` is null/undefined on a `LoadedKeyPair`.
 * It only validates the exported public JWK shape. The check is intentionally minimal —
 * any valid RSA or EC key exported by `jose` will always carry `kty`.
 */
function requirePublicJwk(jwk: JWK, context: string): PublicJwk {
  if (!jwk.kty) {
    throw new Error(`[slingshot-oidc] ${context} produced a JWK without kty`);
  }
  return jwk as PublicJwk;
}

/**
 * Imports the primary RS256 key pair from a `JwksKeyConfig` and exports the public key
 * as a `PublicJwk` ready for inclusion in the JWKS endpoint response.
 *
 * @param config - PEM key pair config. Returns `null` if `config` is `undefined`.
 * @returns A `LoadedKeyPair` with both private and public keys, or `null` if not configured.
 * @throws {Error} If the PEM strings cannot be imported by `jose`.
 *
 * @remarks
 * Both `privateKey` and `publicKey` must be in standard PEM format:
 * - `privateKey` — PKCS#8 (`-----BEGIN PRIVATE KEY-----`). RSA keys generated with
 *   `openssl genpkey -algorithm RSA` or `jose`'s `generateKeyPair` are in this format.
 *   PKCS#1 (`-----BEGIN RSA PRIVATE KEY-----`) is NOT accepted by `importPKCS8`.
 * - `publicKey` — SPKI (`-----BEGIN PUBLIC KEY-----`). Exported via `openssl rsa -pubout`
 *   or `jose`'s `exportSPKI`.
 *
 * The algorithm is fixed to `'RS256'` (RSASSA-PKCS1-v1_5 + SHA-256). ES256 and other
 * algorithms are not supported by this module.
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
 * Imports a list of previous RS256 public keys for the JWKS rotation window.
 *
 * Only public keys are imported — previous keys support token verification only,
 * not signing. Assigns auto-generated `kid` values (`key-prev-N`) when not specified.
 *
 * @param configs - Array of previous key PEM configs. Returns `[]` if absent or empty.
 * @returns An array of `LoadedKeyPair` objects (without `privateKey`).
 * @throws {Error} If any PEM string cannot be imported by `jose`.
 *
 * @remarks
 * When `kid` is not provided in a config entry, the auto-generated value is
 * `"key-prev-N"` where N is the 1-based index of the entry in the `configs` array
 * (e.g. first entry → `"key-prev-1"`, second → `"key-prev-2"`). To ensure stable
 * `kid` values across restarts, always supply explicit `kid` values in production.
 * All returned `LoadedKeyPair` objects have `privateKey: undefined` — they carry only
 * the public `CryptoKey` for verification.
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
 * Attaches a primary RS256 signing key pair to an `OidcConfig` object.
 *
 * Returns a new `OidcConfig` — the original is not mutated.
 *
 * @param oidc - The existing OIDC config to extend.
 * @param config - The PEM key pair to use for signing tokens.
 * @returns A new `OidcConfig` with `signingKey` set.
 *
 * @remarks This is an internal helper used by `slingshot-auth`'s bootstrap
 * process. It is not exported from the `@lastshotlabs/slingshot-oidc` package
 * entry point.
 *
 * @example
 * ```ts
 * const oidcConfig = loadJwksKey(baseOidcConfig, {
 *   privateKey: process.env.OIDC_PRIVATE_KEY!,
 *   publicKey: process.env.OIDC_PUBLIC_KEY!,
 *   kid: 'key-2025',
 * });
 * ```
 */
export function loadJwksKey(oidc: OidcConfig, config: JwksKeyConfig): OidcConfig {
  return { ...oidc, signingKey: config };
}

/**
 * Appends a previous RS256 public key to the `OidcConfig` so that tokens
 * signed with a rotated-out key can still be verified during the rollover window.
 *
 * Only the **public** key is required — previous keys are used for verification
 * only, not for signing. Returns a new `OidcConfig` without mutating the original.
 *
 * @param oidc - The existing OIDC config to extend.
 * @param config - PEM-encoded SPKI public key (and optional `kid`) for a
 *   previously-active signing key.
 * @returns A new `OidcConfig` with the key appended to `previousKeys`.
 *
 * @remarks This is an internal helper used by `slingshot-auth`'s bootstrap
 * process. It is not exported from the `@lastshotlabs/slingshot-oidc` package
 * entry point.
 *
 * @example
 * ```ts
 * const oidcConfig = loadPreviousKey(currentConfig, {
 *   publicKey: process.env.OIDC_OLD_PUBLIC_KEY!,
 *   kid: 'key-2024',
 * });
 * ```
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
 * Generates a fresh RS256 2048-bit key pair and attaches it to the supplied
 * `OidcConfig` as the primary signing key.
 *
 * Intended for development and testing. In production, generate a key pair
 * offline and inject the PEM strings from secret storage using `loadJwksKey`.
 *
 * @param oidc - The OIDC config to extend with the new key pair.
 * @returns An object containing:
 *   - `oidc` — updated config with `signingKey` set to the new key pair
 *   - `privateKey` — PEM-encoded PKCS#8 private key (store securely!)
 *   - `publicKey` — PEM-encoded SPKI public key
 *
 * @remarks This is an internal helper used by `slingshot-auth`'s bootstrap
 * process. It is not exported from the `@lastshotlabs/slingshot-oidc` package
 * entry point.
 *
 * @example
 * ```ts
 * const { oidc, privateKey, publicKey } = await generateAndLoadKeyPair(baseOidc);
 * // Save privateKey / publicKey for reuse across restarts
 * ```
 */
export async function generateAndLoadKeyPair(
  oidc: OidcConfig,
): Promise<{ oidc: OidcConfig; privateKey: string; publicKey: string }> {
  const { privateKey: pk, publicKey: pubk } = await generateKeyPair('RS256', {
    modulusLength: 2048,
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
 * Loads and returns the RS256 private key from the resolved auth config.
 *
 * Used internally by the token-signing path. Call this when you need direct
 * access to the `CryptoKey` for custom signing operations.
 *
 * @param config - The resolved auth configuration containing `oidc.signingKey`.
 * @returns The `CryptoKey` for the primary RS256 private key.
 *
 * @throws {Error} If `config.oidc.signingKey` is not set — call `loadJwksKey`
 *   or `generateAndLoadKeyPair` first.
 *
 * @remarks
 * The `config` object is frozen at creation time (`Object.freeze`). Reading the
 * signing key is therefore thread-safe (in the sense that the config reference
 * will never be mutated by another concurrent call). However, `getSigningPrivateKey`
 * is async because it must re-import the PEM on each call via `jose`'s `importPKCS8`.
 * In hot paths, callers should cache the returned `CryptoKey` rather than calling
 * this function per-request.
 *
 * @example
 * ```ts
 * const privateKey = await getSigningPrivateKey(resolvedConfig);
 * // Use with jose's `new SignJWT(...).sign(privateKey)`
 * ```
 */
export async function getSigningPrivateKey(config?: AuthResolvedConfig): Promise<KeyMaterial> {
  const primary = await loadPrimaryKey(config?.oidc?.signingKey);
  if (!primary?.privateKey) {
    throw new Error('RS256 requires OIDC key configuration — call loadJwksKey() first');
  }
  return primary.privateKey;
}

/**
 * Loads and returns all RS256 public keys (primary + previous) as `CryptoKey`
 * instances for token verification.
 *
 * Returns keys in order: primary key first, then previous keys in the order
 * they appear in `config.oidc.previousKeys`. If no signing key is configured
 * the returned array is empty.
 *
 * @param config - The resolved auth configuration.
 * @returns An array of `CryptoKey` instances for verification. The primary key is
 *   always first; previous keys follow in the order they were registered via
 *   `loadPreviousKey` / `config.oidc.previousKeys`.
 *
 * @remarks
 * Callers should attempt verification with each key in order and stop on the first
 * success. The primary key is listed first because the vast majority of in-flight
 * tokens will have been signed with it. Previous keys are included to support the
 * rotation window — tokens issued before the last key rotation remain verifiable
 * until they expire.
 *
 * @example
 * ```ts
 * const keys = await getVerifyPublicKeys(resolvedConfig);
 * for (const key of keys) {
 *   try { await jwtVerify(token, key); break; } catch { /* try next *\/ }
 * }
 * ```
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
 * Builds the `{ keys: [...] }` payload for the `GET /.well-known/jwks.json`
 * endpoint.
 *
 * Exports the primary and all previous public keys as `PublicJwk` objects
 * (each includes `kty`, `kid`, `alg: "RS256"`, and `use: "sig"`).
 *
 * @param config - The resolved auth configuration.
 * @returns A JWKS object with a `keys` array. The array is empty if no signing
 *   key has been loaded.
 *
 * @remarks
 * When no signing key is configured (`config?.oidc?.signingKey` is absent), this
 * function returns `{ keys: [] }` rather than throwing. This allows the JWKS endpoint
 * to respond with a valid (empty) JSON body during early startup before keys are
 * injected, rather than returning a 500 error. Clients that cache an empty JWKS
 * response may fail to verify tokens, so callers should guard with `isJwksLoaded`
 * before serving the JWKS endpoint in production.
 *
 * @example
 * ```ts
 * const jwks = await getJwks(resolvedConfig);
 * // { keys: [{ kty: 'RSA', kid: 'key-1', alg: 'RS256', use: 'sig', n: '...', e: '...' }] }
 * ```
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
 * Returns `true` if the resolved auth config has a primary signing key loaded.
 *
 * Useful for startup health checks or guards that should fail fast when the
 * OIDC signing key has not been injected.
 *
 * @param config - The resolved auth configuration to inspect.
 * @returns `true` if `config.oidc.signingKey` is set, `false` otherwise.
 *
 * @remarks
 * "Loaded" means `config.oidc.signingKey` is a non-nullish `JwksKeyConfig` object —
 * i.e. at least one key pair (PEM strings) has been attached via `loadJwksKey` or
 * `generateAndLoadKeyPair`. This check does not validate that the PEM strings are
 * importable; it only inspects the presence of the config field. Use `getSigningPrivateKey`
 * or `getJwks` to surface import errors at startup.
 *
 * Previous keys registered via `loadPreviousKey` do not affect this check — a config
 * with only previous keys and no primary signing key returns `false`.
 *
 * @example
 * ```ts
 * if (!isJwksLoaded(resolvedConfig)) {
 *   throw new Error('OIDC signing key is not configured');
 * }
 * ```
 */
export function isJwksLoaded(config?: AuthResolvedConfig): boolean {
  return !!config?.oidc?.signingKey;
}
