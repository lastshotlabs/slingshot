import { defineApp } from '@lastshotlabs/slingshot';
import { createAuthPlugin } from '@lastshotlabs/slingshot-auth';
import { createMemoryAdapter } from '@lastshotlabs/slingshot-orchestration';
import { createOrchestrationPlugin } from '@lastshotlabs/slingshot-orchestration-plugin';
import { createBillingApiPlugin } from './src/billingPlugin.ts';
import {
  orchestrationTasks,
  orchestrationWorkflows,
  requireOperationsKey,
  resolveOperationsRequestContext,
} from './src/orchestration.ts';

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
      adapter: createMemoryAdapter({ concurrency: 10 }),
      tasks: orchestrationTasks,
      workflows: orchestrationWorkflows,
      routes: true,
      routePrefix: '/orchestration',
      routeMiddleware: [requireOperationsKey],
      resolveRequestContext: resolveOperationsRequestContext,
    }),
    createBillingApiPlugin(),
  ],
});
