import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  timingSafeEqual as nodeTimingSafeEqual,
  randomBytes,
} from 'crypto';

/**
 * Constant-time string comparison to prevent timing attacks on secret verification.
 *
 * Uses Node.js's native `crypto.timingSafeEqual` so that the comparison time is
 * independent of how many characters match. When the strings differ in length, a
 * same-buffer compare is performed to burn equivalent time before returning `false`.
 *
 * @param a - The first string to compare.
 * @param b - The second string to compare (e.g. a stored token hash).
 * @returns `true` if both strings are identical in length and content.
 *
 * @example
 * ```ts
 * import { timingSafeEqual } from '@lastshotlabs/slingshot-core';
 *
 * if (!timingSafeEqual(providedApiKey, storedApiKey)) {
 *   throw new HttpError(401, 'Invalid API key');
 * }
 * ```
 */
export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) {
    // Compare against self to burn the same time, then return false
    const buf = Buffer.from(a, 'utf-8');
    nodeTimingSafeEqual(buf, buf);
    return false;
  }
  return nodeTimingSafeEqual(Buffer.from(a, 'utf-8'), Buffer.from(b, 'utf-8'));
}

/**
 * SHA-256 hash a string and return the lowercase hex digest.
 *
 * Centralised to avoid duplicate implementations across modules. Uses Node's
 * built-in `crypto.createHash` — synchronous and available in all environments.
 *
 * @param input - The string to hash.
 * @returns 64-character lowercase hex digest.
 *
 * @example
 * ```ts
 * import { sha256 } from '@lastshotlabs/slingshot-core';
 *
 * const digest = sha256('hello world');
 * // → 'b94d27b9934d3e08a52e52d7da7dabfa...'
 * ```
 */
