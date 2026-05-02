import { createAuthPlugin } from '../../packages/slingshot-auth/src/index.ts';
import { createGameEnginePlugin } from '../../packages/slingshot-game-engine/src/index.ts';
import { defineApp } from '../../src/index.ts';
import { blackjack } from './src/blackjack.ts';
import { drawing } from './src/drawing.ts';
import { trivia } from './src/trivia.ts';

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
    createGameEnginePlugin({
      games: [trivia, drawing, blackjack],
      mountPath: '/game',
    }),
  ],
});
