import { promises as dnsPromises } from 'node:dns';
import { isIP } from 'node:net';
import {
  HeaderInjectionError,
  SafeFetchBlockedError,
  SafeFetchDnsError,
  type SafeFetchOptions,
  createSafeFetch,
  sanitizeHeaderValue,
} from '@lastshotlabs/slingshot-core';
import { WebhookDeliveryError } from '../types/queue';
import type { WebhookJob } from '../types/queue';
import { signPayload } from './signing';
import { validateWebhookIp, validateWebhookUrl } from './validateWebhookUrl';

/**
 * Dispatch options for {@link deliverWebhook}.
 *
 * The default dispatcher resolves the target hostname once via DNS, validates
 * the resolved IP against the webhook SSRF policy, and pins the underlying
 * TCP connection to that IP via a per-request undici Agent. This closes the
 * DNS-rebinding TOCTOU window present in plain `fetch` (which re-resolves
 * the hostname inside the HTTP client after caller-side validation).
 */
export interface DispatchOptions {
  /**
   * Wall-clock timeout for the outbound HTTP request. Default: 30 000 ms.
   */
  timeoutMs?: number;
  /**
   * Per-delivery opt-in to private/loopback IPs. SSRF protection cannot be
   * disabled by default — every dispatcher run validates resolved IPs
   * against the blocklist. Setting this to `true` allows private IPs for
   * one specific delivery (e.g. a closed test environment) and emits a
   * loud `console.warn` on every use so the bypass cannot drift unnoticed
   * into production. P-WEBHOOKS-5.
   */
  allowPrivateIps?: boolean;
  /**
   * Optional safeFetch overrides (typically used in tests to inject a
   * deterministic resolver / IP-allow predicate without hitting real DNS).
   * The same overrides are also used for the dispatcher's pre-fetch DNS
   * validation, so a single `resolveHost` mock covers both call sites.
   */
  safeFetchOverrides?: Pick<SafeFetchOptions, 'isIpAllowed' | 'resolveHost'>;
  /**
   * Optional fetch override (typically used in tests). When provided, this
   * fetch is used instead of the safeFetch-built one. Pre-fetch IP
   * validation still runs unless `allowPrivateIps` is explicitly true.
   */
  fetchImpl?: typeof fetch;
}

/**
 * Default predicate: returns true when `validateWebhookIp` does not throw for
 * the resolved IP. Mirrors the registration-time blocklist exactly.
 */
function defaultIsIpAllowed(ip: string): boolean {
  try {
    validateWebhookIp(ip);
    return true;
  } catch {
    return false;
  }
}

async function defaultResolveHost(hostname: string): Promise<{ address: string; family: 4 | 6 }[]> {
  const records = await dnsPromises.lookup(hostname, { all: true, verbatim: true });
  return records.map(r => ({ address: r.address, family: r.family as 4 | 6 }));
}

/**
 * Resolve the target hostname and validate the resolved IP up front. Returns
 * the validated IP record (so the caller can pin to it), or throws a
 * `WebhookDeliveryError` with the appropriate retryability.
 */
async function resolveAndValidate(
  url: string,
  isIpAllowed: NonNullable<SafeFetchOptions['isIpAllowed']>,
  resolveHost: NonNullable<SafeFetchOptions['resolveHost']>,
): Promise<{ address: string; family: 4 | 6 }> {
  const parsed = new URL(url);
  const host = parsed.hostname.replace(/^\[|\]$/g, '');

  if (isIP(host)) {
    const family = (isIP(host) === 6 ? 6 : 4) as 4 | 6;
    const allowed = await isIpAllowed(host, family);
    if (!allowed) {
      throw new WebhookDeliveryError(`Webhook delivery blocked: IP ${host} is not allowed`, false);
    }
    return { address: host, family };
  }

  let records: { address: string; family: 4 | 6 }[];
  try {
    records = await resolveHost(host);
  } catch (err) {
    throw new WebhookDeliveryError(
      `Webhook DNS lookup failed: ${err instanceof Error ? err.message : String(err)}`,
      true,
    );
  }
  const first = records[0];
  if (!first) {
    throw new WebhookDeliveryError(`Webhook DNS lookup failed: ${host}`, true);
  }

  for (const record of records) {
    const allowed = await isIpAllowed(record.address, record.family);
    if (!allowed) {
      throw new WebhookDeliveryError(
        `Webhook delivery blocked: resolved IP ${record.address} is not allowed`,
        false,
      );
    }
  }

  // Pin to the first record. Multi-record hosts are validated above; safeFetch
  // also pins to the first record returned by resolveHost.
  return first;
}

/**
 * Executes a single webhook HTTP delivery attempt for the given job.
 *
 * Signs the payload with HMAC-SHA256 and posts it to `job.url` with the
 * `X-Webhook-Signature`, `X-Webhook-Event`, and `X-Webhook-Delivery` headers.
 *
 * Performs a defense-in-depth SSRF check via {@link validateWebhookUrl} before
 * making the outbound request, guarding against private/loopback targets that
 * may have bypassed registration-time validation. By default the dispatcher
 * also resolves the hostname, validates every resolved IP, and pins the TCP
 * connection to the validated IP via `createSafeFetch` — eliminating the
 * DNS-rebinding TOCTOU window. Pass `allowPrivateIps: true` to skip both
 * checks for one specific delivery; a `console.warn` records every use.
 *
 * @param job - The webhook job containing URL, secret, event, and payload.
 * @param optsOrTimeout - Dispatch options object, or a legacy timeout-in-ms number.
 * @throws {WebhookDeliveryError} On any non-2xx response. `retryable` is `true`
 *   for 5xx and 429 responses; `false` for all other 4xx responses. SSRF and
 *   DNS-resolution errors are mapped to `WebhookDeliveryError` with the
 *   appropriate retryability (SSRF blocks: non-retryable; DNS failures: retryable).
 */
