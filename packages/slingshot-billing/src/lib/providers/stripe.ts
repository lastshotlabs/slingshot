/**
 * Stripe implementation of `BillingProvider`.
 *
 * The one file allowed to import the Stripe SDK. Everything it returns is
 * billing's own domain vocabulary (`ProviderEvent`, `HostedSession`, ...) — no
 * Stripe type crosses the seam. `normalizeStripeEvent` is exported separately
 * (and typed structurally) so tests can pin the event mapping with minimal
 * fixture objects, no SDK mocking required.
 *
 * The SDK client is constructed LAZILY on first use: `createStripeProvider` is
 * only reachable behind the package's dormant gate (`isBillingConfigured`),
 * and building the provider object itself performs no I/O and no SDK init.
 */
import { createHash, createHmac } from 'node:crypto';
import Stripe from 'stripe';
import type { StripeProviderConfig } from '../../types/config';
import type {
  BillingProvider,
  DonationCheckoutInput,
  HostedSession,
  OwnerRef,
  PortalInput,
  ProviderCustomer,
  ProviderEvent,
  SubscriptionCheckoutInput,
  SubscriptionStatus,
} from '../provider';

/**
 * The structural slice of a Stripe webhook event `normalizeStripeEvent` reads.
 * Deliberately NOT the SDK's `Stripe.Event`: tests build these as plain
 * objects, and the mapping stays honest about which fields it depends on.
 */
export interface StripeEventLike {
  /** Raw Stripe event type, e.g. `'customer.subscription.updated'`. */
  readonly type: string;
  /** Stripe event creation time (epoch seconds, 1s granularity). */
  readonly created: number;
  /** The event payload; `object` is the affected Stripe resource. */
  readonly data: { readonly object: Record<string, unknown> };
}

/**
 * Synchronous HMAC crypto provider for webhook verification.
 *
 * Bun resolves the Stripe SDK's WORKER build (the package.json `bun` export
 * condition), whose default `SubtleCryptoProvider` supports only async
 * verification — the sync `constructEvent` throws. `verifyAndParseWebhook` is
 * a synchronous seam, and Bun implements `node:crypto` natively, so this
 * mirrors the SDK's own `NodeCryptoProvider` and is passed explicitly to
 * `constructEvent`. Exported for tests (`generateTestHeaderString` needs the
 * same provider under Bun).
 */
export const stripeSyncCryptoProvider: Stripe.CryptoProvider = {
  computeHMACSignature(payload: string, secret: string): string {
    return createHmac('sha256', secret).update(payload, 'utf8').digest('hex');
  },
  async computeHMACSignatureAsync(payload: string, secret: string): Promise<string> {
    return createHmac('sha256', secret).update(payload, 'utf8').digest('hex');
  },
  async computeSHA256Async(data: Uint8Array): Promise<Uint8Array> {
    return new Uint8Array(createHash('sha256').update(data).digest());
  },
};

