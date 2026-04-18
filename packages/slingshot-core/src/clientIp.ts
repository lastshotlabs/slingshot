import type { Context } from 'hono';
import type { AppEnv } from './context';
import type { SlingshotContext } from './context/slingshotContext';

const TRUST_PROXY_SYMBOL = Symbol.for('slingshot.trustProxy');
const CLIENT_IP_SYMBOL = Symbol.for('slingshot.clientIp');
const HEADER_READER_SYMBOL = Symbol.for('slingshot.headerReader');

type RequestLike = Request &
  Partial<{
    header(name: string): string | undefined;
    [HEADER_READER_SYMBOL]: (name: string) => string | undefined;
  }>;

function readHeader(req: RequestLike, name: string): string | undefined {
  let headerValue: string | null;
  try {
    headerValue = req.headers.get(name);
  } catch {
    headerValue = null;
  }
  if (typeof headerValue === 'string') return headerValue;
  const fallback =
    (req as { [HEADER_READER_SYMBOL]?: (name: string) => string | undefined })[
      HEADER_READER_SYMBOL
    ] ?? req.header;
  if (typeof fallback === 'function') {
    return fallback(name);
  }
  return undefined;
}

/**
 * Attach a trust-proxy depth to a raw `Request` object for standalone (non-framework) usage.
 *
 * When using `getClientIp` outside of a full Slingshot app (e.g., in a plain Hono server),
 * call this function before the request reaches the handler so `getClientIp` can read the
 * correct proxy trust depth from the request.
 *
 * @param req - The inbound `Request` to annotate.
 * @param value - `false` to disable proxy trust (use socket IP); or a positive integer N to
 *   trust N proxies (reads the Nth entry from the right in `X-Forwarded-For`).
 *
 * @remarks
 * **Side effects:** this function mutates the `Request` object by defining a non-enumerable
 * property keyed by an internal `Symbol`. The mutation is confined to the single `Request`
 * instance — it does not affect other requests or global state. The property is
 * `configurable: true` so it can be overwritten by a subsequent call with a different value
 * on the same request object.
 *
 * In a full Slingshot app, do NOT call this — set `trustProxy` in the app config instead and
 * the framework reads it from `SlingshotContext`. This function is only for plain Hono servers
 * that call `getClientIp()` directly without a `SlingshotContext` in scope.
 *
 * @example
 * ```ts
 * import { setStandaloneTrustProxy, getClientIp } from '@lastshotlabs/slingshot-core';
 *
 * app.use((c, next) => {
 *   setStandaloneTrustProxy(c.req.raw, 1); // trust one upstream proxy
 *   return next();
 * });
 * ```
 */
export const setStandaloneTrustProxy = (req: Request, value: false | number): void => {
  Object.defineProperty(req, TRUST_PROXY_SYMBOL, {
    configurable: true,
    enumerable: false,
    writable: true,
    value,
  });
};

/**
 * Attach a resolved socket IP address to a raw `Request` object for standalone
 * upgrade/auth flows that do not have a Hono `Context`.
 *
 * This is used by WS/SSE upgrade handlers so downstream auth helpers can
 * enforce IP-based session binding with the same semantics as normal HTTP
 * requests.
 */
export const setStandaloneClientIp = (req: Request, value: string): void => {
  Object.defineProperty(req, CLIENT_IP_SYMBOL, {
    configurable: true,
    enumerable: false,
    writable: true,
    value,
  });
};

const normalizeIp = (ip: string): string => (ip.startsWith('::ffff:') ? ip.slice(7) : ip);

/**
 * Extract the real client IP address from a raw `Request`.
 *
 * Reads the socket IP snapshot attached by `setStandaloneClientIp`, then applies
 * the same `trustProxy` semantics as `getClientIp`.
 */
