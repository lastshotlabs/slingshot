/**
 * Entity factories for GameSession and GamePlayer.
 *
 * Uses `createEntityFactories()` from `slingshot-entity` to produce
 * `RepoFactories<T>` dispatched by `StoreType` (Rule 17).
 *
 * At startup the plugin's `buildAdapter` callbacks call `resolveRepo()`
 * with these factories to get the concrete adapter for the configured
 * store type.
 *
 * See spec §2.4.3 for the full contract.
 */
import { createEntityFactories } from '@lastshotlabs/slingshot-entity';
import { gamePlayerOperations } from '../operations/player';
import { gameSessionOperations } from '../operations/session';
import { GamePlayer } from './gamePlayer';
import { GameSession } from './gameSession';

// Both entities exclude their `op.custom` escape hatches — `updateContent`
// here, `kick` below. Each carries a memory factory only, so the standard
// adapter cannot service it on any other store, and passing one into the
// strict factory makes the backend-capability check reject the ENTIRE entity
// at boot rather than just that operation.
const gameSessionBaseOperations = {
  findByJoinCode: gameSessionOperations.operations.findByJoinCode,
  findByGameType: gameSessionOperations.operations.findByGameType,
  startGame: gameSessionOperations.operations.startGame,
  pauseGame: gameSessionOperations.operations.pauseGame,
  resumeGame: gameSessionOperations.operations.resumeGame,
  completeGame: gameSessionOperations.operations.completeGame,
  abandonSession: gameSessionOperations.operations.abandonSession,
  updateRules: gameSessionOperations.operations.updateRules,
  endGame: gameSessionOperations.operations.endGame,
};

const gamePlayerBaseOperations = {
  findBySession: gamePlayerOperations.operations.findBySession,
  findBySessionAndUser: gamePlayerOperations.operations.findBySessionAndUser,
  incrementScore: gamePlayerOperations.operations.incrementScore,
  updateConnection: gamePlayerOperations.operations.updateConnection,
  countBySession: gamePlayerOperations.operations.countBySession,
  assignTeam: gamePlayerOperations.operations.assignTeam,
  assignRole: gamePlayerOperations.operations.assignRole,
};

/** Repository factories for the GameSession entity, dispatched by `StoreType`. */
export const gameSessionFactories = createEntityFactories(GameSession, gameSessionBaseOperations);

/** Repository factories for the GamePlayer entity, dispatched by `StoreType`. */
export const gamePlayerFactories = createEntityFactories(GamePlayer, gamePlayerBaseOperations);
