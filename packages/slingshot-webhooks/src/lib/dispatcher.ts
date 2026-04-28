import { promises as dnsPromises } from 'node:dns';
import { isIP } from 'node:net';
import {
  createSafeFetch,
  SafeFetchBlockedError,
  SafeFetchDnsError,
  type SafeFetchOptions,
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
   * Resolve the hostname and validate every resolved IP against the SSRF
   * blocklist before issuing the request. Default: `true`.
   *
   * Disable only when you are certain registration-time validation is
   * sufficient (e.g. a closed test environment).
   */
  validateResolvedIp?: boolean;
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
   * validation still runs when `validateResolvedIp` is true.
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

async function defaultResolveHost(
  hostname: string,
): Promise<{ address: string; family: 4 | 6 }[]> {
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
      throw new WebhookDeliveryError(
        `Webhook delivery blocked: IP ${host} is not allowed`,
        false,
      );
    }
    return { address: host, family };
  }

  let records: { address: string; family: 4 | 6 }[] = [];
  try {
    records = await resolveHost(host);
  } catch (err) {
    throw new WebhookDeliveryError(
      `Webhook DNS lookup failed: ${err instanceof Error ? err.message : String(err)}`,
      true,
    );
  }
  if (records.length === 0) {
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
  return records[0]!;
}

/**
 * Executes a single webhook HTTP delivery attempt for the given job.
 *
 * Signs the payload with HMAC-SHA256 and posts it to `job.url` with the
 * `X-Webhook-Signature`, `X-Webhook-Event`, and `X-Webhook-Delivery` headers.
 *
 * Performs a defense-in-depth SSRF check via {@link validateWebhookUrl} before
 * making the outbound request, guarding against private/loopback targets that
 * may have bypassed registration-time validation. When `validateResolvedIp` is
 * true (default), additionally resolves the hostname, validates every resolved
 * IP, and pins the TCP connection to the validated IP via `createSafeFetch` —
 * eliminating the DNS-rebinding TOCTOU window.
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
  const validateResolvedIp = opts.validateResolvedIp ?? true;

  // Defense-in-depth: reject private/loopback targets even if validation was
  // bypassed at registration time (e.g. direct adapter writes, migrated rows).
  validateWebhookUrl(job.url);

  const isIpAllowed = opts.safeFetchOverrides?.isIpAllowed ?? defaultIsIpAllowed;
  const resolveHost = opts.safeFetchOverrides?.resolveHost ?? defaultResolveHost;

  // Run pre-fetch DNS + IP validation. This also yields the resolved IP we
  // can pin our underlying connection to.
  if (validateResolvedIp) {
    await resolveAndValidate(job.url, isIpAllowed, resolveHost);
  }

  // Build the fetch implementation. Tests can short-circuit by passing
  // `fetchImpl`; otherwise we use createSafeFetch so the connection is
  // pinned to the validated IP, closing the rebinding TOCTOU window.
  let fetchImpl: typeof fetch;
  if (opts.fetchImpl) {
    fetchImpl = opts.fetchImpl;
  } else if (validateResolvedIp) {
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

  let res: Response;
  try {
    res = await fetchImpl(job.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Webhook-Signature': signature,
        'X-Webhook-Event': job.event,
        'X-Webhook-Event-Id': job.eventId,
        'X-Webhook-Occurred-At': job.occurredAt,
        'X-Webhook-Delivery': job.deliveryId,
      },
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
