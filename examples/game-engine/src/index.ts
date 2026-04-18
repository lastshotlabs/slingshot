import { createAuthPlugin } from '../../../packages/slingshot-auth/src/index.ts';
import { createGameEnginePlugin } from '../../../packages/slingshot-game-engine/src/index.ts';
import type { CreateAppConfig } from '../../../src/index.ts';
import { createServer } from '../../../src/index.ts';
import { blackjack } from './blackjack.ts';
import { drawing } from './drawing.ts';
import { trivia } from './trivia.ts';

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
      createGameEnginePlugin({
        games: [trivia, drawing, blackjack],
        mountPath: '/game',
      }),
    ],
  };
}

if (import.meta.main) {
  await createServer({ port: 3000, ...buildAppConfig() });
}
