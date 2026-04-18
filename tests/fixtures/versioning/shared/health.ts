import { z } from 'zod';
import { createRoute, createRouter } from '@lastshotlabs/slingshot-core';

export const router = createRouter();

const HealthRoute = createRoute({
  method: 'get',
  path: '/health',
  responses: {
    200: {
      description: 'Health check',
      content: {
        'application/json': {
          schema: z.object({ status: z.literal('ok') }),
        },
      },
    },
  },
});

router.openapi(HealthRoute, c => {
  return c.json({ status: 'ok' as const });
});
