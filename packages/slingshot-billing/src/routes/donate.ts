/**
 * `POST <mountPath>/donate` — start a hosted one-time donation checkout.
 *
 * Sign-in is required (spec Decision 5: no anonymous donations yet), so the
 * donation is attributed to the authenticated owner via the same lazily
 * created provider customer as subscriptions. The body names exactly one of a
 * configured preset or a custom amount validated against configured bounds.
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

/** Request body for the donation checkout route: exactly one selector. */
export const DonateRequestSchema = z.object({
  presetId: z
    .string()
    .min(1)
    .optional()
    .describe('Id of a configured donation preset. Mutually exclusive with customAmount.'),
  customAmount: z
    .number()
    .int()
    .positive()
    .optional()
    .describe(
      'Custom donation amount in the smallest currency unit (e.g. cents). ' +
        'Only accepted when donations.allowCustomAmount is configured; mutually exclusive with presetId.',
    ),
});

/**
 * Register `POST <mountPath>/donate` on the billing router.
 *
 * Requires an authenticated user. Responds 503 `billing_unavailable` while
 * dormant or when donations are disabled, 400 for a bad preset/amount
 * selection, and `{ url }` of the hosted donation checkout on success.
 *
 * @param router - The billing OpenAPI router mounted by the package.
 * @param deps - Route dependencies (config, dormant gate, provider/store getters).
 */
export function registerDonateRoute(router: BillingRouter, deps: BillingRouteDeps): void {
  const path = `${deps.config.mountPath}/donate`;
  router.use(path, deps.userAuth);

  router.openapi(
    withSecurity(
      createRoute({
        method: 'post',
        path,
        summary: 'Start donation checkout',
        description:
          'Creates a hosted one-time donation checkout session for a configured preset or a ' +
          'bounded custom amount, and returns its URL.',
        tags: BILLING_ROUTE_TAGS,
        request: {
          body: {
            content: { 'application/json': { schema: DonateRequestSchema } },
          },
        },
        responses: {
          200: {
            description: 'Hosted donation checkout session created.',
            content: { 'application/json': { schema: HostedSessionResponseSchema } },
          },
          400: {
            description: 'Invalid preset/amount selection.',
            content: { 'application/json': { schema: BillingErrorResponseSchema } },
          },
          401: {
            description: 'Not authenticated.',
            content: { 'application/json': { schema: BillingErrorResponseSchema } },
          },
          503: {
            description: 'Billing is not configured (dormant) or donations are disabled.',
            content: { 'application/json': { schema: BillingErrorResponseSchema } },
          },
        },
      }),
      { cookieAuth: [] },
      { userToken: [] },
    ),
    async c => {
      const donations = deps.config.donations;
      const ready = readyBilling(deps);
      if (!ready || !donations.enabled) return errorResponse(c, BILLING_UNAVAILABLE, 503);

      const { presetId, customAmount } = c.req.valid('json');
      if ((presetId === undefined) === (customAmount === undefined)) {
        return errorResponse(c, 'Provide exactly one of presetId or customAmount', 400);
      }

      let amount: number;
      if (presetId !== undefined) {
        const preset = donations.presets?.find(candidate => candidate.id === presetId);
        if (!preset) return errorResponse(c, `Unknown donation preset: ${presetId}`, 400);
        amount = preset.amount;
      } else {
        const bounds = donations.allowCustomAmount;
        if (!bounds) return errorResponse(c, 'Custom donation amounts are not enabled', 400);
        // The schema already guarantees a positive integer; enforce config bounds.
        const requested = customAmount as number;
        if (requested < bounds.min || requested > bounds.max) {
          return errorResponse(
            c,
            `customAmount must be between ${bounds.min} and ${bounds.max}`,
            400,
          );
        }
        amount = requested;
      }

      const customer = await ensureCustomerRow(ready.store, ready.provider, ownerRefFrom(c));
      const session = await ready.provider.createDonationCheckout({
        customer,
        amount,
        currency: donations.currency,
        ...(presetId !== undefined ? { presetId } : {}),
        urls: {
          successUrl: ready.urls.checkoutSuccess,
          cancelUrl: ready.urls.checkoutCancel,
        },
      });
      return c.json({ url: session.url }, 200);
    },
  );
}