export const getClientIpFromRequest = (req: Request, trustProxy: false | number): string => {
  const socketIp = (req as unknown as Record<PropertyKey, unknown>)[CLIENT_IP_SYMBOL];
  const normalizedSocketIp =
    typeof socketIp === 'string' && socketIp.length > 0 ? normalizeIp(socketIp) : 'unknown';
  const requestLike = req as RequestLike;

  if (trustProxy === false) {
    return normalizedSocketIp;
  }

  const xff = readHeader(requestLike, 'x-forwarded-for');
  if (xff) {
    const ips = xff
      .split(',')
      .map(s => s.trim())
      .filter(Boolean);
    const idx = ips.length - trustProxy - 1;
    if (idx >= 0 && ips[idx]) {
      return normalizeIp(ips[idx]);
    }
    return normalizedSocketIp;
  }

  const realIp = readHeader(requestLike, 'x-real-ip');
  return normalizeIp(realIp ?? normalizedSocketIp);
};

/**
 * Extract the real client IP address from a Hono request context.
 *
 * When `trustProxy` is `false` (the default), returns the raw socket address.
 * When `trustProxy` is a number N, reads the Nth entry from the right of the
 * `X-Forwarded-For` header chain, then falls back to `X-Real-IP`, then the socket address.
 *
 * IPv4-mapped IPv6 addresses (`::ffff:1.2.3.4`) are normalised to plain IPv4.
 * Returns `'unknown'` if no address is available.
 *
 * @param c - The Hono request context (typed or untyped).
 * @returns The client IP string (e.g. `'1.2.3.4'`), or `'unknown'` if not determinable.
 *
 * @remarks
 * The `trustProxy` setting is read from `SlingshotContext` (if available on the context
 * variable `slingshotCtx`) or from the symbol attached by `setStandaloneTrustProxy`.
 * Never trust `X-Forwarded-For` headers if your server is directly internet-facing —
 * clients can spoof them to bypass IP-based rate limiting.
 *
 * **IPv6-mapped IPv4 normalisation:** addresses in the form `::ffff:1.2.3.4` (IPv4 mapped
 * into the IPv6 address space) are automatically normalised to plain IPv4 notation
 * (`1.2.3.4`). This affects the socket IP, the `X-Forwarded-For` entries, and the
 * `X-Real-IP` value — all are normalised before being returned. The normalisation is
 * purely cosmetic and does not affect routing or security semantics.
 *
 * @example
 * ```ts
 * import { getClientIp } from '@lastshotlabs/slingshot-core';
 *
 * app.use((c, next) => {
 *   const ip = getClientIp(c);
 *   console.log('Request from:', ip);
 *   return next();
 * });
 * ```
 */
export const getClientIp = <E extends AppEnv>(c: Context<E>): string => {
  // slingshotCtx may not yet be set (e.g. upgrade handlers run before context middleware)
  const contextGet = (c as { get?: (key: string) => unknown }).get;
  const slingshotCtx =
    typeof contextGet === 'function'
      ? (contextGet.call(c, 'slingshotCtx') as SlingshotContext | undefined)
      : undefined;
  const trustProxy: false | number =
    slingshotCtx?.trustProxy ??
    ((c.req.raw as unknown as Record<PropertyKey, unknown>)[TRUST_PROXY_SYMBOL] as
      | false
      | number
      | undefined) ??
    false;

  let socketIp: string | undefined;
  try {
    const server = c.env as { requestIP?: (req: Request) => { address: string } | null };
    if (server.requestIP) {
      const info = server.requestIP(c.req.raw);
      if (info) socketIp = info.address;
    }
  } catch {
    // Bun/Deno requestIP API not available — socket IP unavailable
  }
  if (socketIp) {
    setStandaloneClientIp(c.req.raw, socketIp);
  }
  const rawReq = c.req.raw as RequestLike;
  const rawHeaders = (rawReq as { headers?: Headers }).headers;
  if (
    (rawHeaders == null || typeof rawHeaders.get !== 'function') &&
    typeof c.req.header === 'function' &&
    rawReq[HEADER_READER_SYMBOL] === undefined
  ) {
    Object.defineProperty(rawReq, HEADER_READER_SYMBOL, {
      configurable: true,
      enumerable: false,
      writable: true,
      value: (name: string) => c.req.header(name) ?? undefined,
    });
  }
  return getClientIpFromRequest(rawReq, trustProxy);
};
