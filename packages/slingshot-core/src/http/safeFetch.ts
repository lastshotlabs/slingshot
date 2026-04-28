import { promises as dnsPromises } from 'node:dns';
import { isIP } from 'node:net';

/**
 * Minimal local type for the subset of the undici `Dispatcher` we use. We
 * avoid a hard import on `undici`/`undici-types` so this module compiles
 * cleanly in workspaces that don't list undici as a direct dependency. At
 * runtime the dispatcher is loaded dynamically from `undici` (provided by
 * Bun's built-in shim or Node's bundled module).
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

let agentCtorPromise: Promise<UndiciAgentCtor> | null = null;
async function loadAgentCtor(): Promise<UndiciAgentCtor> {
  if (!agentCtorPromise) {
    // Module specifier hidden from the type system: `undici` is a runtime
    // dependency provided by Bun and Node, but the workspace does not declare
    // a direct dep on it (and types are not bundled here).
    const mod = await (Function('return import("undici")') as () => Promise<unknown>)();
    agentCtorPromise = Promise.resolve((mod as { Agent: UndiciAgentCtor }).Agent);
  }
  return agentCtorPromise;
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

    // Build a per-request undici Agent that pins the lookup to the validated IP.
    const Agent = await loadAgentCtor();
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
      return await fetch(input as RequestInfo, undiciInit);
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
