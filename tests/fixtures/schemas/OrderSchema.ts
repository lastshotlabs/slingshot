import { z } from 'zod';

// Tracks whether this file was imported — read by preloadSchemas tests
(globalThis as any).__fixtureOrderSchemaLoaded = true;

export const OrderSchema = z.object({
  id: z.string(),
  userId: z.string(),
  total: z.number(),
});
