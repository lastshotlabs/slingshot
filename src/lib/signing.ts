import { createHmac } from 'crypto';
import { timingSafeEqual } from '@lastshotlabs/slingshot-core';

// ---------------------------------------------------------------------------
// Core HMAC primitives
// ---------------------------------------------------------------------------

/**
 * Sign `data` with the active key (first element of `secret`).
 * Normalizes string | string[] so that an array is never passed directly to
 * createHmac() — which would silently call .toString() and produce
 * "[object Array]" as the key.
 */
export function hmacSign(data: string, secret: string | string[]): string {
  const key = Array.isArray(secret) ? secret[0] : secret;
  if (!key) {
    throw new Error('hmacSign: secret key must be a non-empty string');
  }
  return createHmac('sha256', key).update(data).digest('hex');
}

/**
 * Verify `sig` against `data` using one of the provided keys.
 * Keys are tried newest-first (index 0 is the active signing key).
 *
 * Key ordering convention: put the current (newest) key first; rotated keys
 * after. The common case (valid current-key signature) succeeds on the first
 * comparison; old rotated keys only matter for in-flight tokens.
 *
 * MUST use timingSafeEqual — never === — to prevent timing side-channel leaks.
 * This is the most common HMAC implementation mistake.
 */
export function hmacVerify(data: string, sig: string, secret: string | string[]): boolean {
  const keys = Array.isArray(secret) ? secret : [secret];
  if (keys.length === 0) return false;
  for (const key of keys) {
    if (!key) continue;
    const expected = createHmac('sha256', key).update(data).digest('hex');
    try {
      if (timingSafeEqual(expected, sig)) return true;
    } catch {
      // timingSafeEqual (src/lib/crypto.ts) handles length mismatches itself:
      // it returns false rather than throwing, so this catch block is never
      // reached under normal conditions. It is kept as a defensive no-op in
      // case the underlying implementation changes in the future.
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Cookie signing
//
// Value is base64url-encoded before appending ".sig" to avoid delimiter
// collision — raw values may contain "." which would break naive
// split-on-last-dot parsing.
//
// Edge case: base64url("") === "" so the signed form for an empty value is
// ".sig". Split uses lastIndexOf("."), not indexOf("."), and dotIdx === 0
// is treated as a valid (empty) value, not a parse error.
// ---------------------------------------------------------------------------

function toBase64url(s: string): string {
  return Buffer.from(s).toString('base64url');
}

function fromBase64url(s: string): string {
  return Buffer.from(s, 'base64url').toString('utf8');
}

/** Returns `"base64url(value).hmac"`. */
export function signCookieValue(value: string, secret: string | string[]): string {
  const encoded = toBase64url(value);
  const sig = hmacSign(encoded, secret);
  return `${encoded}.${sig}`;
}

/** Returns the original value or `null` if the signature is invalid. */
export function verifyCookieValue(signed: string, secret: string | string[]): string | null {
  const dotIdx = signed.lastIndexOf('.');
  // dotIdx === 0 is valid: empty encoded value (signed form ".sig")
  if (dotIdx < 0) return null;
  const encoded = signed.slice(0, dotIdx);
  const sig = signed.slice(dotIdx + 1);
  if (!hmacVerify(encoded, sig, secret)) return null;
  try {
    return fromBase64url(encoded);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Cursor signing (same structure as cookie signing)
// ---------------------------------------------------------------------------

/** Returns `"base64url(payload).hmac"`. */
export function signCursor(payload: string, secret: string | string[]): string {
  const encoded = toBase64url(payload);
  const sig = hmacSign(encoded, secret);
  return `${encoded}.${sig}`;
}

/** Returns the original payload or `null` if the signature is invalid. */
export function verifyCursor(cursor: string, secret: string | string[]): string | null {
  const dotIdx = cursor.lastIndexOf('.');
  if (dotIdx < 0) return null;
  const encoded = cursor.slice(0, dotIdx);
  const sig = cursor.slice(dotIdx + 1);
  if (!hmacVerify(encoded, sig, secret)) return null;
  try {
    return fromBase64url(encoded);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Presigned URLs
//
// Signing data = method + "\n" + key + "\n" + exp + "\n" + sortedParams
// Newline delimiter is safe: keys like "uploads/2024/photo.jpg" contain dots
// but cannot contain newlines; method and exp never contain newlines.
// Using "." would create ambiguity with keys containing dots.
//
// Extra params are included in the HMAC so that an attacker cannot modify,
// add, or remove query parameters without invalidating the signature.
// sortedParams is always present (empty string when no extra params) so the
// "\n" delimiter is consistent — prevents length-extension confusion.
// ---------------------------------------------------------------------------

/**
 * Serialize extra params for inclusion in the HMAC signing string.
 * Keys are sorted, then each key and value are percent-encoded (encodeURIComponent)
 * and joined as "key=value&key2=value2". Returns "" when params is empty/undefined.
 */
function serializeExtraParams(params?: Record<string, string>): string {
  if (!params || Object.keys(params).length === 0) return '';
  return Object.keys(params)
    .sort()
    .map(k => `${encodeURIComponent(k)}=${encodeURIComponent(params[k])}`)
    .join('&');
}

/**
 * Create a stateless HMAC-signed URL. The signature covers the HTTP method,
 * storage key, expiry timestamp, and any extra query params so that:
 *  - Expired URLs are rejected (replay prevention)
 *  - URLs are method-bound (a GET URL can't be replayed as a PUT)
 *  - Tampering with the key, expiry, or any extra param invalidates the signature
 *
 * @param base   Base URL string (e.g. "https://api.example.com/uploads/presign")
 * @param key    Storage object key
 * @param opts   Method, expiry in seconds from now, optional extra query params
 * @param secret HMAC secret (supports key rotation via string[])
 */
export function createPresignedUrl(
  base: string,
  key: string,
  opts: { method: string; expiry: number; extra?: Record<string, string> },
  secret: string | string[],
): string {
  const exp = Math.floor(Date.now() / 1000) + opts.expiry;
  const method = opts.method.toUpperCase();
  const sortedParams = serializeExtraParams(opts.extra);
  const data = `${method}\n${key}\n${exp}\n${sortedParams}`;
  const sig = hmacSign(data, secret);

  const url = new URL(base);
  url.searchParams.set('key', key);
  url.searchParams.set('exp', String(exp));
  url.searchParams.set('method', method);
  url.searchParams.set('sig', sig);
  if (opts.extra) {
    for (const [k, v] of Object.entries(opts.extra)) {
      url.searchParams.set(k, v);
    }
  }
  return url.toString();
}

/**
 * Verify an HMAC-signed URL. Returns the key and any extra params, or null
 * if the URL is expired, tampered, or method-mismatched.
 */
export function verifyPresignedUrl(
  url: string,
  method: string,
  secret: string | string[],
): { key: string; extra?: Record<string, string> } | null {
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(url);
  } catch {
    return null;
  }

  const key = parsedUrl.searchParams.get('key');
  const exp = parsedUrl.searchParams.get('exp');
  const sig = parsedUrl.searchParams.get('sig');
  const urlMethod = parsedUrl.searchParams.get('method');
  if (!key || !exp || !sig || !urlMethod) return null;

  // Method binding check
  if (urlMethod !== method.toUpperCase()) return null;

  // Expiry check
  const expNum = parseInt(exp, 10);
  if (!isFinite(expNum) || expNum < Math.floor(Date.now() / 1000)) return null;

  // Collect extra params (all except reserved ones)
  const reserved = new Set(['key', 'exp', 'sig', 'method']);
  const extra: Record<string, string> = {};
  for (const [k, v] of parsedUrl.searchParams.entries()) {
    if (!reserved.has(k)) extra[k] = v;
  }

  // Signature check — includes extra params so tampering is detected
  const sortedParams = serializeExtraParams(Object.keys(extra).length > 0 ? extra : undefined);
  const data = `${urlMethod}\n${key}\n${exp}\n${sortedParams}`;
  if (!hmacVerify(data, sig, secret)) return null;

  return Object.keys(extra).length > 0 ? { key, extra } : { key };
}
