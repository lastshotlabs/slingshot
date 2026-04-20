import { type CreateAppConfig, createServer } from '@lastshotlabs/slingshot';
import { createAuthPlugin } from '@lastshotlabs/slingshot-auth';
import { createMemoryAdapter } from '@lastshotlabs/slingshot-orchestration';
import { createOrchestrationPlugin } from '@lastshotlabs/slingshot-orchestration-plugin';
import { createBillingApiPlugin } from './billingPlugin.ts';
import {
  orchestrationTasks,
  orchestrationWorkflows,
  requireOperationsKey,
} from './orchestration.ts';

export function buildAppConfig(): CreateAppConfig {
  return {
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
        adapter: createMemoryAdapter({ concurrency: 10 }),
        tasks: orchestrationTasks,
        workflows: orchestrationWorkflows,
        routes: true,
        routePrefix: '/orchestration',
        routeMiddleware: [requireOperationsKey],
      }),
      createBillingApiPlugin(),
    ],
  };
}

if (import.meta.main) {
  await createServer({ port: 3000, ...buildAppConfig() });
}
