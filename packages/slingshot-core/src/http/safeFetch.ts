import { promises as dnsPromises } from 'node:dns';
import type { ClientRequest } from 'node:http';
import { isIP } from 'node:net';

/**
 * Minimal local type for the subset of the undici `Dispatcher` we use. We
 * keep this local so callers do not need to import undici types directly.
 */
interface UndiciDispatcherLike {
  close?: () => Promise<void>;
}

type LookupFn = (
  hostname: string,
  options: unknown,
  callback: (err: NodeJS.ErrnoException | null, address: string, family: number) => void,
) => void;

interface UndiciAgentOptions {
  connect?: {
    lookup?: LookupFn;
    timeout?: number;
  };
  bodyTimeout?: number;
  headersTimeout?: number;
}

type UndiciAgentCtor = new (opts?: UndiciAgentOptions) => UndiciDispatcherLike;
type UndiciFetch = (
  input: RequestInfo | URL,
  init?: RequestInit & { dispatcher?: UndiciDispatcherLike },
) => Promise<Response>;

let undiciPromise: Promise<{ Agent: UndiciAgentCtor; fetch: UndiciFetch }> | null = null;
async function loadUndici(): Promise<{ Agent: UndiciAgentCtor; fetch: UndiciFetch }> {
  if (!undiciPromise) {
    const mod = await import('undici');
    const undici = mod as unknown as { Agent: UndiciAgentCtor; fetch?: UndiciFetch };
    undiciPromise = Promise.resolve({
      Agent: undici.Agent,
      fetch: undici.fetch ?? (globalThis.fetch as UndiciFetch),
    });
  }
  return undiciPromise;
}

/**
 * Options for {@link createSafeFetch}.
 *
 * The defaults reject loopback, link-local, private, and multicast IPs to
 * provide SSRF protection. Callers may override `isIpAllowed` and `resolveHost`
 * for custom policies or testing.
 */
export interface SafeFetchOptions {
  /** Validates the resolved IP. Return true to allow. */
  isIpAllowed?: (ip: string, family: 4 | 6) => boolean | Promise<boolean>;
  /** Override DNS resolver for testing. */
  resolveHost?: (hostname: string) => Promise<{ address: string; family: 4 | 6 }[]>;
  /** Default 10s connect timeout. */
  connectTimeoutMs?: number;
  /** Default 30s body timeout. */
  bodyTimeoutMs?: number;
  /** Default 30s headers timeout. */
  headersTimeoutMs?: number;
}

/**
 * Thrown when the resolved IP for a target hostname fails the allow-policy.
 */
export class SafeFetchBlockedError extends Error {
  constructor(
    public ip: string,
    public reason: string,
  ) {
    super(`safeFetch blocked: ${ip} (${reason})`);
    this.name = 'SafeFetchBlockedError';
  }
}

/**
 * Thrown when DNS resolution for a target hostname fails or returns no records.
 */
export class SafeFetchDnsError extends Error {
  constructor(
    public hostname: string,
    cause?: unknown,
  ) {
    super(`safeFetch DNS resolve failed: ${hostname}`);
    this.name = 'SafeFetchDnsError';
    (this as unknown as { cause: unknown }).cause = cause;
  }
}

/**
 * Create a `fetch`-compatible function that resolves DNS once, validates the
 * resolved IP, and pins the underlying TCP connection to that IP. This closes
 * the DNS-rebinding TOCTOU window present in plain `fetch`, which re-resolves
 * the hostname inside the HTTP client after caller-side validation.
 */
