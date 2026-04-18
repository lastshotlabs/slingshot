/**
 * GameSession operations.
 *
 * Declarative database operations using `defineOperations()` + `op.*()`.
 * Each operation produces a typed adapter method AND an auto-generated
 * HTTP route. Operation names match the keys in `GameSession.routes.operations`.
 *
 * See spec §2.4.2 for the full contract.
 */
import { defineOperations, op } from '@lastshotlabs/slingshot-entity';
import { GameSession } from '../entities/gameSession';

/**
 * Declarative operations for the GameSession entity.
 *
 * Includes lookups (`findByJoinCode`, `findByGameType`) and status
 * transitions (`startGame`, `pauseGame`, `resumeGame`, `completeGame`,
 * `abandonSession`).
 */
export const gameSessionOperations = defineOperations(GameSession, {
  /** Find a session by its short join code. */
  findByJoinCode: op.lookup({
    fields: { joinCode: 'param:joinCode' },
    returns: 'one',
  }),

  /** List sessions by game type + status. */
  findByGameType: op.lookup({
    fields: { gameType: 'param:gameType', status: 'param:status' },
    returns: 'many',
  }),

  /**
   * Transition lobby → starting.
   *
   * The DB field change is atomic. Complex initialization (content loading,
   * phase setup, role/team assignment) happens in the `startGameGuard`
   * middleware that runs BEFORE this transition fires.
   */
  startGame: op.transition({
    field: 'status',
    from: 'lobby',
    to: 'starting',
    match: { id: 'param:id' },
    set: { startedAt: 'now' },
  }),

  /** Transition playing → paused. */
  pauseGame: op.transition({
    field: 'status',
    from: 'playing',
    to: 'paused',
    match: { id: 'param:id' },
  }),

  /** Transition paused → playing. */
  resumeGame: op.transition({
    field: 'status',
    from: 'paused',
    to: 'playing',
    match: { id: 'param:id' },
  }),

  /** Transition playing → completed (called internally by the engine). */
  completeGame: op.transition({
    field: 'status',
    from: 'playing',
    to: 'completed',
    match: { id: 'param:id' },
    set: { completedAt: 'now' },
  }),

  /**
   * Transition any active state → abandoned.
   *
   * `from` accepts an array — transition is valid from any of these states.
   */
  abandonSession: op.transition({
    field: 'status',
    from: ['lobby', 'starting', 'playing', 'paused'],
    to: 'abandoned',
    match: { id: 'param:id' },
  }),

  /**
   * Update rules in lobby. Host applies partial rule overrides via middleware.
   * Route: PATCH /game/sessions/:id/update-rules
   */
  updateRules: op.fieldUpdate({
    match: { id: 'param:id' },
    set: ['rules'],
    partial: true,
  }),

  /**
   * Set content provider and input. Lobby only.
   * Route: POST /game/sessions/:id/update-content
   *
   * Body: `{ contentProvider: string, contentInput?: unknown }`
   * The contentValidationGuard middleware validates provider exists and
   * input passes schema. This handler merges them into the contentConfig
   * entity field because middleware never transforms the request body.
   */
  updateContent: op.custom({
    http: { method: 'post', path: ':id/update-content' },
    memory: store => (params: Record<string, unknown>) => {
      const id = params.id as string;
      const record = store.get(id);
      if (!record) return null;
      record.contentConfig = {
        provider: params.contentProvider as string,
        input: params.contentInput ?? null,
      };
      return record;
    },
  }),

  /**
   * End game early — host-initiated forced completion.
   * Route: POST /game/sessions/:id/end-game
   * Transitions playing|paused → completed.
   */
  endGame: op.transition({
    field: 'status',
    from: ['playing', 'paused'],
    to: 'completed',
    match: { id: 'param:id' },
    set: { completedAt: 'now' },
  }),
});