/** Read `x` or `x.id` from a field that Stripe returns as `string | object | null`. */
function idOf(value: unknown): string | null {
  if (typeof value === 'string' && value.length > 0) return value;
  if (typeof value === 'object' && value !== null) {
    const id = (value as { id?: unknown }).id;
    if (typeof id === 'string' && id.length > 0) return id;
  }
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/**
 * Collapse Stripe's subscription status vocabulary onto billing's normalized
 * one. `unpaid`/`incomplete` are payment trouble (⇒ `past_due`); anything
 * dead or unknown is `canceled` — an unknown status must never grant access.
 */
function normalizeStatus(raw: unknown): SubscriptionStatus {
  switch (raw) {
    case 'active':
      return 'active';
    case 'trialing':
      return 'trialing';
    case 'past_due':
    case 'unpaid':
    case 'incomplete':
      return 'past_due';
    default:
      return 'canceled';
  }
}

/** First line item of a subscription payload, if present. */
function firstItem(subscription: Record<string, unknown>): Record<string, unknown> | null {
  const items = subscription.items;
  if (!isRecord(items)) return null;
  const data = items.data;
  if (!Array.isArray(data)) return null;
  const first: unknown = data[0];
  return isRecord(first) ? first : null;
}

/** Price id from the subscription's first line item, or null. */
function priceIdOf(subscription: Record<string, unknown>): string | null {
  const item = firstItem(subscription);
  return item ? idOf(item.price) : null;
}

/**
 * Period end as ISO, or null. Read from the subscription root (API versions
 * before 2025-03 "Basil") falling back to the first line item (Basil moved
 * `current_period_end` onto subscription items).
 */
function currentPeriodEndOf(subscription: Record<string, unknown>): string | null {
  const direct = subscription.current_period_end;
  const fromItem = firstItem(subscription)?.current_period_end;
  const epoch =
    typeof direct === 'number' ? direct : typeof fromItem === 'number' ? fromItem : null;
  return epoch === null ? null : new Date(epoch * 1000).toISOString();
}

/** Build a full `subscription.updated` event from a subscription payload. */
function subscriptionUpdatedFrom(
  subscription: Record<string, unknown>,
  eventCreated: number,
): ProviderEvent {
  const providerSubscriptionId = idOf(subscription.id);
  if (!providerSubscriptionId) return { kind: 'ignored', eventCreated };
  return {
    kind: 'subscription.updated',
    providerCustomerId: idOf(subscription.customer) ?? '',
    providerSubscriptionId,
    priceId: priceIdOf(subscription),
    status: normalizeStatus(subscription.status),
    currentPeriodEnd: currentPeriodEndOf(subscription),
    cancelAtPeriodEnd: subscription.cancel_at_period_end === true,
    eventCreated,
  };
}

/** Normalize a `checkout.session.completed` payload (subscription or payment mode). */
function checkoutSessionCompletedFrom(
  session: Record<string, unknown>,
  eventCreated: number,
): ProviderEvent {
  if (session.mode === 'subscription') {
    // With `subscription` expanded, the full fields are right here. When it is
    // only an id string, emit a partial event (priceId/currentPeriodEnd null —
    // `lib/sync.ts` preserves stored values on null); the concurrent
    // `customer.subscription.created` webhook carries the authoritative fields.
    if (isRecord(session.subscription)) {
      return subscriptionUpdatedFrom(session.subscription, eventCreated);
    }
    const providerSubscriptionId = idOf(session.subscription);
    if (!providerSubscriptionId) return { kind: 'ignored', eventCreated };
    return {
      kind: 'subscription.updated',
      providerCustomerId: idOf(session.customer) ?? '',
      providerSubscriptionId,
      priceId: null,
      status: 'active',
      currentPeriodEnd: null,
      cancelAtPeriodEnd: false,
      eventCreated,
    };
  }

  if (session.mode === 'payment') {
    // Prefer the payment intent as the stable payment id; the session id is
    // the fallback (also unique, also retried with the same value).
    const providerPaymentId = idOf(session.payment_intent) ?? idOf(session.id);
    if (!providerPaymentId) return { kind: 'ignored', eventCreated };
    const metadata = isRecord(session.metadata) ? session.metadata : {};
    return {
      kind: 'payment.completed',
      providerCustomerId: idOf(session.customer),
      providerPaymentId,
      amount: typeof session.amount_total === 'number' ? session.amount_total : 0,
      currency: typeof session.currency === 'string' ? session.currency : '',
      presetId: typeof metadata.presetId === 'string' ? metadata.presetId : null,
      eventCreated,
    };
  }

  return { kind: 'ignored', eventCreated };
}

/** Normalize an `invoice.payment_failed` payload into a `past_due` update. */
function invoicePaymentFailedFrom(
  invoice: Record<string, unknown>,
  eventCreated: number,
): ProviderEvent {
  // Pre-Basil invoices carry `subscription` at the root; Basil moved it to
  // `parent.subscription_details.subscription`.
  const parent = isRecord(invoice.parent) ? invoice.parent : {};
  const subscriptionDetails = isRecord(parent.subscription_details)
    ? parent.subscription_details
    : {};
  const providerSubscriptionId =
    idOf(invoice.subscription) ?? idOf(subscriptionDetails.subscription);
  // A one-off invoice with no subscription is not billing's concern.
  if (!providerSubscriptionId) return { kind: 'ignored', eventCreated };
  return {
    kind: 'subscription.updated',
    providerCustomerId: idOf(invoice.customer) ?? '',
    providerSubscriptionId,
    // Partial event: no line-item price here — sync preserves the stored one.
    priceId: null,
    status: 'past_due',
    currentPeriodEnd: null,
    cancelAtPeriodEnd: false,
    eventCreated,
  };
}

/**
 * Map a verified Stripe event onto billing's normalized `ProviderEvent`.
 *
 * Handled types:
 * - `customer.subscription.created` / `.updated` → `subscription.updated`
 * - `customer.subscription.deleted` → `subscription.deleted`
 * - `checkout.session.completed` (mode `subscription`) → `subscription.updated`
 * - `checkout.session.completed` (mode `payment`) → `payment.completed`
 * - `invoice.payment_failed` → `subscription.updated` with status `past_due`
 * - everything else → `ignored`
 *
 * @param event - A (signature-verified) Stripe event, structurally typed.
 * @returns The normalized event `lib/sync.ts` consumes.
 */
export function normalizeStripeEvent(event: StripeEventLike): ProviderEvent {
  const object = event.data.object;
  switch (event.type) {
    case 'customer.subscription.created':
    case 'customer.subscription.updated':
      return subscriptionUpdatedFrom(object, event.created);
    case 'customer.subscription.deleted': {
      const providerSubscriptionId = idOf(object.id);
      if (!providerSubscriptionId) return { kind: 'ignored', eventCreated: event.created };
      return {
        kind: 'subscription.deleted',
        providerCustomerId: idOf(object.customer) ?? '',
        providerSubscriptionId,
        eventCreated: event.created,
      };
    }
    case 'checkout.session.completed':
      return checkoutSessionCompletedFrom(object, event.created);
    case 'invoice.payment_failed':
      return invoicePaymentFailedFrom(object, event.created);
    default:
      return { kind: 'ignored', eventCreated: event.created };
  }
}

/**
 * Create the Stripe `BillingProvider`.
 *
 * Stateless beyond the lazily-constructed SDK client; persistence and
 * entitlement logic live in the package. Customer dedupe is deliberately NOT
 * here: the routes check `billing_customers` first and call `ensureCustomer`
 * only when no mapping exists, so this implementation always creates.
 *
 * @param config - Validated Stripe credentials from the package config.
 * @returns A `BillingProvider` speaking only billing's domain types.
 */
export function createStripeProvider(config: StripeProviderConfig): BillingProvider {
  // Lazy: no SDK construction (and no I/O) until a method actually needs it.
  let client: Stripe | null = null;
  const getClient = (): Stripe => {
    client ??= new Stripe(config.secretKey, {
      // The SDK types pin `apiVersion` to the latest literal; the config
      // accepts any pinned version string by design.
      ...(config.apiVersion ? { apiVersion: config.apiVersion as Stripe.LatestApiVersion } : {}),
    });
    return client;
  };

  return {
    name: 'stripe',

    async ensureCustomer(owner: OwnerRef): Promise<ProviderCustomer> {
      const created = await getClient().customers.create({
        ...(owner.email ? { email: owner.email } : {}),
        // Traceability from the Stripe dashboard back to the app owner.
        metadata: { slingshotOwnerId: owner.ownerId },
      });
      return { providerCustomerId: created.id };
    },

    async createSubscriptionCheckout(input: SubscriptionCheckoutInput): Promise<HostedSession> {
      const session = await getClient().checkout.sessions.create({
        mode: 'subscription',
        customer: input.customer.providerCustomerId,
        // The price is always the CONFIGURED one — callers pass a plan key to
        // the route, never a price. See the config schema.
        line_items: [{ price: input.priceId, quantity: 1 }],
        ...(input.trialDays ? { subscription_data: { trial_period_days: input.trialDays } } : {}),
        success_url: input.urls.successUrl,
        cancel_url: input.urls.cancelUrl,
      });
      return toHostedSession(session.url);
    },

    async createDonationCheckout(input: DonationCheckoutInput): Promise<HostedSession> {
      const session = await getClient().checkout.sessions.create({
        mode: 'payment',
        ...(input.customer ? { customer: input.customer.providerCustomerId } : {}),
        line_items: [
          {
            quantity: 1,
            price_data: {
              currency: input.currency,
              unit_amount: input.amount,
              product_data: { name: 'Donation' },
            },
          },
        ],
        // Read back by the webhook normalizer (`session.metadata.presetId`).
        metadata: {
          billingKind: 'donation',
          ...(input.presetId ? { presetId: input.presetId } : {}),
        },
        success_url: input.urls.successUrl,
        cancel_url: input.urls.cancelUrl,
      });
      return toHostedSession(session.url);
    },

    async createPortalSession(input: PortalInput): Promise<HostedSession> {
      const session = await getClient().billingPortal.sessions.create({
        customer: input.customer.providerCustomerId,
        return_url: input.returnUrl,
      });
      return toHostedSession(session.url);
    },

    verifyAndParseWebhook(rawBody: string, headers: Headers): ProviderEvent {
      const signature = headers.get('stripe-signature');
      if (!signature) {
        throw new Error('[slingshot-billing] Missing stripe-signature header');
      }
      // Throws on any signature mismatch or malformed payload — the caller
      // translates that into a 400. The raw, unparsed bytes MUST reach this
      // call (the webhook route declares no request.body schema for exactly
      // this reason).
      const event = getClient().webhooks.constructEvent(
        rawBody,
        signature,
        config.webhookSecret,
        undefined,
        stripeSyncCryptoProvider,
      );
      return normalizeStripeEvent(event as unknown as StripeEventLike);
    },
  };
}

/** Assert Stripe actually returned a hosted URL (typed nullable in the SDK). */
function toHostedSession(url: string | null | undefined): HostedSession {
  if (!url) {
    throw new Error('[slingshot-billing] Stripe returned a session without a hosted url');
  }
  return { url };
}
