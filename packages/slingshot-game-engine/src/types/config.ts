/**
 * Plugin configuration for `slingshot-game-engine`.
 *
 * Validated via {@link GameEnginePluginConfigSchema} at plugin construction time
 * and frozen via `deepFreeze()` (Rule 10).
 */

/** Configuration options for `createGameEnginePlugin()`. */
export interface GameEnginePluginConfig {
  /** Mount path for game engine REST routes. Default: `'/game'`. */
  readonly mountPath: string;

  /** WS endpoint name. Default: `'game'`. */
  readonly wsEndpoint: string;

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
