import { createHash } from 'node:crypto';

/**
 * Atlas Admin API base URL (v2).
 */
export const ATLAS_API_BASE = 'https://cloud.mongodb.com/api/atlas/v2.0';

/**
 * HTTP Digest authentication helper for MongoDB Atlas.
 *
 * Atlas uses RFC 7616 HTTP Digest authentication. The flow:
 * 1. Send unauthenticated request — get 401 with WWW-Authenticate: Digest header
 * 2. Parse nonce, realm, qop from header
 * 3. Compute HA1 = MD5(username:realm:password)
 *    Compute HA2 = MD5(method:uri)
 *    Compute response = MD5(HA1:nonce:nc:cnonce:qop:HA2)
 * 4. Retry with Authorization: Digest header
 */
export async function digestFetch(
  url: string,
  options: {
    method: string;
    body?: string;
    publicKey: string;
    privateKey: string;
    headers?: Record<string, string>;
  },
): Promise<Response> {
  const { method, body, publicKey, privateKey, headers = {} } = options;

  const baseHeaders: Record<string, string> = {
    Accept: 'application/vnd.atlas.2023-01-01+json',
    ...headers,
  };
  if (body !== undefined) {
    baseHeaders['Content-Type'] = 'application/json';
  }

  // First request — expect 401 to get the digest challenge
  const challengeRes = await globalThis.fetch(url, {
    method,
    body,
    headers: baseHeaders,
  });

  if (challengeRes.status !== 401) {
    return challengeRes;
  }

  const wwwAuth = challengeRes.headers.get('WWW-Authenticate') ?? '';
  const authHeader = buildDigestAuthHeader(wwwAuth, { url, method, publicKey, privateKey });

  // Second request with computed Authorization header
  return globalThis.fetch(url, {
    method,
    body,
    headers: {
      ...baseHeaders,
      Authorization: authHeader,
    },
  });
}

/**
 * Compute an RFC 7616 HTTP Digest `Authorization` header value from a
 * `WWW-Authenticate: Digest` challenge and the caller's credentials.
 *
 * @param wwwAuthenticate - The raw `WWW-Authenticate` header value from the
 *   401 challenge response (e.g.
 *   `'Digest realm="...", nonce="...", qop="auth"'`).
 * @param ctx - Credentials and request context needed to build the response.
 * @param ctx.url - The full request URL; only the path + query is used for the
 *   digest URI field.
 * @param ctx.method - HTTP method in upper-case (e.g. `'GET'`, `'POST'`).
 * @param ctx.publicKey - Atlas public key used as the digest username and in
 *   the HA1 calculation.
 * @param ctx.privateKey - Atlas private key used as the digest password in
 *   the HA1 calculation.
 * @returns A complete `Authorization` header value starting with `'Digest '`.
 *
 * @remarks
 * Implements RFC 7616 digest auth:
 * - `HA1 = MD5(publicKey:realm:privateKey)`
 * - `HA2 = MD5(method:uri)`
 * - When `qop` is `'auth'` or `'auth-int'`:
 *   `response = MD5(HA1:nonce:nc:cnonce:qop:HA2)`
 * - Otherwise (legacy):
 *   `response = MD5(HA1:nonce:HA2)`
 *
 * MD5 is mandated by the RFC for digest auth and is not a security choice —
 * the Atlas API requires this specific algorithm.
 */
function buildDigestAuthHeader(
  wwwAuthenticate: string,
  ctx: {
    url: string;
    method: string;
    publicKey: string;
    privateKey: string;
  },
): string {
  const realm = extractDirective(wwwAuthenticate, 'realm');
  const nonce = extractDirective(wwwAuthenticate, 'nonce');
  const qop = extractDirective(wwwAuthenticate, 'qop');
  const opaque = extractDirective(wwwAuthenticate, 'opaque');

  const nc = '00000001';
  const cnonce = createHash('md5').update(String(Date.now())).digest('hex').slice(0, 8);

  // Extract path + query from URL for the digest URI
  const parsedUrl = new URL(ctx.url);
  const uri = parsedUrl.pathname + parsedUrl.search;

  const ha1 = md5(`${ctx.publicKey}:${realm}:${ctx.privateKey}`);
  const ha2 = md5(`${ctx.method}:${uri}`);

  let response: string;
  if (qop === 'auth' || qop === 'auth-int') {
    response = md5(`${ha1}:${nonce}:${nc}:${cnonce}:${qop}:${ha2}`);
  } else {
    response = md5(`${ha1}:${nonce}:${ha2}`);
  }

  const parts: string[] = [
    `username="${ctx.publicKey}"`,
    `realm="${realm}"`,
    `nonce="${nonce}"`,
    `uri="${uri}"`,
    `response="${response}"`,
  ];

  if (qop) {
    parts.push(`qop=${qop}`, `nc=${nc}`, `cnonce="${cnonce}"`);
  }
  if (opaque) {
    parts.push(`opaque="${opaque}"`);
  }

  return `Digest ${parts.join(', ')}`;
}

/**
 * Extract a quoted directive value from an HTTP authentication header string.
 *
 * @param header - The raw header value to search (e.g.
 *   `'Digest realm="myRealm", nonce="abc123", qop="auth"'`).
 * @param key - The directive name to extract (e.g. `'realm'`, `'nonce'`).
 * @returns The unquoted directive value, or `''` when the key is absent.
 *
 * @example
 * ```ts
 * extractDirective('Digest realm="Atlas", nonce="xyz"', 'nonce'); // 'xyz'
 * extractDirective('Digest realm="Atlas"', 'qop');                // ''
 * ```
 */
function extractDirective(header: string, key: string): string {
  const match = header.match(new RegExp(`${key}="([^"]*)"`, 'i'));
  return match?.[1] ?? '';
}

/**
 * Compute the MD5 hex digest of a UTF-8 string.
 *
 * @param input - The string to hash.
 * @returns The lowercase hexadecimal MD5 digest (32 characters).
 *
 * @remarks
 * MD5 is used here because RFC 7616 HTTP Digest authentication explicitly
 * mandates it for computing HA1, HA2, and the response token. This is not a
 * general-purpose security choice — collision resistance is irrelevant in the
 * Digest auth protocol context.
 */
function md5(input: string): string {
  return createHash('md5').update(input, 'utf8').digest('hex');
}

/**
 * Map AWS region format to MongoDB Atlas region format.
 * e.g. "us-east-1" → "US_EAST_1"
 */
export function mapAwsRegionToAtlas(awsRegion: string): string {
  return awsRegion.toUpperCase().replace(/-/g, '_');
}
