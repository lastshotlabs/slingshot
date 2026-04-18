/**
 * Signs a webhook payload using HMAC-SHA256 and returns a Stripe-style signature header value.
 *
 * Signature format: `t=<unix_timestamp>,v1=<hex_hmac>` where the signed data is `<ts>.<body>`.
 * This format is intentionally compatible with Stripe's webhook signature scheme.
 *
 * @param secret - The HMAC signing secret stored on the `WebhookEndpoint`.
 * @param body - The raw JSON string to sign (the request body).
 * @param timestamp - Unix timestamp in seconds. Defaults to `Math.floor(Date.now() / 1000)`.
 * @returns The `X-Webhook-Signature` header value.
 *
 * @example
 * ```ts
 * import { signPayload } from '@lastshotlabs/slingshot-webhooks';
 *
 * const signature = await signPayload('my-secret', JSON.stringify({ event: 'auth:login' }));
 * // => 't=1712345678,v1=abcdef...'
 * ```
 */
export async function signPayload(
  secret: string,
  body: string,
  timestamp?: number,
): Promise<string> {
  const ts = timestamp ?? Math.floor(Date.now() / 1000);
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const data = encoder.encode(`${ts}.${body}`);
  const sig = await crypto.subtle.sign('HMAC', key, data);
  const hex = Array.from(new Uint8Array(sig))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
  return `t=${ts},v1=${hex}`;
}

/**
 * Verifies a webhook signature header produced by `signPayload`.
 *
 * Parses the `t=...` timestamp and `v1=...` hex HMAC from the header, recomputes the
 * expected HMAC, and uses a constant-time comparison via `crypto.subtle.verify`.
 * Rejects signatures where the timestamp differs from `now` by more than `toleranceSeconds`
 * to prevent replay attacks.
 *
 * @param secret - The HMAC signing secret stored on the `WebhookEndpoint`.
 * @param body - The raw request body string (must match the body that was signed).
 * @param header - The `X-Webhook-Signature` header value from the incoming request.
 * @param toleranceSeconds - Maximum allowed age of the signature in seconds. Default: 300 (5 min).
 * @returns `true` if the signature is valid and within the tolerance window; `false` otherwise.
 *
 * @example
 * ```ts
 * import { verifySignature } from '@lastshotlabs/slingshot-webhooks';
 *
 * const valid = await verifySignature(
 *   endpoint.secret,
 *   rawBody,
 *   req.headers.get('x-webhook-signature') ?? '',
 * );
 * if (!valid) return new Response('Unauthorized', { status: 401 });
 * ```
 */
export async function verifySignature(
  secret: string,
  body: string,
  header: string,
  toleranceSeconds = 300,
): Promise<boolean> {
  const tsMatch = header.match(/(?:^|,)t=(\d+)(?:,|$)/);
  const v1Match = header.match(/(?:^|,)v1=([0-9a-f]+)(?:,|$)/);
  if (!tsMatch || !v1Match) return false;

  const ts = parseInt(tsMatch[1], 10);
  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - ts) > toleranceSeconds) return false;

  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['verify'],
  );
  const data = encoder.encode(`${ts}.${body}`);
  const signatureHex = v1Match[1];
  if (signatureHex.length !== 64 || signatureHex.length % 2 !== 0) return false;
  const pairs = signatureHex.match(/.{2}/g);
  if (!pairs) return false;
  const sigBytes = new Uint8Array(pairs.map(b => parseInt(b, 16)));
  return crypto.subtle.verify('HMAC', key, sigBytes, data);
}
