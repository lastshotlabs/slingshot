import { createAuthPlugin } from '../../packages/slingshot-auth/src/index.ts';
import { defineApp } from '../../src/index.ts';
import { createBlogPlugin } from './src/plugin.ts';

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
    createBlogPlugin({ mountPath: '/posts' }),
  ],
});
