import { z } from 'zod';

export const WEBHOOK_ROUTE_TAGS = ['Webhooks'];

export const WebhookErrorResponseSchema = z.object({ error: z.string() });
