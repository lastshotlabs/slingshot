// ---------------------------------------------------------------------------
// Idempotency middleware - consumes repository from SlingshotContext
// ---------------------------------------------------------------------------
import type { MiddlewareHandler } from 'hono';
import type { AppEnv } from '@lastshotlabs/slingshot-core';
import { HEADER_IDEMPOTENCY_KEY, hmacSign, sha256 } from '@lastshotlabs/slingshot-core';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface IdempotencyOptions {
  /** TTL in seconds for cached responses. Default: 86400 (24 hours). */
  ttl?: number;
}

async function buildRequestFingerprint(c: Parameters<MiddlewareHandler<AppEnv>>[0]): Promise<string> {
  const url = new URL(c.req.url);
  const contentType = c.req.header('content-type') ?? '';
  const body = await c.req.raw.clone().text().catch(() => '');
  return sha256(`${c.req.method}\n${url.pathname}\n${url.search}\n${contentType}\n${body}`);
}

function fingerprintConflictResponse(c: Parameters<MiddlewareHandler<AppEnv>>[0]): Response {
  return c.json(
    {
      error: 'Idempotency-Key reuse with different request',
      code: 'idempotency_key_conflict',
    },
    409,
  );
}

// ---------------------------------------------------------------------------
// Key derivation
// ---------------------------------------------------------------------------

function deriveKey(
  rawKey: string,
  userId: string | null,
  signing?: {
    config: import('@lib/signingConfig').SigningConfig | null;
    secret: string | string[] | null;
  },
): string {
  const prefix = userId ?? 'anon';
  if (signing?.config?.idempotencyKeys && signing.secret) {
    return `${prefix}:${hmacSign(rawKey, signing.secret)}`;
  }
  return `${prefix}:${rawKey}`;
}

// ---------------------------------------------------------------------------
// Middleware factory
// ---------------------------------------------------------------------------

/**
 * Idempotency middleware. Reads the `Idempotency-Key` header and returns a
 * cached response if one exists for this user + key combination. Otherwise
 * calls the next handler, stores the response, and returns it.
 *
 * On write collision (two concurrent identical requests), the second request
 * re-reads and returns the first-stored result.
 *
 * When `signing.idempotencyKeys: true`, keys are HMAC'd before storage to
 * prevent enumeration. When off, raw keys are stored (slight enumeration risk).
 */
export const idempotent =
  (opts?: IdempotencyOptions): MiddlewareHandler<AppEnv> =>
  async (c, next) => {
    const rawKey = c.req.header(HEADER_IDEMPOTENCY_KEY);
    if (!rawKey) {
      await next();
      return;
    }

    const ctx = c.get('slingshotCtx');
    const adapter = ctx.persistence.idempotency;
    const userId = c.get('authUserId') ?? null;
    const signingConfig = ctx.signing as import('@lib/signingConfig').SigningConfig | null;
    const signingSecret = signingConfig?.secret ?? null;
    const key = deriveKey(rawKey, userId, { config: signingConfig, secret: signingSecret });
    const ttl = opts?.ttl ?? 86400;
    const requestFingerprint = await buildRequestFingerprint(c);

    // Cache hit - return stored response
    const cached = await adapter.get(key);
    if (cached) {
      if (cached.requestFingerprint && cached.requestFingerprint !== requestFingerprint) {
        return fingerprintConflictResponse(c);
      }
      return c.json(
        JSON.parse(cached.response),
        cached.status as import('hono/utils/http-status').ContentfulStatusCode,
      );
    }

    // Cache miss - call handler
    await next();

    // Capture the response body by reading it
    const status = c.res.status;
    let body: string;
    try {
      body = await c.res.clone().text();
    } catch {
      // Non-text/non-json response - skip caching
      return;
    }

    await adapter.set(key, body, status, ttl, { requestFingerprint });

    // Re-read to handle write collision (NX semantics - set() may have been a no-op)
    const stored = await adapter.get(key);
    if (stored?.requestFingerprint && stored.requestFingerprint !== requestFingerprint) {
      c.res = fingerprintConflictResponse(c);
      return;
    }
    if (stored && stored.response !== body) {
      c.res = new Response(stored.response, {
        status: stored.status,
        headers: { 'content-type': 'application/json' },
      });
    }
  };
