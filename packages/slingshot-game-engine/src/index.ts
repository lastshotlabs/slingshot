// Module augmentation re-exported for type consumers.
import './events';

/**
 * Public API surface for `slingshot-game-engine`.
 *
 * This is the primary entry point. It exports the plugin factory,
 * `defineGame()` DSL, entity definitions, operations, types, and
 * error utilities.
 *
 * Subpath exports:
 * - `slingshot-game-engine/types` — types-only (no runtime, no server deps)
 * - `slingshot-game-engine/recipes` — composable game utilities
 * - `slingshot-game-engine/testing` — test harness and helpers
 */

// ── Plugin ───────────────────────────────────────────────────────

/** Plugin factory — call once to create the game engine plugin instance. */
export { createGameEnginePlugin } from './plugin';

// ── Game Definition DSL ──────────────────────────────────────────

/** Declarative game definition builder — validates phases, channels, and handlers at startup. */
export { defineGame } from './defineGame';

// ── Entity Definitions ──────────────────────────────────────────

/** Persisted session entity with status, phase, RNG, and timing fields. */
export { GameSession } from './entities/gameSession';

/** Persisted player entity linking a user to a session with role, score, and connection state. */
export { GamePlayer } from './entities/gamePlayer';

/** Repository factories for GameSession and GamePlayer, dispatched by StoreType. */
export { gameSessionFactories, gamePlayerFactories } from './entities/factories';

// ── Operations ──────────────────────────────────────────────────

/** Declarative session operations: lookups and status transitions. */
export { gameSessionOperations } from './operations/session';

/** Declarative player operations: lookups, score increment, connection update, count. */
export { gamePlayerOperations } from './operations/player';

// ── Policy ──────────────────────────────────────────────────────

/** Policy key, factory, and registration for game session access control. */
export {
  GAME_SESSION_POLICY_KEY,
  createGameSessionPolicy,
  registerGameSessionPolicies,
} from './policy';

// ── Events ──────────────────────────────────────────────────────

/** Event keys registered as client-safe for WS relay. */
export { GAME_ENGINE_CLIENT_SAFE_EVENTS } from './events';

// ── Error Codes ─────────────────────────────────────────────────

/** Error code registry and structured error class for REST and WS error responses. */
export { GameErrorCode, GameError } from './errors';

/** Union type of all game engine error code string values. */
export type { GameErrorCodeValue } from './errors';

// ── Validation Schemas ──────────────────────────────────────────

/** Zod schema for plugin config — used by pluginSchemaRegistry for introspection. */
export { GameEnginePluginConfigSchema } from './validation/config';

// ── Plugin State Key ────────────────────────────────────────────

/** Stable key for `pluginState.get()` / `pluginState.set()`. */
export { GAME_ENGINE_PLUGIN_STATE_KEY } from './types/state';

// ── Types ───────────────────────────────────────────────────────

/** Plugin configuration accepted by `createGameEnginePlugin()`. */
export type { GameEnginePluginConfig } from './types/config';

/** Runtime state stored in `getContext(app).pluginState`. */
export type {
  GameEngineActiveSessionSnapshot,
  GameEngineAdvancePhaseInput,
  GameEnginePluginState,
  GameEngineSessionMutationContext,
  GameEngineSessionMutationResult,
  GameEngineSessionControls,
  GameEngineSubmitInput,
} from './types/state';

/**
 * Game domain model types — definitions, runtime state, handlers, and protocol messages.
 *
 * Covers session/player state, game definitions, phases, channels, turns,
 * scoring, timers, RNG, replay, input pipeline, WS protocol, and handler contexts.
 */
export type {
  SessionStatus,
  GameSessionState,
  GamePlayerState,
  GameDefinition,
  GameDefinitionInput,
  RoleDefinition,
  RoleAssignmentContext,
  RoleVisibilityRule,
  TeamDefinition,
  PhaseAdvanceTrigger,
  PhaseDefinition,
  SubPhaseDefinition,
  ChannelMode,
  ChannelFromConfig,
  ChannelRelayConfig,
  ChannelDefinition,
  ChannelRuntimeState,
  TurnState,
  GameLoopDefinition,
  SyncDefinition,
  ScoringDefinition,
  ScoreEntry,
  TeamScoreEntry,
  Leaderboard,
  ContentDefinition,
  ContentProviderDefinition,
  HandlerFunction,
  HandlerResult,
  RelayFilterFunction,
  PlayerInfo,
  WinResult,
  InputAck,
  BufferedInput,
  ScheduledEvent,
  VoteTally,
  GameTimer,
  ReplayEntry,
  ReplayEventType,
  ClientToServerMessage,
  ServerToClientMessage,
  SessionMutex,
  GameDisconnectConfig,
  ProcessHandlerContext,
  ReadonlyHandlerContext,
  SeededRng,
  GameLifecycleHooks,
} from './types/models';

/** Convenience re-export of lifecycle hook types for game definition consumers. */
export type { GameLifecycleHooks as LifecycleHooks } from './types/hooks';

/** Swappable provider interfaces for replay storage, content, rate limiting, and session leases. */
export type {
  ReplayStore,
  ContentProvider,
  RateLimitBackend,
  SessionLeaseAdapter,
} from './types/adapters';

// ── Middleware Builders ─────────────────────────────────────────

/** Build the lobby-only guard middleware (rejects if session not in lobby). */
export { buildLobbyOnlyGuard } from './middleware/lobbyOnlyGuard';

/** Build the rules validation guard middleware (validates rules against game definition schema). */
export { buildRulesValidationGuard } from './middleware/rulesValidationGuard';

/** Build the content validation guard middleware (validates content provider and input). */
export { buildContentValidationGuard } from './middleware/contentValidationGuard';
