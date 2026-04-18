import { z } from 'zod';
import { createRoute, createRouter } from '@lastshotlabs/slingshot-core';

export const router = createRouter();

const ListUsersV1Route = createRoute({
  method: 'get',
  path: '/users',
  responses: {
    200: {
      description: 'List of users (v1)',
      content: {
        'application/json': {
          schema: z.object({ users: z.array(z.object({ id: z.string(), name: z.string() })) }),
        },
      },
    },
  },
});

router.openapi(ListUsersV1Route, c => {
  return c.json({ users: [{ id: '1', name: 'Alice' }] });
});
