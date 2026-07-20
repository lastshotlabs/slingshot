/**
 * `POST <mountPath>/portal` — open the provider's self-service billing portal.
 *
 * Portal access never creates a provider customer: an owner who has never
 * checked out has nothing to manage, so a missing `billing_customers` row is a
 * 404 rather than a lazy create.
 */
import { createRoute, errorResponse, withSecurity } from '@lastshotlabs/slingshot-core';
import { getActorId } from '@lastshotlabs/slingshot-core';
import type { BillingRouteDeps, BillingRouter } from './_shared';
import {
  BILLING_ROUTE_TAGS,
  BILLING_UNAVAILABLE,
  BillingErrorResponseSchema,
  HostedSessionResponseSchema,
  readyBilling,
} from './_shared';

/**
 * Register `POST <mountPath>/portal` on the billing router.
 *
 * Requires an authenticated user. Responds 503 `billing_unavailable` while
 * dormant, 404 when the owner has no billing customer yet, and `{ url }` of
 * the hosted portal session on success.
 *
 * @param router - The billing OpenAPI router mounted by the package.
 * @param deps - Route dependencies (config, dormant gate, provider/store getters).
 */
export function registerPortalRoute(router: BillingRouter, deps: BillingRouteDeps): void {
  const path = `${deps.config.mountPath}/portal`;
  router.use(path, deps.userAuth);

  router.openapi(
    withSecurity(
      createRoute({
        method: 'post',
        path,
        summary: 'Open billing portal',
        description:
          'Creates a hosted self-service billing portal session for the authenticated user and ' +
          'returns its URL. Requires an existing billing customer (created by a prior checkout).',
        tags: BILLING_ROUTE_TAGS,
        responses: {
          200: {
            description: 'Hosted portal session created.',
            content: { 'application/json': { schema: HostedSessionResponseSchema } },
          },
          401: {
            description: 'Not authenticated.',
            content: { 'application/json': { schema: BillingErrorResponseSchema } },
          },
          404: {
            description: 'The user has no billing customer yet.',
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

      const ownerId = getActorId(c) as string;
      const customer = await ready.store.findCustomerByOwnerId(ownerId);
      if (!customer) return errorResponse(c, 'No billing customer for this user', 404);

      const session = await ready.provider.createPortalSession({
        customer: { providerCustomerId: customer.providerCustomerId },
        returnUrl: ready.urls.portalReturn,
      });
      return c.json({ url: session.url }, 200);
    },
  );
}
