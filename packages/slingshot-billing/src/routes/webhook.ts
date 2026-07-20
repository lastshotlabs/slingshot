/**
 * `POST <mountPath>/webhooks/stripe` — the signature-verified provider webhook.
 *
 * Deliberately a plain `app.post`, NOT an OpenAPI route: this is a
 * server-to-server surface for Stripe, not part of the client contract, and it
 * must consume the RAW request bytes (no body schema, no parsing middleware) so
 * signature verification sees exactly what Stripe signed. Authenticity comes
 * from the signature alone — the path is declared in the package's
 * `publicPaths` / `csrfExemptPaths`, and no auth middleware runs here.
 *
 * Status contract (what Stripe's retry loop sees):
 * - **413** — body over the size cap, rejected before verification.
 * - **400** — signature verification failed (missing/bad header, tampered
 *   body). Never echoes the body back.
 * - **200** — after ANY successfully verified event, including duplicates,
 *   stale/out-of-order events, unknown customers, and unhandled event types —
 *   Stripe must stop retrying once we have authenticated the delivery.
 * - **5xx** — an unexpected store/sync failure propagates to the framework
 *   error handler so Stripe retries the delivery later.
 */
import type { Hono } from 'hono';
import type { AppEnv } from '@lastshotlabs/slingshot-core';
import { errorResponse } from '@lastshotlabs/slingshot-core';
import type { ProviderEvent } from '../lib/provider';
import { syncProviderEvent } from '../lib/sync';
import type { BillingRouteDeps } from './_shared';
import { BILLING_UNAVAILABLE } from './_shared';

/** Default cap for webhook bodies, in bytes (1 MiB — mirrors slingshot-webhooks). */
export const DEFAULT_WEBHOOK_MAX_BODY_BYTES = 1 * 1024 * 1024;

/**
 * Read the request body with a hard byte cap. Returns `{ ok: false }` when the
 * limit is exceeded so the route can fail with HTTP 413 before any signature
 * work touches the payload.
 */
async function readBoundedBody(
  request: Request,
  maxBodyBytes: number,
): Promise<{ ok: true; body: string } | { ok: false }> {
  const declared = Number(request.headers.get('content-length') ?? 'NaN');
  if (Number.isFinite(declared) && declared > maxBodyBytes) {
    return { ok: false };
  }

  if (!request.body) return { ok: true, body: '' };

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!(value instanceof Uint8Array)) continue;
      total += value.byteLength;
      if (total > maxBodyBytes) {
        try {
          await reader.cancel();
        } catch {
          // already cancelled — ignore
        }
        return { ok: false };
      }
      chunks.push(value);
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // already released — ignore
    }
  }

  return { ok: true, body: Buffer.concat(chunks).toString('utf8') };
}

/**
 * Register the Stripe webhook endpoint directly on the app.
 *
 * Only called when billing is configured — a dormant package mounts no webhook
 * at all (POSTs to the path 404). Verified events flow through
 * `syncProviderEvent`; the outcome maps onto bus events:
 * - `entitlement` with `changed` → `billing:entitlement.changed` (the payload
 *   is the full derivation over ALL of the owner's stored rows, so it always
 *   equals what `GET <mountPath>/entitlement` reports afterwards).
 * - `payment` → `billing:payment.completed`.
 * - `noop` (duplicate / stale / unknown / ignored) → nothing.
 *
 * @param app - The framework app (plain Hono surface — kept off the OpenAPI doc).
 * @param deps - Route dependencies; `bus` carries the emitted `billing:*` events.
 */
export function registerWebhookRoute(app: Hono<AppEnv>, deps: BillingRouteDeps): void {
  const path = `${deps.config.mountPath}/webhooks/stripe`;
  const maxBodyBytes = deps.config.webhookMaxBodyBytes ?? DEFAULT_WEBHOOK_MAX_BODY_BYTES;

  app.post(path, async c => {
    const bodyResult = await readBoundedBody(c.req.raw, maxBodyBytes);
    if (!bodyResult.ok) {
      return errorResponse(c, `Webhook body exceeds maximum size (${maxBodyBytes} bytes)`, 413);
    }

    // Mounted ⇒ configured, so the provider always constructs; a null store
    // means the entity adapters never published — a server-side fault Stripe
    // should retry, not a client error.
    const provider = deps.provider();
    const store = deps.store();
    if (!provider || !store) {
      return errorResponse(c, BILLING_UNAVAILABLE, 503);
    }

    let event: ProviderEvent;
    try {
      event = provider.verifyAndParseWebhook(bodyResult.body, c.req.raw.headers);
    } catch {
      // Missing header, wrong secret, tampered body — all collapse to one
      // opaque 400. Never echo the payload or the verification error detail.
      return errorResponse(c, 'invalid_signature', 400);
    }

    // Deliberately NOT wrapped in try/catch: a store failure here must surface
    // as a 5xx (framework error path) so Stripe redelivers the event.
    const outcome = await syncProviderEvent(event, store, deps.config.plans);
    if (outcome.kind === 'entitlement' && outcome.changed) {
      deps.bus.emit('billing:entitlement.changed', {
        ownerId: outcome.ownerId,
        entitlement: outcome.entitlement,
      });
    } else if (outcome.kind === 'payment') {
      deps.bus.emit('billing:payment.completed', outcome.payload);
    }

    return c.json({ received: true }, 200);
  });
}
