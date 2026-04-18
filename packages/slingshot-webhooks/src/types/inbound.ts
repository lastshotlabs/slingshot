import type { Context } from 'hono';

/**
 * Interface for verifying and processing inbound webhook payloads from external services.
 *
 * Each provider handles one external service (e.g. Stripe, GitHub). On receipt of a
 * `POST /webhooks/inbound/<provider>` request, the plugin calls `verify()`. If verification
 * passes, the payload is re-emitted as `webhook:inbound.<provider>` on the bus.
 *
 * @example
 * ```ts
 * import type { InboundProvider } from '@lastshotlabs/slingshot-webhooks';
 *
 * const stripeProvider: InboundProvider = {
 *   name: 'stripe',
 *   async verify(c, rawBody) {
 *     const sig = c.req.header('stripe-signature') ?? '';
 *     const valid = verifyStripeSignature(rawBody, sig, process.env.STRIPE_WEBHOOK_SECRET!);
 *     return valid
 *       ? { verified: true, payload: JSON.parse(rawBody) }
 *       : { verified: false, reason: 'Invalid signature' };
 *   },
 * };
 * ```
 */
export interface InboundProvider {
  /** Unique provider name used as the URL segment and bus event suffix (e.g. `'stripe'`). */
  name: string;
  /**
   * Verifies the inbound request and extracts the payload.
   * @param c - The Hono context for the inbound request (access headers, etc.).
   * @param rawBody - The raw request body string for signature verification.
   * @returns Verification result. When `verified: false`, the route returns 400.
   */
  verify(
    c: Context,
    rawBody: string,
  ): Promise<{
    /** Whether the signature/token is valid. */
    verified: boolean;
    /** The parsed payload to re-emit on the bus. */
    payload?: unknown;
    /** Human-readable reason string when verification fails. */
    reason?: string;
  }>;
}

declare module '@lastshotlabs/slingshot-core' {
  interface SlingshotEventMap {
    [key: `webhook:inbound.${string}`]: {
      provider: string;
      payload: unknown;
      rawBody: string;
    };
  }
}
