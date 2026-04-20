import { z } from 'zod';

export const orchestrationRouteOptionsSchema = z.object({
  routes: z.boolean().optional().describe('Whether to mount HTTP routes for orchestration.'),
  routePrefix: z
    .string()
    .min(1)
    .optional()
    .describe('Base path used when mounting orchestration HTTP routes.'),
});
