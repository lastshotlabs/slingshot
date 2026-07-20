/**
 * Provider-agnostic webhook sync: a normalized `ProviderEvent` + a
 * `BillingStore` → idempotent, order-tolerant persistence + a `SyncOutcome`
 * telling the caller (the Phase 4 webhook route) which event to emit.
 *
 * Invariants this file owns:
 * - **Idempotent**: replaying the same event is a no-op (`changed: false` for
 *   subscriptions, `'duplicate-payment'` for payments). Stripe retries until
 *   it sees a 200, so every path here must tolerate a re-run.
 * - **Order-tolerant**: subscription events strictly OLDER than the stored
 *   row's `providerEventCreated` are DROPPED (`'stale-event'`) — Stripe does
 *   not guarantee delivery order. Equal timestamps are applied (Stripe's
 *   `created` has 1s granularity; an equal-timestamp replay is the idempotent
 *   case, not a stale one).
 * - **Payments never touch entitlement**: a donation inserts a
 *   `billing_payments` row and nothing else.
 */
import type { Entitlement } from '../public';
import type { PlanConfig } from '../types/config';
import { deriveEntitlement, entitlementEquals, planKeyForPrice } from './entitlement';
import type { ProviderEvent } from './provider';
import type { BillingStore, BillingSubscriptionRow } from './store';

/** Why a sync run produced no emittable result. */
export type SyncNoopReason =
  /** `kind: 'ignored'` events — acknowledged without side effects. */
  | 'ignored-event'
  /** Event older than the stored row's `providerEventCreated` — dropped. */
  | 'stale-event'
  /** No `billing_customers` row for the event's provider customer id. */
  | 'unknown-customer'
  /** `subscription.deleted` for a subscription that was never stored. */
  | 'unknown-subscription'
  /** Payment already recorded for this `providerPaymentId`. */
  | 'duplicate-payment';

/**
 * What a sync run did. The webhook route switches on `kind`:
 * - `'entitlement'` + `changed: true` → emit `billing:entitlement.changed`.
 * - `'payment'` → emit `billing:payment.completed` with `payload`.
 * - `'noop'` → acknowledge (200) and emit nothing.
 */
export type SyncOutcome =
  | {
      readonly kind: 'entitlement';
      readonly ownerId: string;
      readonly entitlement: Entitlement;
      /** False when the recomputed entitlement equals the previous one. */
      readonly changed: boolean;
    }
  | {
      readonly kind: 'payment';
      readonly payload: {
        readonly ownerId: string | null;
        readonly amount: number;
        readonly currency: string;
        readonly presetId?: string;
      };
    }
  | { readonly kind: 'noop'; readonly reason: SyncNoopReason };

/**
 * Apply one normalized provider event to storage.
 *
 * @param event - The verified, normalized event from `verifyAndParseWebhook`.
 * @param store - The billing storage seam (entity-backed in production).
 * @param plans - Configured plans, for price → plan mapping and entitlement.
 * @returns The outcome the caller translates into bus events (or nothing).
 */
export async function syncProviderEvent(
  event: ProviderEvent,
  store: BillingStore,
  plans: readonly PlanConfig[],
): Promise<SyncOutcome> {
  switch (event.kind) {
    case 'subscription.updated':
      return syncSubscriptionUpdated(event, store, plans);
    case 'subscription.deleted':
      return syncSubscriptionDeleted(event, store, plans);
    case 'payment.completed':
      return syncPaymentCompleted(event, store);
    case 'ignored':
      return { kind: 'noop', reason: 'ignored-event' };
  }
}

/** Recompute the owner's entitlement and report whether it changed. */
async function recomputeEntitlement(
  ownerId: string,
  before: Entitlement,
  store: BillingStore,
  plans: readonly PlanConfig[],
): Promise<SyncOutcome> {
  const entitlement = deriveEntitlement(await store.listSubscriptionsByOwner(ownerId), plans);
  return {
    kind: 'entitlement',
    ownerId,
    entitlement,
    changed: !entitlementEquals(before, entitlement),
  };
}

