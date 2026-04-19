import { OpenAPIHono } from '@hono/zod-openapi';
import type { AppEnv } from '@lastshotlabs/slingshot-core';

export const router = new OpenAPIHono<AppEnv>();
router.get('/health', c => c.text('ok'));
