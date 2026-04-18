/**
 * GamePlayer operations.
 *
 * Declarative database operations using `defineOperations()` + `op.*()`.
 * Each operation produces a typed adapter method AND an auto-generated
 * HTTP route. Operation names match the keys in `GamePlayer.routes.operations`.
 *
 * See spec §2.4.2 for the full contract.
 */
import { defineOperations, op } from '@lastshotlabs/slingshot-entity';
import { GamePlayer } from '../entities/gamePlayer';

/**
 * Declarative operations for the GamePlayer entity.
 *
 * Includes lookups (`findBySession`, `findBySessionAndUser`),
 * mutations (`incrementScore`, `updateConnection`), and aggregates
 * (`countBySession`).
 */
export const gamePlayerOperations = defineOperations(GamePlayer, {
  /** List all players in a session. */
  findBySession: op.lookup({
    fields: { sessionId: 'param:sessionId' },
    returns: 'many',
  }),

  /** Find a specific player by session + user. */
  findBySessionAndUser: op.lookup({
    fields: { sessionId: 'param:sessionId', userId: 'param:userId' },
    returns: 'one',
  }),

  /** Atomic score increment (always uses SET field = field + N). */
  incrementScore: op.increment({
    field: 'score',
    match: { sessionId: 'param:sessionId', userId: 'param:userId' },
  }),

  /** Partial update for connection state changes. */
  updateConnection: op.fieldUpdate({
    match: { sessionId: 'param:sessionId', userId: 'param:userId' },
    set: ['connected', 'disconnectedAt', 'disconnectCount'],
  }),

  /** Count players in a session (for min/max player checks). */
  countBySession: op.aggregate({
    compute: { count: 'count' },
    filter: { sessionId: 'param:sessionId' },
  }),

  /** Assign a player to a team. Lobby only, host only via middleware. */
  assignTeam: op.fieldUpdate({
    match: { sessionId: 'param:sessionId', userId: 'param:userId' },
    set: ['team'],
  }),

  /** Assign a built-in role (host/player/spectator). Lobby only, host only via middleware. */
  assignRole: op.fieldUpdate({
    match: { sessionId: 'param:sessionId', userId: 'param:userId' },
    set: ['role', 'isSpectator', 'isHost'],
  }),

  /**
   * Kick a player from the session.
   * Uses op.custom because it needs cross-entity logic (ban list on session).
   * Route: POST /game/sessions/:sessionId/players/:userId/kick
   */
  kick: op.custom({
    http: { method: 'post', path: ':userId/kick' },
  }),
});
