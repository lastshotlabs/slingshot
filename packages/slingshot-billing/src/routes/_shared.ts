/**
 * Shared plumbing for billing's client-facing routes.
 *
 * Every route is registered through the framework's typed OpenAPI mechanism
 * (`createRoute` + `router.openapi`, precedent: `slingshot-auth/src/routes/*`,
 * `slingshot-webhooks/src/routes/inbound.ts`) so consuming apps' generated
 * OpenAPI contracts — and Snapshot clients built from them — include the
 * billing surface.
 *
 * Routes receive their runtime dependencies through {@link BillingRouteDeps}:
 * the frozen config, the dormant flag, the auth middleware, and *getters* for
 * the provider and store. Getters, because the store only materializes once the
 * framework publishes the billing entity adapters — resolving at request time
 * keeps route registration order-independent from adapter wiring.
 */
import type { Context, MiddlewareHandler } from 'hono';
import { z } from 'zod';
import type { AppEnv, SlingshotEventBus, createRouter } from '@lastshotlabs/slingshot-core';
import { getActor } from '@lastshotlabs/slingshot-core';
import type { BillingProvider, OwnerRef, ProviderCustomer } from '../lib/provider';
import type { BillingStore } from '../lib/store';
import type { BillingPackageConfig } from '../types/config';

/** OpenAPI tag applied to every billing route. */
export const BILLING_ROUTE_TAGS = ['Billing'];

/**
 * The dormant-gate error token (binding, from the billing spec): returned with
 * HTTP 503 whenever a billing action is requested but no provider is usable.
 */
export const BILLING_UNAVAILABLE = 'billing_unavailable';

/** Router type billing routes register on (`createRouter()` from slingshot-core). */
export type BillingRouter = ReturnType<typeof createRouter>;

/** Error body shape produced by `errorResponse` (slingshot-core convention). */
export const BillingErrorResponseSchema = z.object({
  error: z.string().describe('Machine-readable error token or human-readable message.'),
  requestId: z
    .string()
    .optional()
    .describe('Framework request id echoed for support/debugging correlation.'),
});

/** Response body carrying a hosted provider page the client redirects to. */
export const HostedSessionResponseSchema = z.object({
  url: z
    .string()
    .describe('Hosted provider page URL (Checkout / Billing Portal) to redirect the user to.'),
});

/**
 * Runtime dependencies the billing routes close over.
 *
 * Built by `createBillingPackage()` during `setupRoutes`; tests construct one
 * directly (with a `FakeBillingProvider` and an in-memory store) to exercise
 * handlers without a payment SDK.
 */
export interface BillingRouteDeps {
  /** Frozen, validated package configuration. */
  readonly config: BillingPackageConfig;
  /** The dormant gate: false ⇒ every action route answers 503 {@link BILLING_UNAVAILABLE}. */
  readonly configured: boolean;
  /** Auth middleware enforcing an authenticated user actor (401 otherwise). */
  readonly userAuth: MiddlewareHandler<AppEnv>;
  /** The instance event bus — the webhook route emits `billing:*` events on it. */
  readonly bus: SlingshotEventBus;
  /** Current provider, or null while dormant / not yet constructed. */
  provider(): BillingProvider | null;
  /** Current store, or null until the billing entity adapters are published. */
  store(): BillingStore | null;
}

/** Everything an action route needs to proceed; null ⇒ answer 503. */
export interface ReadyBilling {
  readonly provider: BillingProvider;
  readonly store: BillingStore;
  readonly urls: NonNullable<BillingPackageConfig['urls']>;
}

/**
 * Collapse the "can billing act right now?" checks into one answer: configured
 * provider, resolvable store, and redirect URLs present. Any missing piece maps
 * to the same client-facing 503 {@link BILLING_UNAVAILABLE} — a client cannot
 * meaningfully distinguish "no Stripe keys" from "adapters not wired".
 */
export function readyBilling(deps: BillingRouteDeps): ReadyBilling | null {
  if (!deps.configured) return null;
  const provider = deps.provider();
  const store = deps.store();
  const urls = deps.config.urls;
  if (!provider || !store || !urls) return null;
  return { provider, store, urls };
}

/**
 * Build the {@link OwnerRef} for the authenticated request actor.
 *
 * `userAuth` has already guaranteed a user actor with a non-null id; the email
 * rides along from identity claims when present so the provider customer gets
 * a human-recognizable handle.
 */
export function ownerRefFrom(c: Context<AppEnv>): OwnerRef {
  const actor = getActor(c);
  const email = actor.claims['email'];
  return {
    ownerId: actor.id as string,
    ...(typeof email === 'string' && email.length > 0 ? { email } : {}),
  };
}

/**
 * Lazy, exactly-once customer creation (spec Decision: create on first
 * checkout only). A stored `billing_customers` row short-circuits without any
 * provider call; otherwise the provider customer is created and persisted so
 * every later checkout / portal request reuses the same provider customer id.
 */
export async function ensureCustomerRow(
  store: BillingStore,
  provider: BillingProvider,
  owner: OwnerRef,
): Promise<ProviderCustomer> {
  const existing = await store.findCustomerByOwnerId(owner.ownerId);
  if (existing) return { providerCustomerId: existing.providerCustomerId };

  const created = await provider.ensureCustomer(owner);
  await store.createCustomer({
    ownerId: owner.ownerId,
    provider: provider.name,
    providerCustomerId: created.providerCustomerId,
  });
  return created;
}
