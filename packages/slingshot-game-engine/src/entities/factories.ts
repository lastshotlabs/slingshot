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

/** Repository factories for the GameSession entity, dispatched by `StoreType`. */
export const gameSessionFactories = createEntityFactories(
  GameSession,
  gameSessionOperations.operations,
);

/** Repository factories for the GamePlayer entity, dispatched by `StoreType`. */
export const gamePlayerFactories = createEntityFactories(
  GamePlayer,
  gamePlayerOperations.operations,
);
