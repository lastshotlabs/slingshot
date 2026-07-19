/**
 * Public contract for `slingshot-billing`.
 *
 * Consumers (e.g. an app mapping plans onto its own domain) read the entitlement
 * through the typed capability handle rather than reaching into package state.
 * The package publishes the implementation via `capabilities.provides`; consumers
 * resolve it with `ctx.capabilities.require(BillingEntitlementCap)`.
 */
import { definePackageContract } from '@lastshotlabs/slingshot-core';

/** Provider-owned contract object for `slingshot-billing`. */
export const Billing = definePackageContract('slingshot-billing');

/** Normalized subscription status surfaced to consuming apps. */
export type EntitlementStatus = 'active' | 'trialing' | 'past_due' | 'canceled' | 'none';

/**
 * The single app-agnostic answer billing provides: what an owner has paid for
 * right now. Apps map `plan` onto their own domain (a spend tier, a perk, ...).
 * When nothing is active this is `{ plan: 'free', status: 'none', ... }`.
 */
export interface Entitlement {
  /** Configured plan key, or `'free'` when no paid subscription is active. */
  readonly plan: string;
  /** Current subscription status, or `'none'`. */
  readonly status: EntitlementStatus;
  /** ISO timestamp when the current paid period ends, or null. */
  readonly currentPeriodEnd: string | null;
  /** Whether the subscription is set to cancel at period end. */
  readonly cancelAtPeriodEnd: boolean;
}

/**
 * Capability resolving an owner's current {@link Entitlement}. Consumers call
 * `ctx.capabilities.require(BillingEntitlementCap)(ownerId)` for an on-demand
 * read; the same value is pushed via the `billing:entitlement.changed` event.
 */
export const BillingEntitlementCap =
  Billing.capability<(ownerId: string) => Promise<Entitlement>>('entitlement');

/** The entitlement returned when billing is dormant or the owner has no subscription. */
export const FREE_ENTITLEMENT: Entitlement = Object.freeze({
  plan: 'free',
  status: 'none',
  currentPeriodEnd: null,
  cancelAtPeriodEnd: false,
});
