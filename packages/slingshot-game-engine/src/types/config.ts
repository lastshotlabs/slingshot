/**
 * Plugin configuration for `slingshot-game-engine`.
 *
 * Validated via {@link GameEnginePluginConfigSchema} at plugin construction time
 * and frozen via `deepFreeze()` (Rule 10).
 */
import type { ReplayStore } from './adapters';

/** Configuration options for `createGameEnginePackage()`. */
export interface GameEnginePluginConfig {
  /** Mount path for game engine REST routes. Default: `'/game'`. */
  readonly mountPath: string;

  /** WS endpoint name. Default: `'game'`. */
  readonly wsEndpoint: string;

  /**
   * Replay log storage and retention.
   */
  readonly replay: Readonly<ReplayConfig>;

  /**
   * Cleanup configuration for completed/abandoned sessions.
   */
  readonly cleanup: Readonly<CleanupConfig>;

  /**
   * Default disconnect configuration.
   * Individual game definitions can override these per game type.
   */
  readonly disconnect: Readonly<DisconnectConfig>;

  /**
   * WS rate-limiting configuration (per-socket, rolling window).
   * Applied at the slingshot framework layer via `WsEndpointConfig.rateLimit`.
   */
  readonly wsRateLimit: Readonly<WsRateLimitPluginConfig>;

  /**
   * WS heartbeat configuration.
   */
  readonly heartbeat: Readonly<HeartbeatConfig>;

  /**
   * WS message persistence and recovery configuration.
   */
  readonly recovery: Readonly<RecoveryConfig>;

  /**
   * Routes to disable. Keys are `entityName.operationOrAction` strings.
   * @example `['session.delete', 'player.kick']`
   */
  readonly disableRoutes: readonly string[];
}

/**
 * Replay log storage and retention.
 *
 * @remarks
 * The replay log is the append-only record of everything that happened in a
 * session — every input, phase transition, RNG draw, timer event and score
 * change, each carrying a `timestamp` and a monotonic `sequence`. It is what
 * post-hoc features (recaps, per-player statistics, audit, dispute resolution)
 * are built from, and it is served by `GET {mountPath}/sessions/:id/replay`.
 *
 * **The default store is in-memory and per-process.** It is lost on restart,
 * redeploy, or crash. That is the right default for development and for games
 * that only read the log while the session is live, but a consumer building
 * anything durable on top of it must supply its own store — see `store` below.
 */
export interface ReplayConfig {
  /**
   * Where replay entries are written.
   *
   * - `'memory'` (default) — per-process, lost on restart. Development, tests,
   *   and live-session-only consumers.
   * - `{ factory }` — your own {@link ReplayStore}. The factory is invoked once
   *   per package instance, during `createGameEnginePackage()`.
   *
   * A factory is used rather than a store instance because the plugin config is
   * `deepFreeze()`d (Rule 10), and `deepFreeze` explicitly must not be applied
   * to objects holding mutable runtime state. Functions are skipped by the
   * freeze walk, so the store the factory returns is never reached by it.
   *
   * @example Durable replay backed by your own persistence
   * ```ts
   * createGameEnginePackage({
   *   games: [myGame],
   *   replay: {
   *     store: { factory: () => createMyDatabaseReplayStore(db) },
   *     retainOnCleanup: true,
   *   },
   * })
   * ```
   */
  readonly store: 'memory' | { readonly factory: () => ReplayStore };

  /**
   * Whether replay entries survive session cleanup. Default: `false`.
   *
   * Sessions are garbage-collected after {@link CleanupConfig.completedTtl}
   * (4 hours by default), and cleanup deletes the session's replay entries with
   * it. For an in-memory store that is simply hygiene. For a durable store it
   * is usually wrong: it destroys the very history the store exists to keep, a
   * few hours after the game ended.
   *
   * Set `true` to keep replay entries after the session record is gone. The
   * consumer then owns their lifecycle — nothing else will ever delete them.
   */
  readonly retainOnCleanup: boolean;
}

/** Session cleanup TTL configuration. */
export interface CleanupConfig {
  /** Time after completion before session data is deleted (ms). Default: 4 hours. */
  readonly completedTtl: number;

  /** Time after last activity before an abandoned session is deleted (ms). Default: 1 hour. */
  readonly abandonedTtl: number;

  /** Time a lobby can sit idle before cleanup (ms). Default: 30 minutes. */
  readonly lobbyIdleTtl: number;

  /** How often to run the cleanup sweep (ms). Default: 5 minutes. */
  readonly sweepInterval: number;

  /** Whether to archive session data before deletion. Default: false. */
  readonly archive: boolean;
}

/** Default disconnect behavior configuration. */
export interface DisconnectConfig {
  /** Grace period before taking action on disconnect (ms). Default: 60000. */
  readonly gracePeriodMs: number;

  /** Maximum disconnects before auto-kick. Default: 5. 0 disables. */
  readonly maxDisconnects: number;

  /**
   * Whether the game pauses on player disconnect.
   * - `'never'`: game continues
   * - `'always'`: game pauses until reconnect or grace expires
   * - `'turn-player'`: pauses only if it's the disconnected player's turn
   */
  readonly pauseOnDisconnect: 'never' | 'always' | 'turn-player';

  /**
   * What happens to a disconnected player's turn.
   * - `'skip'`: auto-skip their turn
   * - `'timeout'`: let the turn timer expire naturally
   * - `'auto-action'`: call `autoActionHandler` for a default action
   * - `'pause'`: pause until reconnect
   */
  readonly turnBehavior: 'skip' | 'timeout' | 'auto-action' | 'pause';

  /** Handler name for `'auto-action'` turn behavior. */
  readonly autoActionHandler?: string;
}

/** WS socket-level rate-limit configuration. */
export interface WsRateLimitPluginConfig {
  /** Rolling window duration (ms). Default: 1000. */
  readonly windowMs: number;

  /** Max messages per window per socket. Default: 30. */
  readonly maxMessages: number;

  /** Action on exceeded: `'drop'` silently drops, `'close'` disconnects. */
  readonly onExceeded: 'drop' | 'close';
}

/** WS heartbeat configuration. */
export interface HeartbeatConfig {
  /** Ping interval (ms). Default: 30000. */
  readonly intervalMs: number;

  /** Pong timeout (ms). Default: 10000. */
  readonly timeoutMs: number;
}

/** WS message persistence and recovery configuration. */
export interface RecoveryConfig {
  /** Recovery window (ms). Default: 120000. */
  readonly windowMs: number;

  /** Max messages to persist per room. Default: 200. */
  readonly maxCount: number;

  /** Message TTL in seconds. Default: 3600. */
  readonly ttlSeconds: number;
}
