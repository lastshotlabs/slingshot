import { createAssetsPlugin } from '../../packages/slingshot-assets/src/index.ts';
import { createAuthPlugin } from '../../packages/slingshot-auth/src/index.ts';
import { createChatPlugin } from '../../packages/slingshot-chat/src/index.ts';
import { createCommunityPlugin } from '../../packages/slingshot-community/src/index.ts';
import { createDeepLinksPlugin } from '../../packages/slingshot-deep-links/src/index.ts';
import { createEmbedsPlugin } from '../../packages/slingshot-embeds/src/index.ts';
import { createEmojiPlugin } from '../../packages/slingshot-emoji/src/index.ts';
import { createGifsPlugin } from '../../packages/slingshot-gifs/src/index.ts';
import { createInteractionsPlugin } from '../../packages/slingshot-interactions/src/index.ts';
import { createNotificationsPlugin } from '../../packages/slingshot-notifications/src/index.ts';
import { createPermissionsPlugin } from '../../packages/slingshot-permissions/src/index.ts';
import { createPollsPlugin } from '../../packages/slingshot-polls/src/index.ts';
import { defineApp } from '../../src/index.ts';

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
      auth: { roles: ['user', 'moderator', 'admin'], defaultRole: 'user' },
      db: { auth: 'memory', sessions: 'memory', oauthState: 'memory' },
    }),
    createNotificationsPlugin({
      dispatcher: { enabled: false, intervalMs: 30_000, maxPerTick: 500 },
    }),
    createPermissionsPlugin(),
    createCommunityPlugin({ authBridge: 'auto', containerCreation: 'user' }),
    createChatPlugin({
      storeType: 'memory',
      permissions: {
        createRoom: ['user', 'moderator', 'admin'],
        sendMessage: ['user', 'moderator', 'admin'],
      },
    }),
    createPollsPlugin(),
    createAssetsPlugin({
      storage: { adapter: 'memory' },
      presignedUrls: true,
      allowedMimeTypes: ['image/png', 'image/jpeg', 'image/gif', 'image/webp'],
      image: { allowedOrigins: ['localhost'] },
    }),
    createEmojiPlugin({}),
    createEmbedsPlugin({}),
    createGifsPlugin({
      provider: 'tenor',
      apiKey: process.env.TENOR_API_KEY ?? 'replace-me',
      rating: 'pg',
    }),
    createDeepLinksPlugin({
      fallbackBaseUrl: 'https://app.example.com',
      fallbackRedirects: {
        '/join/*': '/workspace/:id',
        '/share/*': '/thread/:id',
      },
    }),
    createInteractionsPlugin({
      handlers: {
        'polls:vote:': { kind: 'route', target: '/internal/interactions/poll-vote' },
        'chat:pin:': { kind: 'queue', target: 'jobs:chat.pin', fireAndForget: true },
      },
    }),
  ],
});
