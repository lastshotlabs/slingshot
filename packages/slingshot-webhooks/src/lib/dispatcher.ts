import { WebhookDeliveryError } from '../types/queue';
import type { WebhookJob } from '../types/queue';
import { signPayload } from './signing';

/**
 * Executes a single webhook HTTP delivery attempt for the given job.
 *
 * Signs the payload with HMAC-SHA256 and posts it to `job.url` with the
 * `X-Webhook-Signature`, `X-Webhook-Event`, and `X-Webhook-Delivery` headers.
 *
 * @param job - The webhook job containing URL, secret, event, and payload.
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
export async function deliverWebhook(job: WebhookJob): Promise<void> {
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
