import { createRoute } from '@hono/zod-openapi';
import { z } from 'zod';
import { createRouter } from '@lastshotlabs/slingshot-core';

export const router = createRouter();

router.openapi(
  createRoute({
    method: 'get',
    path: '/',
    tags: ['Core'],
    responses: {
      200: {
        content: { 'application/json': { schema: z.object({ message: z.string() }) } },
        description: 'API is running',
      },
    },
  }),
  c => {
    const appName = c.get('slingshotCtx').config.appName;
    return c.json({ message: `${appName} is running` });
  },
);
