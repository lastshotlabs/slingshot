/**
 * `GET <mountPath>/entitlement` — the authenticated owner's current entitlement.
 *
 * DB-backed: the owner's stored `billing_subscriptions` rows feed the pure
 * `deriveEntitlement` best-row rule. Dormant billing answers the free
 * entitlement with 200 (not 503) — "you have no paid plan" is a complete,
 * correct answer even when no provider is configured.
 */
import { z } from 'zod';
import { createRoute, errorResponse, withSecurity } from '@lastshotlabs/slingshot-core';
import { getActorId } from '@lastshotlabs/slingshot-core';
import { deriveEntitlement } from '../lib/entitlement';
import { FREE_ENTITLEMENT } from '../public';
import type { BillingRouteDeps, BillingRouter } from './_shared';
import { BILLING_ROUTE_TAGS, BILLING_UNAVAILABLE, BillingErrorResponseSchema } from './_shared';

/** Response body mirroring the `Entitlement` shape from `src/public.ts`. */
export const EntitlementResponseSchema = z.object({
  plan: z.string().describe("Configured plan key, or 'free' when no paid subscription is active."),
  status: z
    .enum(['active', 'trialing', 'past_due', 'canceled', 'none'])
    .describe("Current subscription status, or 'none'."),
  currentPeriodEnd: z
    .string()
    .nullable()
    .describe('ISO timestamp when the current paid period ends, or null.'),
  cancelAtPeriodEnd: z
    .boolean()
    .describe('Whether the subscription is set to cancel at period end.'),
});

/**
 * Register `GET <mountPath>/entitlement` on the billing router.
 *
 * Requires an authenticated user; the entitlement is derived from that user's
 * stored subscription rows. Dormant billing short-circuits to the free
 * entitlement without touching the database.
 *
 * @param router - The billing OpenAPI router mounted by the package.
 * @param deps - Route dependencies (config, dormant gate, provider/store getters).
 */
export function registerEntitlementRoute(router: BillingRouter, deps: BillingRouteDeps): void {
  const path = `${deps.config.mountPath}/entitlement`;
  router.use(path, deps.userAuth);

  router.openapi(
    withSecurity(
      createRoute({
        method: 'get',
        path,
        summary: 'Get current entitlement',
        description:
          "Returns the authenticated user's current entitlement derived from stored " +
          'subscription state. Always the free entitlement while billing is dormant.',
        tags: BILLING_ROUTE_TAGS,
        responses: {
          200: {
            description: "The user's current entitlement.",
            content: { 'application/json': { schema: EntitlementResponseSchema } },
          },
          401: {
            description: 'Not authenticated.',
            content: { 'application/json': { schema: BillingErrorResponseSchema } },
          },
          503: {
            description: 'Billing is configured but its storage is not available.',
            content: { 'application/json': { schema: BillingErrorResponseSchema } },
          },
        },
      }),
      { cookieAuth: [] },
      { userToken: [] },
    ),
    async c => {
      if (!deps.configured) return c.json({ ...FREE_ENTITLEMENT }, 200);

      const store = deps.store();
      if (!store) return errorResponse(c, BILLING_UNAVAILABLE, 503);

      const ownerId = getActorId(c) as string;
      const rows = await store.listSubscriptionsByOwner(ownerId);
      return c.json({ ...deriveEntitlement(rows, deps.config.plans) }, 200);
    },
  );
}