async function syncSubscriptionUpdated(
  event: Extract<ProviderEvent, { kind: 'subscription.updated' }>,
  store: BillingStore,
  plans: readonly PlanConfig[],
): Promise<SyncOutcome> {
  const existing = await store.getSubscriptionByProviderSubscriptionId(
    event.providerSubscriptionId,
  );
  if (existing && event.eventCreated < existing.providerEventCreated) {
    return { kind: 'noop', reason: 'stale-event' };
  }

  // Attribute the subscription to an owner: the stored row already knows, a
  // new one resolves through the customer mapping written at checkout time.
  const ownerId =
    existing?.ownerId ??
    (await store.findCustomerByProviderCustomerId(event.providerCustomerId))?.ownerId;
  if (!ownerId) return { kind: 'noop', reason: 'unknown-customer' };

  // Partial-event merge: normalizers emit `priceId: null` when the raw event
  // carried no line item (checkout-session fallback, invoice.payment_failed).
  // A null must not clobber a stored price — a real plan change always names
  // the new price. Same for `currentPeriodEnd`.
  const priceId = event.priceId ?? existing?.priceId ?? null;
  const currentPeriodEnd = event.currentPeriodEnd ?? existing?.currentPeriodEnd ?? null;

  const before = deriveEntitlement(await store.listSubscriptionsByOwner(ownerId), plans);

  const row: Omit<BillingSubscriptionRow, 'id'> = {
    ownerId,
    providerSubscriptionId: event.providerSubscriptionId,
    plan: planKeyForPrice(priceId, plans),
    status: event.status,
    priceId,
    currentPeriodEnd,
    cancelAtPeriodEnd: event.cancelAtPeriodEnd,
    providerEventCreated: event.eventCreated,
  };
  if (existing) {
    await store.updateSubscription(existing.id, row);
  } else {
    await store.createSubscription(row);
  }

  return recomputeEntitlement(ownerId, before, store, plans);
}

async function syncSubscriptionDeleted(
  event: Extract<ProviderEvent, { kind: 'subscription.deleted' }>,
  store: BillingStore,
  plans: readonly PlanConfig[],
): Promise<SyncOutcome> {
  const existing = await store.getSubscriptionByProviderSubscriptionId(
    event.providerSubscriptionId,
  );
  // Nothing stored ⇒ nothing to cancel; acknowledge and move on.
  if (!existing) return { kind: 'noop', reason: 'unknown-subscription' };
  if (event.eventCreated < existing.providerEventCreated) {
    return { kind: 'noop', reason: 'stale-event' };
  }

  const before = deriveEntitlement(await store.listSubscriptionsByOwner(existing.ownerId), plans);
  await store.updateSubscription(existing.id, {
    status: 'canceled',
    providerEventCreated: event.eventCreated,
  });

  return recomputeEntitlement(existing.ownerId, before, store, plans);
}

async function syncPaymentCompleted(
  event: Extract<ProviderEvent, { kind: 'payment.completed' }>,
  store: BillingStore,
): Promise<SyncOutcome> {
  // Idempotent insert: Stripe retries deliveries, so a second arrival of the
  // same payment id is expected traffic, not an error.
  const duplicate = await store.findPaymentByProviderPaymentId(event.providerPaymentId);
  if (duplicate) return { kind: 'noop', reason: 'duplicate-payment' };

  // Donations may be anonymous: no provider customer (or one billing never
  // stored) simply yields a null owner — the row is still recorded.
  const ownerId = event.providerCustomerId
    ? ((await store.findCustomerByProviderCustomerId(event.providerCustomerId))?.ownerId ?? null)
    : null;

  await store.createPayment({
    ownerId,
    providerPaymentId: event.providerPaymentId,
    kind: 'donation',
    amount: event.amount,
    currency: event.currency,
    presetId: event.presetId,
    status: 'succeeded',
  });

  return {
    kind: 'payment',
    payload: {
      ownerId,
      amount: event.amount,
      currency: event.currency,
      ...(event.presetId !== null ? { presetId: event.presetId } : {}),
    },
  };
}
