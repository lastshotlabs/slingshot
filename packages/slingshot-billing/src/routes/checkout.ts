/**
 * `POST <mountPath>/checkout` — start a hosted subscription checkout.
 *
 * The client sends a configured plan KEY; the provider price id is always
 * server-selected from config (binding decision: a price id must never be
 * client-supplied). The owner's provider customer is created lazily, exactly
 * once, on their first checkout.
 */
import { z } from 'zod';
import { createRoute, errorResponse, withSecurity } from '@lastshotlabs/slingshot-core';
import type { BillingRouteDeps, BillingRouter } from './_shared';
import {
  BILLING_ROUTE_TAGS,
  BILLING_UNAVAILABLE,
  BillingErrorResponseSchema,
  HostedSessionResponseSchema,
  ensureCustomerRow,
  ownerRefFrom,
  readyBilling,
} from './_shared';

/** Request body for the subscription checkout route. */
export const CheckoutRequestSchema = z.object({
  plan: z
    .string()
    .min(1)
    .describe("Configured plan key to subscribe to (e.g. 'pro'). Never a provider price id."),
});

/**
 * Register `POST <mountPath>/checkout` on the billing router.
 *
 * Requires an authenticated user (`userAuth`); the authenticated user id is
 * the billing owner. Responds 503 `billing_unavailable` while dormant, 400 for
 * an unknown plan key, and `{ url }` of the hosted checkout page on success.
 *
 * @param router - The billing OpenAPI router mounted by the package.
 * @param deps - Route dependencies (config, dormant gate, provider/store getters).
 */
export function registerCheckoutRoute(router: BillingRouter, deps: BillingRouteDeps): void {
  const path = `${deps.config.mountPath}/checkout`;
  router.use(path, deps.userAuth);

  router.openapi(
    withSecurity(
      createRoute({
        method: 'post',
        path,
        summary: 'Start subscription checkout',
        description:
          'Creates a hosted provider checkout session for a configured plan and returns its URL. ' +
          'The provider customer for the authenticated user is created lazily on first use.',
        tags: BILLING_ROUTE_TAGS,
        request: {
          body: {
            content: { 'application/json': { schema: CheckoutRequestSchema } },
          },
        },
        responses: {
          200: {
            description: 'Hosted checkout session created.',
            content: { 'application/json': { schema: HostedSessionResponseSchema } },
          },
          400: {
            description: 'Unknown plan key.',
            content: { 'application/json': { schema: BillingErrorResponseSchema } },
          },
          401: {
            description: 'Not authenticated.',
            content: { 'application/json': { schema: BillingErrorResponseSchema } },
          },
          503: {
            description: 'Billing is not configured (dormant).',
            content: { 'application/json': { schema: BillingErrorResponseSchema } },
          },
        },
      }),
      { cookieAuth: [] },
      { userToken: [] },
    ),
    async c => {
      const ready = readyBilling(deps);
      if (!ready) return errorResponse(c, BILLING_UNAVAILABLE, 503);

      const { plan } = c.req.valid('json');
      const planConfig = deps.config.plans.find(candidate => candidate.key === plan);
      if (!planConfig) return errorResponse(c, `Unknown plan: ${plan}`, 400);

      const customer = await ensureCustomerRow(ready.store, ready.provider, ownerRefFrom(c));
      const session = await ready.provider.createSubscriptionCheckout({
        customer,
        priceId: planConfig.priceId,
        ...(planConfig.trialDays !== undefined ? { trialDays: planConfig.trialDays } : {}),
        urls: {
          successUrl: ready.urls.checkoutSuccess,
          cancelUrl: ready.urls.checkoutCancel,
        },
      });
      return c.json({ url: session.url }, 200);
    },
  );
}