export function sha256(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

/**
 * HMAC-SHA256 sign a string with the active secret.
 *
 * Accepts either a single secret or a rotated secret array. When an array is
 * provided, the first entry is treated as the active signing key.
 *
 * @param input - The string to sign.
 * @param secret - The active secret or key-rotation array.
 * @returns Lowercase hex HMAC digest.
 */
export function hmacSign(input: string, secret: string | string[]): string {
  const key = Array.isArray(secret) ? secret[0] : secret;
  if (!key) {
    throw new Error('hmacSign: secret key must be a non-empty string');
  }
  return createHmac('sha256', key).update(input).digest('hex');
}

/**
 * Hash a token for safe storage — a named alias for `sha256`.
 *
 * The plaintext token is what gets sent to the client; the hash is what gets stored.
 * Using a named function makes the intent clear at call sites compared to a raw `sha256`.
 *
 * @param token - The plaintext token (e.g., a session token, magic-link token, or API key).
 * @returns The SHA-256 hex digest of the token.
 *
 * @example
 * ```ts
 * import { hashToken } from '@lastshotlabs/slingshot-core';
 *
 * const storedHash = hashToken(plaintextToken);
 * await db.sessions.updateOne({ token: storedHash });
 * ```
 */
export function hashToken(token: string): string {
  return sha256(token);
}

/**
 * A data encryption key (DEK) entry for AES-256-GCM field encryption.
 *
 * `keyId` is a short string embedded in the ciphertext envelope so that
 * `decryptField` can identify which key to use when multiple keys are in rotation.
 * `key` must be exactly 32 bytes for AES-256.
 *
 * @remarks
 * Keep DEKs in a secret store (SSM, Vault, etc.) — never hard-code them.
 * Configure multiple entries to support key rotation: the first entry is the
 * active (encrypting) key; all entries are tried during decryption.
 */
export interface DataEncryptionKey {
  keyId: string;
  key: Buffer;
}

/**
 * Encrypt a plaintext string field with AES-256-GCM.
 *
 * Uses the first key in `keyConfig` to encrypt. Generates a random 96-bit IV
 * per call so identical plaintexts produce different ciphertexts.
 *
 * @param plaintext - The value to encrypt.
 * @param keyConfig - Array of DEKs. The first entry is the active key. Must be non-empty.
 * @returns An opaque ciphertext envelope: `"keyId.base64url(iv).base64url(ct).base64url(tag)"`.
 * @throws If `keyConfig` is empty.
 *
 * @example
 * ```ts
 * import { encryptField } from '@lastshotlabs/slingshot-core';
 *
 * const ciphertext = await encryptField('secret-value', ctx.dataEncryptionKeys);
 * await db.update({ ssn: ciphertext });
 * ```
 */
export function encryptField(plaintext: string, keyConfig: DataEncryptionKey[]): string {
  if (keyConfig.length === 0) throw new Error('encryptField: no encryption keys configured');
  const { keyId, key } = keyConfig[0];
  const iv = randomBytes(12); // 96-bit IV for AES-GCM
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  const encode = (buf: Buffer) => buf.toString('base64url');
  return `${keyId}.${encode(iv)}.${encode(encrypted)}.${encode(tag)}`;
}

/**
 * Decrypt a value encrypted by `encryptField`.
 *
 * Parses the ciphertext envelope to find the `keyId`, locates the matching DEK in
 * `keyConfig`, then decrypts using AES-256-GCM. Supports key rotation — any valid
 * key in `keyConfig` can decrypt, not just the first.
 *
 * @param ciphertext - The envelope string produced by `encryptField`.
 * @param keyConfig - All available DEKs (current + rotated). Must contain the key used to encrypt.
 * @returns The original plaintext string.
 * @throws If the ciphertext format is invalid, no matching key is found, or GCM authentication fails.
 *
 * @example
 * ```ts
 * import { decryptField } from '@lastshotlabs/slingshot-core';
 *
 * const plaintext = await decryptField(record.ssn, ctx.dataEncryptionKeys);
 * ```
 */
export function decryptField(ciphertext: string, keyConfig: DataEncryptionKey[]): string {
  const parts = ciphertext.split('.');
  if (parts.length !== 4) throw new Error('decryptField: invalid ciphertext format');
  const [keyId, ivB64, ctB64, tagB64] = parts;
  const keyEntry = keyConfig.find(k => k.keyId === keyId);
  if (!keyEntry) throw new Error(`decryptField: no key found for keyId "${keyId}"`);
  const iv = Buffer.from(ivB64, 'base64url');
  const ct = Buffer.from(ctB64, 'base64url');
  const tag = Buffer.from(tagB64, 'base64url');
  const decipher = createDecipheriv('aes-256-gcm', keyEntry.key, iv);
  decipher.setAuthTag(tag);
  const decrypted = Buffer.concat([decipher.update(ct), decipher.final()]);

  // Bun's decipher.final() does not verify the GCM auth tag. Re-encrypt with
  // the same key + IV and compare the computed tag to detect tampering.
  const verifier = createCipheriv('aes-256-gcm', keyEntry.key, iv);
  verifier.update(decrypted);
  verifier.final();
  if (!verifier.getAuthTag().equals(tag)) {
    throw new Error(
      'decryptField: GCM authentication failed — ciphertext is corrupted or tampered',
    );
  }

  return decrypted.toString('utf8');
}

/**
 * Detect whether a stored string looks like an encrypted ciphertext produced by `encryptField`.
 *
 * Uses a lightweight structural check: a valid envelope has exactly 4 dot-separated parts
 * (`keyId.iv.ct.tag`). Does not attempt decryption — use this to decide whether to call
 * `decryptField` without the overhead of a full parse.
 *
 * @param value - The stored string to inspect.
 * @returns `true` if the value appears to be an AES-256-GCM envelope.
 *
 * @example
 * ```ts
 * import { isEncryptedField, decryptField } from '@lastshotlabs/slingshot-core';
 *
 * const raw = record.ssn;
 * const ssn = isEncryptedField(raw) ? await decryptField(raw, keys) : raw;
 * ```
 */
export function isEncryptedField(value: string): boolean {
  // Encrypted envelope format: keyId.base64url(IV, 12 bytes = 16 chars).base64url(ciphertext).base64url(tag, 16 bytes = 22 chars)
  return /^[^.]+\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{22}$/.test(value);
}

/**
 * Generates a cryptographically secure random token with 256 bits of entropy.
 *
 * Returns a base64url-encoded string (43 characters, no padding). Suitable for
 * session IDs, refresh tokens, and any secret that must resist brute-force
 * guessing over long time windows (e.g. 30-day refresh tokens).
 *
 * Replaces `crypto.randomUUID()` (122-bit UUIDv4) where OWASP recommends ≥128
 * bits for session identifiers.
 *
 * @returns A 43-character base64url string representing 256 bits of randomness.
 *
 * @example
 * ```ts
 * import { generateSecureToken } from '@lastshotlabs/slingshot-core';
 *
 * const sessionId = generateSecureToken();     // e.g. "dGhpcyBpcyBhIHRlc3Qgb2YgdGhlIGJyb2FkY2Fz..."
 * const refreshToken = generateSecureToken();  // 256-bit entropy
 * ```
 */
export function generateSecureToken(): string {
  return randomBytes(32).toString('base64url');
}