export function createSafeFetch(opts: SafeFetchOptions = {}): typeof fetch {
  const isIpAllowed = opts.isIpAllowed ?? defaultIpAllowed;
  const resolveHost = opts.resolveHost ?? defaultResolveHost;
  const connectTimeoutMs = opts.connectTimeoutMs ?? 10_000;
  const bodyTimeoutMs = opts.bodyTimeoutMs ?? 30_000;
  const headersTimeoutMs = opts.headersTimeoutMs ?? 30_000;

  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const href =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.href
          : (input as Request).url;
    const url = new URL(href);

    let resolvedIp: string;
    let family: 4 | 6;
    if (isIP(url.hostname)) {
      resolvedIp = url.hostname.replace(/^\[|\]$/g, '');
      family = (isIP(resolvedIp) === 6 ? 6 : 4) as 4 | 6;
    } else {
      let records: { address: string; family: 4 | 6 }[] | undefined;
      try {
        records = await resolveHost(url.hostname);
      } catch (err) {
        throw new SafeFetchDnsError(url.hostname, err);
      }
      if (!records || records.length === 0) throw new SafeFetchDnsError(url.hostname);
      // Pick first record. For multi-record support, callers pass their own resolveHost.
      const first = records[0] as { address: string; family: 4 | 6 };
      resolvedIp = first.address;
      family = first.family;
    }

    const allowed = await isIpAllowed(resolvedIp, family);
    if (!allowed) throw new SafeFetchBlockedError(resolvedIp, 'ip-blocked');

    if (isBunRuntime()) {
      return await fetchWithPinnedNodeRequest(
        input,
        init,
        url,
        resolvedIp,
        family,
        Math.max(connectTimeoutMs, headersTimeoutMs, bodyTimeoutMs),
      );
    }

    // Build a per-request undici Agent that pins the lookup to the validated IP.
    const { Agent, fetch: undiciFetch } = await loadUndici();
    const dispatcher = new Agent({
      connect: {
        // Custom lookup: always return resolved IP, ignoring the OS resolver.
        lookup: (_host, _options, callback) => {
          callback(null, resolvedIp, family);
        },
        timeout: connectTimeoutMs,
      },
      bodyTimeout: bodyTimeoutMs,
      headersTimeout: headersTimeoutMs,
    });

    const undiciInit: RequestInit & { dispatcher: UndiciDispatcherLike } = {
      ...(init as RequestInit),
      dispatcher,
    };
    try {
      return await undiciFetch(input as RequestInfo, undiciInit);
    } finally {
      // Best-effort close to free sockets; non-fatal. In runtimes that ship a
      // stub for `undici.Agent` (e.g. Bun), `close` may be undefined.
      try {
        const closeFn = dispatcher.close;
        if (typeof closeFn === 'function') void closeFn.call(dispatcher).catch(() => {});
      } catch {
        // ignore
      }
    }
  }) as typeof fetch;
}

async function defaultResolveHost(hostname: string): Promise<{ address: string; family: 4 | 6 }[]> {
  const records = await dnsPromises.lookup(hostname, { all: true, verbatim: true });
  return records.map(r => ({ address: r.address, family: r.family as 4 | 6 }));
}

function defaultIpAllowed(ip: string, family: 4 | 6): boolean {
  // Default allow public IPs; reject loopback / link-local / private.
  return !isPrivateOrLoopbackIp(ip, family);
}

function isBunRuntime(): boolean {
  return typeof (globalThis as { Bun?: unknown }).Bun !== 'undefined';
}

function mergeRequestHeaders(input: RequestInfo | URL, init?: RequestInit): Headers {
  const headers = new Headers();
  if (typeof input !== 'string' && !(input instanceof URL)) {
    for (const [name, value] of (input as Request).headers) {
      headers.set(name, value);
    }
  }
  if (init?.headers) {
    for (const [name, value] of new Headers(init.headers)) {
      headers.set(name, value);
    }
  }
  return headers;
}

function resolveRequestMethod(input: RequestInfo | URL, init?: RequestInit): string {
  if (init?.method) return init.method;
  if (typeof input !== 'string' && !(input instanceof URL)) return (input as Request).method;
  return 'GET';
}

function resolveRequestBody(input: RequestInfo | URL, init?: RequestInit): BodyInit | null {
  if (init && 'body' in init) return init.body ?? null;
  if (typeof input !== 'string' && !(input instanceof URL)) return (input as Request).body;
  return null;
}

function resolveRequestSignal(input: RequestInfo | URL, init?: RequestInit): AbortSignal | null {
  if (init?.signal) return init.signal;
  if (typeof input !== 'string' && !(input instanceof URL)) return (input as Request).signal;
  return null;
}

function toResponseHeaders(headers: Record<string, string | string[] | undefined>): Headers {
  const out = new Headers();
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      for (const item of value) out.append(name, item);
    } else {
      out.set(name, value);
    }
  }
  return out;
}

async function writeRequestBody(req: ClientRequest, body: BodyInit | null): Promise<void> {
  if (body == null) {
    req.end();
    return;
  }

  if (typeof body === 'string' || body instanceof Uint8Array) {
    req.end(body);
    return;
  }

  if (body instanceof ArrayBuffer) {
    req.end(new Uint8Array(body));
    return;
  }

  if (body instanceof URLSearchParams) {
    req.end(body.toString());
    return;
  }

  if (body instanceof Blob) {
    req.end(new Uint8Array(await body.arrayBuffer()));
    return;
  }

  if (body instanceof ReadableStream) {
    const reader = body.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!req.write(value)) {
          await new Promise<void>((resolve, reject) => {
            req.once('drain', resolve);
            req.once('error', reject);
          });
        }
      }
      req.end();
    } finally {
      reader.releaseLock();
    }
    return;
  }

  req.end(String(body));
}

