import type { Context, MiddlewareHandler } from 'hono';
import { z } from 'zod';
import { createAuthPlugin } from '../../packages/slingshot-auth/src/index.ts';
import { createBullMQOrchestrationAdapter } from '../../packages/slingshot-orchestration-bullmq/src/index.ts';
import { createOrchestrationPlugin } from '../../packages/slingshot-orchestration-plugin/src/index.ts';
import {
  OrchestrationError,
  defineTask,
  defineWorkflow,
  step,
} from '../../packages/slingshot-orchestration/src/index.ts';
import { defineApp } from '../../src/index.ts';

/**
 * Source-backed BullMQ orchestration example.
 *
 * Demonstrates how to wire `createBullMQOrchestrationAdapter()` into the
 * orchestration plugin so tasks and workflows execute against a real Redis
 * BullMQ queue instead of the in-memory adapter.
 */

// --- workflow definitions -------------------------------------------------

const sendEmail = defineTask({
  name: 'send-email',
  input: z.object({
    to: z.string().email(),
    subject: z.string(),
  }),
  output: z.object({
    delivered: z.boolean(),
  }),
  retry: { maxAttempts: 3, backoff: 'exponential', delayMs: 250, maxDelayMs: 5_000 },
  timeout: 5_000,
  async handler() {
    return { delivered: true };
  },
});

const onboardCustomerWorkflow = defineWorkflow({
  name: 'onboard-customer',
  input: z.object({ email: z.string().email() }),
  output: z.object({ delivered: z.boolean() }),
  outputMapper(results) {
    return (results['send-welcome'] as { delivered: boolean }) ?? { delivered: false };
  },
  steps: [
    step('send-welcome', sendEmail, {
      input: ({ workflowInput }: { workflowInput: { email: string } }) => ({
        to: workflowInput.email,
        subject: 'Welcome!',
      }),
    }),
  ],
});

// --- HTTP guards ---------------------------------------------------------

export const requireOpsKey: MiddlewareHandler = async (c, next) => {
  if (c.req.header('x-ops-key') !== (process.env.OPS_KEY ?? 'dev-ops-key')) {
    return c.json({ error: 'forbidden' }, 403);
  }
  await next();
};

export function resolveOpsRequestContext(c: Context) {
  const tenantId = c.req.header('x-tenant-id');
  if (!tenantId) {
    throw new OrchestrationError('VALIDATION_FAILED', 'missing x-tenant-id');
  }
  return {
    tenantId,
    actorId: c.req.header('x-actor-id') ?? 'ops-automation',
    metadata: { source: 'operations-api' },
  };
}

// --- app config -----------------------------------------------------------

// The BullMQ adapter connects to Redis on construction. In production
// always pass `requireTls: true` so a missing `tls` block fails fast at
// startup instead of silently falling back to plaintext.
const adapter = createBullMQOrchestrationAdapter({
  connection: {
    host: process.env.REDIS_HOST ?? '127.0.0.1',
    port: Number(process.env.REDIS_PORT ?? 6379),
    // tls: { rejectUnauthorized: true, ca: process.env.REDIS_CA }, // production
  },
  prefix: 'demo-orch',
  concurrency: 8,
  requireTls: process.env.NODE_ENV === 'production',
  shutdownDrainTimeoutMs: 30_000,
  jobRetention: {
    removeOnCompleteAge: 3_600, // 1 hour
    removeOnCompleteCount: 1_000,
    removeOnFailAge: 86_400, // 24 hours
  },
});

export default defineApp({
  port: 3000,
  db: { mongo: false, redis: false },
  security: {
    signing: {
      secret: process.env.JWT_SECRET ?? 'dev-secret-change-me-dev-secret-change-me',
    },
  },
  plugins: [
    createAuthPlugin({
      auth: { roles: ['user', 'admin'], defaultRole: 'user' },
      db: { auth: 'memory', sessions: 'memory', oauthState: 'memory' },
    }),
    createOrchestrationPlugin({
      adapter,
      tasks: [sendEmail],
      workflows: [onboardCustomerWorkflow],
      routes: true,
      routePrefix: '/orchestration',
      routeMiddleware: [requireOpsKey],
      resolveRequestContext: resolveOpsRequestContext,
    }),
  ],
});
