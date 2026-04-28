import { lookup as dnsLookup } from 'node:dns/promises';
import { WebhookDeliveryError } from '../types/queue';
import type { WebhookJob } from '../types/queue';
import { signPayload } from './signing';
import { validateWebhookIp, validateWebhookUrl } from './validateWebhookUrl';

/**
 * Optional dispatch-time DNS rebinding defense.
 *
 * When enabled, the dispatcher resolves the target hostname to an IP via
 * `dns.lookup` and runs each resolved address through {@link validateWebhookIp}
 * before sending the request. This closes the TOCTOU window between
 * registration-time hostname validation and delivery-time DNS resolution.
 *
 * A residual TOCTOU window remains between the lookup here and the kernel's
 * resolution inside `fetch`. Eliminating it fully requires bypassing fetch
 * (e.g. swapping in a custom agent that pins the resolved IP) — out of scope
 * for the default dispatcher.
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
}

async function resolveAndValidateHost(hostname: string): Promise<void> {
  // IP literals are validated by validateWebhookUrl already; only resolve when
  // we have a hostname.
  if (/^\d+\.\d+\.\d+\.\d+$/.test(hostname) || hostname.includes(':')) return;
  if (hostname === 'localhost' || hostname.endsWith('.localhost')) {
    throw new Error('Invalid webhook URL: hostname resolves to a loopback target');
  }

  const results = await dnsLookup(hostname, { all: true });
  for (const { address } of results) {
    validateWebhookIp(address);
  }
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
 * true (default), additionally resolves the hostname and validates every
 * resolved IP, protecting against DNS rebinding.
 *
 * @param job - The webhook job containing URL, secret, event, and payload.
 * @param optsOrTimeout - Dispatch options object, or a legacy timeout-in-ms number.
 * @throws {WebhookDeliveryError} On any non-2xx response. `retryable` is `true`
 *   for 5xx and 429 responses; `false` for all other 4xx responses.
 *
 * @remarks
 * The following headers are sent with every delivery request:
 * - `Content-Type: application/json` — the body is always the raw JSON payload string.
 * - `X-Webhook-Signature` — HMAC-SHA256 signature of the payload, computed by `signPayload`.
 * - `X-Webhook-Event` — the event key that triggered the delivery (e.g. `entity:post.created`).
 * - `X-Webhook-Delivery` — a unique delivery ID for idempotency and tracing (`job.deliveryId`).
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

  if (validateResolvedIp) {
    try {
      const parsed = new URL(job.url);
      await resolveAndValidateHost(parsed.hostname.toLowerCase());
    } catch (err) {
      if (err instanceof Error && err.message.startsWith('Invalid webhook URL')) {
        throw new WebhookDeliveryError(err.message, false);
      }
      // DNS lookup failure is treated as retryable — transient resolver issues
      // shouldn't permanently fail a delivery.
      throw new WebhookDeliveryError(
        `Webhook DNS lookup failed: ${err instanceof Error ? err.message : String(err)}`,
        true,
      );
    }
  }

  const timestamp = Math.floor(Date.now() / 1000);
  const signature = await signPayload(job.secret, job.payload, timestamp);
  const res = await fetch(job.url, {
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
  if (!res.ok) {
    const retryable = res.status >= 500 || res.status === 429;
    throw new WebhookDeliveryError(
      `Webhook delivery failed: HTTP ${res.status}`,
      retryable,
      res.status,
    );
  }
}
