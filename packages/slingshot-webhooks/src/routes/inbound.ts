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
    413: {
      description: 'Request body exceeds the inbound size limit',
      content: { 'application/json': { schema: WebhookErrorResponseSchema } },
    },
  },
});

/**
 * Options for {@link createInboundRouter}.
 */
export interface CreateInboundRouterOptions {
  /**
   * Maximum accepted body size in bytes for an inbound webhook delivery.
   * Defaults to 1 MiB (1,048,576 bytes). Most provider webhooks are well under
   * this cap; raise it explicitly when a provider sends bigger payloads.
   */
  maxBodyBytes?: number;
}

/** Default cap for inbound webhook bodies, in bytes (1 MiB). */
export const DEFAULT_INBOUND_MAX_BODY_BYTES = 1 * 1024 * 1024;

/**
 * Read the request body with a hard byte cap. Returns null if the limit is
 * exceeded so the route can fail with HTTP 413.
 */
async function readBoundedBody(
  request: Request,
  maxBodyBytes: number,
): Promise<{ ok: true; body: string } | { ok: false }> {
  const declared = Number(request.headers.get('content-length') ?? 'NaN');
  if (Number.isFinite(declared) && declared > maxBodyBytes) {
    return { ok: false };
  }

  if (!request.body) return { ok: true, body: '' };

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!(value instanceof Uint8Array)) continue;
      total += value.byteLength;
      if (total > maxBodyBytes) {
        try {
          await reader.cancel();
        } catch {
          // already cancelled — ignore
        }
        return { ok: false };
      }
      chunks.push(value);
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // already released — ignore
    }
  }

  return { ok: true, body: Buffer.concat(chunks).toString('utf8') };
}

/**
 * Creates the OpenAPIHono router for receiving inbound webhooks from third-party providers.
 *
 * Mounted at `<mountPath>/inbound` by the plugin when `config.inbound` is non-empty.
 * Each `POST /inbound/:provider` request is routed to the matching `InboundProvider.verify()`
 * method. On success, the payload is re-emitted as `webhook:inbound.<provider>` on the bus.
 *
 * Bodies larger than `maxBodyBytes` (default 1 MiB) are rejected with HTTP 413 before any
 * provider verification runs, so a malicious sender cannot tie up a worker with a billion-byte
 * payload.
 *
 * @param providers - Array of `InboundProvider` instances registered by the plugin config.
 * @param bus - The application event bus to emit verified inbound events on.
 * @param opts - Optional router options, including the inbound body-size limit.
 * @returns An OpenAPIHono router that handles `POST /{provider}`.
 */
export function createInboundRouter(
  providers: InboundProvider[],
  bus: SlingshotEventBus,
  opts: CreateInboundRouterOptions = {},
) {
  const app = createRouter();
  const providerMap = new Map(providers.map(p => [p.name, p]));
  if (providerMap.size !== providers.length) {
    throw new Error('[slingshot-webhooks] Duplicate inbound provider names are not allowed');
  }
  const maxBodyBytes = opts.maxBodyBytes ?? DEFAULT_INBOUND_MAX_BODY_BYTES;

  app.openapi(inboundRoute, async c => {
    const { provider: providerName } = c.req.valid('param');
    const provider = providerMap.get(providerName);
    if (!provider) return errorResponse(c, `Unknown provider: ${providerName}`, 404);

    const bodyResult = await readBoundedBody(c.req.raw, maxBodyBytes);
    if (!bodyResult.ok) {
      return errorResponse(
        c,
        `Inbound webhook body exceeds maximum size (${maxBodyBytes} bytes)`,
        413,
      );
    }

    const rawBody = bodyResult.body;
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
