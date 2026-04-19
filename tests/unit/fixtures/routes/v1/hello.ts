import { OpenAPIHono } from '@hono/zod-openapi';
import type { AppEnv } from '@lastshotlabs/slingshot-core';

export const router = new OpenAPIHono<AppEnv>();
router.get('/hello', c => c.text('hello from v1'));
export const priority = 1;
