/**
 * Cryptographically secure random helpers.
 *
 * These helpers wrap the Web Crypto `getRandomValues()` API (available in
 * Node 18+, Bun, Deno, and modern browsers). They are safe for generating
 * credentials, tokens, secrets, and any value that must be unguessable by an
 * attacker.
 *
 * Do NOT use `Math.random()` for any of these purposes — it is not
 * cryptographically secure and its output is predictable from a small seed.
 */

/** URL-safe base64 alphabet (RFC 4648 §5). 64 characters, 6 bits each. */
const BASE64URL_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

/**
 * Generate a cryptographically secure random byte array.
 *
 * @param byteLength - Number of bytes to generate. Must be a positive integer.
 * @returns A `Uint8Array` of the requested length filled with secure random bytes.
 *
 * @throws {RangeError} If `byteLength` is not a positive integer.
 */
export function secureRandomBytes(byteLength: number): Uint8Array {
  if (!Number.isInteger(byteLength) || byteLength <= 0) {
    throw new RangeError(`byteLength must be a positive integer, got ${byteLength}`);
  }
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return bytes;
}

/**
 * Encode raw bytes as URL-safe base64 (no padding).
 *
 * @param bytes - Byte array to encode.
 * @returns Base64url-encoded string. Length is `ceil(bytes.length * 4 / 3)`.
 */
export function bytesToBase64Url(bytes: Uint8Array): string {
  let result = '';
  let i = 0;
  // Process full 3-byte groups → 4 base64 chars.
  for (; i + 3 <= bytes.length; i += 3) {
    const b0 = bytes[i] as number;
    const b1 = bytes[i + 1] as number;
    const b2 = bytes[i + 2] as number;
    result += BASE64URL_ALPHABET[b0 >> 2];
    result += BASE64URL_ALPHABET[((b0 & 0x03) << 4) | (b1 >> 4)];
    result += BASE64URL_ALPHABET[((b1 & 0x0f) << 2) | (b2 >> 6)];
    result += BASE64URL_ALPHABET[b2 & 0x3f];
  }
  // Handle 1- or 2-byte tail without padding.
  const remaining = bytes.length - i;
  if (remaining === 1) {
    const b0 = bytes[i] as number;
    result += BASE64URL_ALPHABET[b0 >> 2];
    result += BASE64URL_ALPHABET[(b0 & 0x03) << 4];
  } else if (remaining === 2) {
    const b0 = bytes[i] as number;
    const b1 = bytes[i + 1] as number;
    result += BASE64URL_ALPHABET[b0 >> 2];
    result += BASE64URL_ALPHABET[((b0 & 0x03) << 4) | (b1 >> 4)];
    result += BASE64URL_ALPHABET[(b1 & 0x0f) << 2];
  }
  return result;
}

/**
 * Generate a cryptographically secure password as a URL-safe base64 string.
 *
 * Uses `crypto.getRandomValues()` under the hood. The output uses the
 * base64url alphabet (`A-Z`, `a-z`, `0-9`, `-`, `_`), which is safe for use
 * in shell arguments, URLs, and JSON bodies without escaping.
 *
 * Entropy is `byteLength * 8` bits. For a typical credential, use at least
 * 16 bytes (128 bits of entropy → 22 base64url chars).
 *
 * @param byteLength - Number of random bytes to draw. Recommended: ≥ 16.
 * @returns A base64url-encoded password string.
 *
 * @example
 * generateSecurePassword(24); // → ~32-char string with 192 bits of entropy
 */
export function generateSecurePassword(byteLength: number): string {
  return bytesToBase64Url(secureRandomBytes(byteLength));
}

/**
 * Generate a cryptographically secure random string from a custom alphabet.
 *
 * Uses rejection sampling so each character in the output is uniformly
 * distributed over `alphabet`. Suitable for generating join codes, tokens,
 * or other identifiers from a restricted character set.
 *
 * @param length - Number of characters in the output string.
 * @param alphabet - Characters to draw from. Must be a non-empty string of
 *   ≤ 256 distinct characters.
 * @returns A string of `length` characters drawn uniformly from `alphabet`.
 *
 * @throws {RangeError} If `length` is not a non-negative integer.
 * @throws {RangeError} If `alphabet` is empty or has > 256 characters.
 */
export function secureRandomString(length: number, alphabet: string): string {
  if (!Number.isInteger(length) || length < 0) {
    throw new RangeError(`length must be a non-negative integer, got ${length}`);
  }
  if (alphabet.length === 0 || alphabet.length > 256) {
    throw new RangeError(
      `alphabet must have between 1 and 256 characters, got ${alphabet.length}`,
    );
  }
  if (length === 0) {
    return '';
  }
  // Rejection-sampling threshold: largest multiple of alphabet.length that
  // fits in a byte. Bytes ≥ this threshold are rejected and re-sampled to
  // avoid modulo bias.
  const max = 256 - (256 % alphabet.length);
  let result = '';
  // Over-sample by 25% to cut the typical number of refill rounds.
  const bufSize = Math.ceil(length * 1.25);
  while (result.length < length) {
    const buf = secureRandomBytes(bufSize);
    for (let i = 0; i < buf.length && result.length < length; i++) {
      const byte = buf[i] as number;
      if (byte < max) {
        result += alphabet[byte % alphabet.length];
      }
    }
  }
  return result;
}
