import { createAuthPlugin } from '../../../packages/slingshot-auth/src/index.ts';
import type { CreateAppConfig } from '../../../src/index.ts';
import { createServer } from '../../../src/index.ts';
import { createBlogPlugin } from './plugin.ts';

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
      createBlogPlugin({ mountPath: '/posts' }),
    ],
  };
}

if (import.meta.main) {
  await createServer({ port: 3000, ...buildAppConfig() });
}
