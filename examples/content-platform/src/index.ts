import { edgeRuntime } from '../../../packages/runtime-edge/src/index.ts';
import { type KvNamespace, createKvIsrCache } from '../../../packages/runtime-edge/src/kv-isr.ts';
import { createAssetsPlugin } from '../../../packages/slingshot-assets/src/index.ts';
import { createAuthPlugin } from '../../../packages/slingshot-auth/src/index.ts';
import { createCommunityPlugin } from '../../../packages/slingshot-community/src/index.ts';
import { createDeepLinksPlugin } from '../../../packages/slingshot-deep-links/src/index.ts';
import { createNotificationsPlugin } from '../../../packages/slingshot-notifications/src/index.ts';
import { createPermissionsPlugin } from '../../../packages/slingshot-permissions/src/index.ts';
import { createSearchPlugin } from '../../../packages/slingshot-search/src/index.ts';
import { createSsrPlugin } from '../../../packages/slingshot-ssr/src/index.ts';
import type { CreateAppConfig } from '../../../src/index.ts';
import { createServer } from '../../../src/index.ts';
import { renderer } from './renderer.ts';

const serverRoutesDir = new URL('../server/routes/', import.meta.url).pathname;
const assetsManifest = new URL('../client-manifest.json', import.meta.url).pathname;
const staticDir = new URL('../dist/static/', import.meta.url).pathname;

const inMemoryKv: KvNamespace = {
  async get(_key) {
    return null;
  },
  async put() {},
  async delete() {},
  async list() {
    return { keys: [] };
  },
};

export function buildAppConfig(): CreateAppConfig {
  return {
    runtime: edgeRuntime({
      fileStore: async () => null,
    }),
    db: { mongo: false, redis: false },
    security: {
      signing: {
        secret: process.env.JWT_SECRET ?? 'dev-secret-change-me-dev-secret-change-me',
      },
    },
    plugins: [
      createAuthPlugin({
        auth: { roles: ['user', 'editor', 'admin'], defaultRole: 'user' },
        db: { auth: 'memory', sessions: 'memory', oauthState: 'memory' },
      }),
      createNotificationsPlugin({
        dispatcher: { enabled: false, intervalMs: 30_000, maxPerTick: 500 },
      }),
      createPermissionsPlugin(),
      createCommunityPlugin({ containerCreation: 'admin' }),
      createAssetsPlugin({
        storage: { adapter: 'memory' },
        presignedUrls: true,
        image: { allowedOrigins: ['assets.example.com'] },
      }),
      createSearchPlugin({
        providers: {
          default: { provider: 'db-native' },
        },
      }),
      createDeepLinksPlugin({
        fallbackBaseUrl: 'https://content.example.com',
        fallbackRedirects: {
          '/open/*': '/articles/:id',
        },
      }),
      createSsrPlugin({
        renderer,
        serverRoutesDir,
        assetsManifest,
        staticDir,
        draftModeSecret: process.env.DRAFT_MODE_SECRET ?? 'draft-secret',
        isr: { adapter: createKvIsrCache(inMemoryKv) },
      }),
    ],
  };
}

if (import.meta.main) {
  await createServer({ port: 3000, ...buildAppConfig() });
}
