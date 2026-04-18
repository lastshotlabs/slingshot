import { z } from 'zod';
import { createRoute, createRouter, errorResponse } from '@lastshotlabs/slingshot-core';
import type { SlingshotEventBus } from '@lastshotlabs/slingshot-core';
import type { InboundProvider } from '../types/inbound';
import { WEBHOOK_ROUTE_TAGS, WebhookErrorResponseSchema } from './_shared';

const InboundResponse = z.object({ received: z.boolean() });

const inboundRoute = createRoute({
  method: 'post',
  path: '/{provider}',
  summary: 'Receive inbound webhook',
  description:
    'Receives and verifies an inbound webhook from a third-party provider, then emits a bus event.',
  tags: WEBHOOK_ROUTE_TAGS,
  request: {
    params: z.object({
      provider: z.string().describe('Inbound webhook provider name'),
    }),
  },
  responses: {
    200: {
      description: 'Webhook received',
      content: { 'application/json': { schema: InboundResponse } },
    },
    400: {
      description: 'Verification failed',
      content: { 'application/json': { schema: WebhookErrorResponseSchema } },
    },
    404: {
      description: 'Unknown provider',
      content: { 'application/json': { schema: WebhookErrorResponseSchema } },
    },
  },
});

/**
 * Creates the OpenAPIHono router for receiving inbound webhooks from third-party providers.
 *
 * Mounted at `<mountPath>/inbound` by the plugin when `config.inbound` is non-empty.
 * Each `POST /inbound/:provider` request is routed to the matching `InboundProvider.verify()`
 * method. On success, the payload is re-emitted as `webhook:inbound.<provider>` on the bus.
 *
 * @param providers - Array of `InboundProvider` instances registered by the plugin config.
 * @param bus - The application event bus to emit verified inbound events on.
 * @returns An OpenAPIHono router that handles `POST /{provider}`.
 */
export function createInboundRouter(providers: InboundProvider[], bus: SlingshotEventBus) {
  const app = createRouter();
  const providerMap = new Map(providers.map(p => [p.name, p]));
  if (providerMap.size !== providers.length) {
    throw new Error('[slingshot-webhooks] Duplicate inbound provider names are not allowed');
  }

  app.openapi(inboundRoute, async c => {
    const { provider: providerName } = c.req.valid('param');
    const provider = providerMap.get(providerName);
    if (!provider) return errorResponse(c, `Unknown provider: ${providerName}`, 404);

    const rawBody = await c.req.text();
    let result: Awaited<ReturnType<InboundProvider['verify']>>;
    try {
      result = await provider.verify(c, rawBody);
    } catch {
      return errorResponse(c, 'Verification failed', 400);
    }
    if (!result.verified) {
      return errorResponse(c, result.reason ?? 'Verification failed', 400);
    }

    bus.emit(`webhook:inbound.${providerName}`, {
      provider: providerName,
      payload: result.payload,
      rawBody,
    });

    return c.json({ received: true }, 200);
  });

  return app;
}
