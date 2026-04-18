import { validate } from '@framework/lib/validate';
import { createRoute } from '@hono/zod-openapi';
import { z } from 'zod';
import { createRouter } from '@lastshotlabs/slingshot-core';

export const router = createRouter();

// Route that uses @hono/zod-openapi inline validation (defaultHook path)
const inlineRoute = createRoute({
  method: 'post',
  path: '/validation/inline',
  request: {
    body: {
      content: {
        'application/json': {
          schema: z.object({
            name: z.string(),
            age: z.number(),
          }),
        },
      },
    },
  },
  responses: {
    200: {
      content: { 'application/json': { schema: z.object({ ok: z.boolean() }) } },
      description: 'OK',
    },
  },
});

router.openapi(inlineRoute, c => {
  return c.json({ ok: true });
});

// Route that uses validate() helper (onError path)
router.post('/validation/manual', async c => {
  const body = await validate(z.object({ name: z.string(), age: z.number() }), c.req.raw);
  return c.json({ ok: true, name: body.name });
});
