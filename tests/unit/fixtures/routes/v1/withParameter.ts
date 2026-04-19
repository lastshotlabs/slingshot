import { OpenAPIHono } from '@hono/zod-openapi';
import { z } from '@hono/zod-openapi';
import type { AppEnv } from '@lastshotlabs/slingshot-core';

export const router = new OpenAPIHono<AppEnv>();

// Register a parameter definition — exercises lines 70-75 in mountRoutes.ts
const paramSchema = z.string().openapi('TestParamId');
router.openAPIRegistry.registerParameter('TestParamId', paramSchema);

router.get('/with-param', c => c.text('param route'));
export const priority = 3;
