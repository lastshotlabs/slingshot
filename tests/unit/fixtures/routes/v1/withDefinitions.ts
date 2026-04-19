import { OpenAPIHono } from '@hono/zod-openapi';
import type { AppEnv } from '@lastshotlabs/slingshot-core';

export const router = new OpenAPIHono<AppEnv>();

// Register a component (securitySchemes)
router.openAPIRegistry.registerComponent('securitySchemes', 'testAuth', {
  type: 'http',
  scheme: 'bearer',
});

// Register a route
router.openAPIRegistry.registerPath({
  method: 'get',
  path: '/test-defined',
  responses: {
    200: { description: 'OK' },
  },
});

// Register a webhook
router.openAPIRegistry.registerWebhook({
  method: 'post',
  path: 'testWebhook',
  responses: {
    200: { description: 'OK' },
  },
});

router.get('/test-defined', c => c.text('defined'));
export const priority = 2;
