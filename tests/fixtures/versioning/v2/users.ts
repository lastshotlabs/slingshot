import { z } from 'zod';
import { createRoute, createRouter } from '@lastshotlabs/slingshot-core';

export const router = createRouter();

const ListUsersV2Route = createRoute({
  method: 'get',
  path: '/users',
  responses: {
    200: {
      description: 'List of users (v2 — includes email)',
      content: {
        'application/json': {
          schema: z.object({
            users: z.array(z.object({ id: z.string(), name: z.string(), email: z.string() })),
            total: z.number(),
          }),
        },
      },
    },
  },
});

router.openapi(ListUsersV2Route, c => {
  return c.json({ users: [{ id: '1', name: 'Alice', email: 'alice@example.com' }], total: 1 });
});