export async function deliverWebhook(
  job: WebhookJob,
  optsOrTimeout: DispatchOptions | number = {},
): Promise<void> {
  const opts: DispatchOptions =
    typeof optsOrTimeout === 'number' ? { timeoutMs: optsOrTimeout } : optsOrTimeout;
  const timeoutMs = opts.timeoutMs ?? 30_000;
  // P-WEBHOOKS-5: SSRF protection is on by default and can only be relaxed
  // per-delivery via the explicit `allowPrivateIps: true` opt-in. Even then
  // we log a loud warning so production deployments cannot quietly bypass
  // the resolved-IP check.
  const allowPrivateIps = opts.allowPrivateIps === true;

  // Defense-in-depth: reject private/loopback targets at registration
  // time. When the caller has opted in via `allowPrivateIps`, skip the URL
  // host check (host-level validation would block the request before
  // resolution).
  if (!allowPrivateIps) {
    validateWebhookUrl(job.url);
  } else {
    console.warn(
      `[slingshot-webhooks] allowPrivateIps=true bypassed SSRF protection for delivery="${job.deliveryId}" url="${job.url}". This must never happen in production.`,
    );
  }

  const isIpAllowed = opts.safeFetchOverrides?.isIpAllowed ?? defaultIsIpAllowed;
  const resolveHost = opts.safeFetchOverrides?.resolveHost ?? defaultResolveHost;

  // Run pre-fetch DNS + IP validation unless the caller opted into
  // private IPs for this one delivery.
  if (!allowPrivateIps) {
    await resolveAndValidate(job.url, isIpAllowed, resolveHost);
  }

  // Build the fetch implementation. Tests can short-circuit by passing
  // `fetchImpl`; otherwise we use createSafeFetch so the connection is
  // pinned to the validated IP, closing the rebinding TOCTOU window.
  let fetchImpl: typeof fetch;
  if (opts.fetchImpl) {
    fetchImpl = opts.fetchImpl;
  } else if (!allowPrivateIps) {
    const safeFetchOptions: SafeFetchOptions = {
      isIpAllowed,
      resolveHost,
      headersTimeoutMs: timeoutMs,
      bodyTimeoutMs: timeoutMs,
    };
    fetchImpl = createSafeFetch(safeFetchOptions);
  } else {
    fetchImpl = globalThis.fetch as typeof fetch;
  }

  const timestamp = Math.floor(Date.now() / 1000);
  const signature = await signPayload(job.secret, job.payload, timestamp);

  // Defense-in-depth: every value below is framework-derived (event-key
  // template literal, UUID, ISO timestamp, hex/base64 signature), but a
  // misconfigured event registration or a buggy upstream could still smuggle
  // CR/LF into one of these fields. Sanitize at the sink so the wire bytes
  // can never contain header-splitting characters; surface a non-retryable
  // delivery error instead of silently stripping.
  let outboundHeaders: Record<string, string>;
  try {
    outboundHeaders = {
      'Content-Type': 'application/json',
      'X-Webhook-Signature': sanitizeHeaderValue(signature, 'X-Webhook-Signature'),
      'X-Webhook-Event': sanitizeHeaderValue(String(job.event), 'X-Webhook-Event'),
      'X-Webhook-Event-Id': sanitizeHeaderValue(job.eventId, 'X-Webhook-Event-Id'),
      'X-Webhook-Occurred-At': sanitizeHeaderValue(job.occurredAt, 'X-Webhook-Occurred-At'),
      'X-Webhook-Delivery': sanitizeHeaderValue(job.deliveryId, 'X-Webhook-Delivery'),
    };
  } catch (err) {
    if (err instanceof HeaderInjectionError) {
      throw new WebhookDeliveryError(
        `Webhook delivery aborted: header "${err.header ?? 'unknown'}" contains CR, LF, or NUL`,
        false,
      );
    }
    throw err;
  }

  let res: Response;
  try {
    res = await fetchImpl(job.url, {
      method: 'POST',
      headers: outboundHeaders,
      body: job.payload,
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    if (err instanceof SafeFetchBlockedError) {
      throw new WebhookDeliveryError(
        `Webhook delivery blocked: resolved IP ${err.ip} is not allowed (${err.reason})`,
        false,
      );
    }
    if (err instanceof SafeFetchDnsError) {
      throw new WebhookDeliveryError(`Webhook DNS lookup failed: ${err.hostname}`, true);
    }
    throw err;
  }

  if (!res.ok) {
    const retryable = res.status >= 500 || res.status === 429;
    throw new WebhookDeliveryError(
      `Webhook delivery failed: HTTP ${res.status}`,
      retryable,
      res.status,
    );
  }
}