async function fetchWithPinnedNodeRequest(
  input: RequestInfo | URL,
  init: RequestInit | undefined,
  url: URL,
  resolvedIp: string,
  family: 4 | 6,
  connectTimeoutMs: number,
): Promise<Response> {
  const transport =
    url.protocol === 'https:' ? await import('node:https') : await import('node:http');
  const headers = mergeRequestHeaders(input, init);
  const signal = resolveRequestSignal(input, init);

  return await new Promise<Response>((resolve, reject) => {
    let settled = false;
    let responseBody: ReadableStream<Uint8Array> | undefined;
    const fail = (err: unknown): void => {
      if (settled) return;
      settled = true;
      reject(err);
    };
    const request = transport.request(
      {
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port || (url.protocol === 'https:' ? 443 : 80),
        path: `${url.pathname}${url.search}`,
        method: resolveRequestMethod(input, init),
        headers: Object.fromEntries(headers),
        servername: url.hostname,
        lookup: (_hostname, _options, callback) => {
          const cb = callback as (
            err: NodeJS.ErrnoException | null,
            address: Array<{ address: string; family: number }>,
          ) => void;
          cb(null, [{ address: resolvedIp, family }]);
        },
      },
      res => {
        responseBody = new ReadableStream<Uint8Array>({
          start(controller) {
            res.on('data', chunk => controller.enqueue(new Uint8Array(chunk)));
            res.on('end', () => controller.close());
            res.on('error', err => controller.error(err));
          },
          cancel() {
            res.destroy();
          },
        });
        settled = true;
        resolve(
          new Response(responseBody, {
            status: res.statusCode ?? 0,
            statusText: res.statusMessage,
            headers: toResponseHeaders(res.headers),
          }),
        );
      },
    );

    const onAbort = (): void => {
      request.destroy(new Error('The operation was aborted'));
      if (responseBody) responseBody.cancel().catch(() => {});
      fail(new DOMException('The operation was aborted', 'AbortError'));
    };
    if (signal?.aborted) {
      onAbort();
      return;
    }
    signal?.addEventListener('abort', onAbort, { once: true });

    request.setTimeout(connectTimeoutMs, () => {
      request.destroy(new Error('safeFetch request timed out'));
    });
    request.once('error', fail);
    request.once('close', () => signal?.removeEventListener('abort', onAbort));

    void writeRequestBody(request, resolveRequestBody(input, init)).catch(err => {
      request.destroy(err instanceof Error ? err : new Error(String(err)));
      fail(err);
    });
  });
}

/**
 * Returns true if the IP is loopback, link-local, private, multicast, or
 * otherwise unsafe for outbound requests to user-supplied URLs.
 */
export function isPrivateOrLoopbackIp(ip: string, family: 4 | 6): boolean {
  if (family === 4) {
    const parts = ip.split('.').map(Number);
    if (parts.length !== 4 || parts.some(p => isNaN(p))) return true;
    const [a, b] = parts as [number, number, number, number];
    if (a === 10) return true;
    if (a === 127) return true;
    if (a === 0) return true;
    if (a === 169 && b === 254) return true; // link-local
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a >= 224) return true; // multicast/reserved
    return false;
  }
  // IPv6
  const norm = ip.toLowerCase().replace(/%.*$/, ''); // strip zone-id
  if (norm === '::1') return true; // loopback
  if (norm === '::') return true;
  if (
    norm.startsWith('fe80:') ||
    norm.startsWith('fe8') ||
    norm.startsWith('fe9') ||
    norm.startsWith('fea') ||
    norm.startsWith('feb')
  )
    return true; // fe80::/10
  if (norm.startsWith('fc') || norm.startsWith('fd')) return true; // fc00::/7 unique-local
  if (
    norm.startsWith('fec') ||
    norm.startsWith('fed') ||
    norm.startsWith('fee') ||
    norm.startsWith('fef')
  )
    return true; // fec0::/10 site-local (deprecated)
  if (norm.startsWith('ff')) return true; // multicast
  // mapped IPv4
  if (norm.startsWith('::ffff:')) {
    const v4 = norm.slice(7);
    return isPrivateOrLoopbackIp(v4, 4);
  }
  return false;
}
