/**
 * Multi-entity manifest declaration for the game engine plugin.
 *
 * Declares entity configs, operations, and hooks consumed by
 * `createEntityPlugin({ manifest })` so the entity plugin can resolve all
 * game-engine entities from a single declarative bundle.
 */
import type { MultiEntityManifest } from '@lastshotlabs/slingshot-entity';
import { entityConfigToManifestEntry } from '@lastshotlabs/slingshot-entity';
import { GamePlayer } from '../entities/gamePlayer';
import { GameSession } from '../entities/gameSession';
import { gamePlayerOperations } from '../operations/player';
import { gameSessionOperations } from '../operations/session';

/**
 * Manifest declaration for `slingshot-game-engine`.
 *
 * Registers GameSession and GamePlayer entities with their operations,
 * and declares an `afterAdapters` hook for capturing resolved adapters.
 */
export const gameEngineManifest: MultiEntityManifest = {
  manifestVersion: 1,
  namespace: 'game',
  hooks: {
    afterAdapters: [{ handler: 'game.captureAdapters' }],
  },
  entities: {
    GameSession: entityConfigToManifestEntry(GameSession, {
      operations: gameSessionOperations.operations,
    }),
    GamePlayer: entityConfigToManifestEntry(GamePlayer, {
      operations: gamePlayerOperations.operations,
    }),
  },
};
