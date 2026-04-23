// ---------------------------------------------------------------------------
// Idempotency middleware - consumes repository from SlingshotContext
// ---------------------------------------------------------------------------
import type { MiddlewareHandler } from 'hono';
import type { AppEnv } from '@lastshotlabs/slingshot-core';
import { HEADER_IDEMPOTENCY_KEY, getActorId, hmacSign, sha256 } from '@lastshotlabs/slingshot-core';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface IdempotencyOptions {
  /** TTL in seconds for cached responses. Default: 86400 (24 hours). */
  ttl?: number;
}

async function buildRequestFingerprint(
  c: Parameters<MiddlewareHandler<AppEnv>>[0],
): Promise<string> {
  const url = new URL(c.req.url);
  const contentType = c.req.header('content-type') ?? '';
  const body = await c.req.raw
    .clone()
    .text()
    .catch(() => '');
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

function replayStoredResponse(
  record: Awaited<
    ReturnType<import('@lastshotlabs/slingshot-core').IdempotencyAdapter['get']>
  > extends infer TRecord
    ? Exclude<TRecord, null>
    : never,
): Response {
  const body =
    record.responseEncoding === 'base64' ? Buffer.from(record.response, 'base64') : record.response;
  return new Response(body, {
    status: record.status,
    headers: record.responseHeaders ?? undefined,
  });
}

function captureResponseHeaders(response: Response): Record<string, string> | null {
  const headers = Object.fromEntries(response.headers.entries());
  return Object.keys(headers).length > 0 ? headers : null;
}

async function captureResponsePayload(
  response: Response,
): Promise<{ body: string; encoding: 'base64' | 'utf8' } | null> {
  try {
    const buffer = Buffer.from(await response.clone().arrayBuffer());
    return {
      body: buffer.toString('base64'),
      encoding: 'base64',
    };
  } catch {
    return null;
  }
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
    const userId = getActorId(c);
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
      return replayStoredResponse(cached);
    }

    // Cache miss - call handler
    await next();

    const status = c.res.status;
    const payload = await captureResponsePayload(c.res);
    if (!payload) {
      return;
    }

    const responseHeaders = captureResponseHeaders(c.res);
    await adapter.set(key, payload.body, status, ttl, {
      requestFingerprint,
      responseHeaders,
      responseEncoding: payload.encoding,
    });

    // Re-read to handle write collision (NX semantics - set() may have been a no-op)
    const stored = await adapter.get(key);
    if (stored?.requestFingerprint && stored.requestFingerprint !== requestFingerprint) {
      c.res = fingerprintConflictResponse(c);
      return;
    }
    if (
      stored &&
      (stored.response !== payload.body ||
        JSON.stringify(stored.responseHeaders ?? null) !== JSON.stringify(responseHeaders))
    ) {
      c.res = replayStoredResponse(stored);
    }
  };
