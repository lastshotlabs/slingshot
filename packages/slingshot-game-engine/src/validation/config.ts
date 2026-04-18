/**
 * Zod validation schema for `GameEnginePluginConfig`.
 *
 * Validated at plugin construction time via `validatePluginConfig()`
 * and frozen via `deepFreeze()` (Rule 10).
 *
 * @internal
 */
import { z } from 'zod';

const CleanupConfigSchema = z.object({
  completedTtl: z
    .number()
    .int()
    .nonnegative()
    .default(4 * 60 * 60 * 1000)
    .describe('Time after completion before session data is deleted (ms). Default: 4 hours.'),
  abandonedTtl: z
    .number()
    .int()
    .nonnegative()
    .default(60 * 60 * 1000)
    .describe(
      'Time after last activity before an abandoned session is deleted (ms). Default: 1 hour.',
    ),
  lobbyIdleTtl: z
    .number()
    .int()
    .nonnegative()
    .default(30 * 60 * 1000)
    .describe('Time a lobby can sit idle before cleanup (ms). Default: 30 minutes.'),
  sweepInterval: z
    .number()
    .int()
    .positive()
    .default(5 * 60 * 1000)
    .describe('How often to run the cleanup sweep (ms). Default: 5 minutes.'),
  archive: z
    .boolean()
    .default(false)
    .describe('Whether to archive session data before deletion. Default: false.'),
});

const DisconnectConfigSchema = z.object({
  gracePeriodMs: z
    .number()
    .int()
    .nonnegative()
    .default(60_000)
    .describe('Grace period before taking action on disconnect (ms). Default: 60000.'),
  maxDisconnects: z
    .number()
    .int()
    .nonnegative()
    .default(5)
    .describe('Maximum disconnects before auto-kick. 0 disables. Default: 5.'),
  pauseOnDisconnect: z
    .enum(['never', 'always', 'turn-player'])
    .default('never')
    .describe('Whether the game pauses on player disconnect. Default: never.'),
  turnBehavior: z
    .enum(['skip', 'timeout', 'auto-action', 'pause'])
    .default('skip')
    .describe("What happens to a disconnected player's turn. Default: skip."),
  autoActionHandler: z
    .string()
    .optional()
    .describe("Handler name for 'auto-action' turn behavior."),
});

const WsRateLimitConfigSchema = z.object({
  windowMs: z
    .number()
    .int()
    .positive()
    .default(1_000)
    .describe('Rolling window duration (ms). Default: 1000.'),
  maxMessages: z
    .number()
    .int()
    .positive()
    .default(30)
    .describe('Max messages per window per socket. Default: 30.'),
  onExceeded: z
    .enum(['drop', 'close'])
    .default('drop')
    .describe(
      "Action on rate limit exceeded: 'drop' silently drops, 'close' disconnects. Default: drop.",
    ),
});

const HeartbeatConfigSchema = z.object({
  intervalMs: z
    .number()
    .int()
    .positive()
    .default(30_000)
    .describe('Ping interval (ms). Default: 30000.'),
  timeoutMs: z
    .number()
    .int()
    .positive()
    .default(10_000)
    .describe('Pong timeout (ms). Default: 10000.'),
});

const RecoveryConfigSchema = z.object({
  windowMs: z
    .number()
    .int()
    .positive()
    .default(120_000)
    .describe('Recovery window (ms). Default: 120000.'),
  maxCount: z
    .number()
    .int()
    .positive()
    .default(200)
    .describe('Max messages to persist per room. Default: 200.'),
  ttlSeconds: z
    .number()
    .int()
    .positive()
    .default(3600)
    .describe('Message TTL in seconds. Default: 3600.'),
});

export const GameEnginePluginConfigSchema = z.object({
  mountPath: z
    .string()
    .startsWith('/')
    .default('/game')
    .describe('Mount path for game engine REST routes. Default: /game.'),
  wsEndpoint: z.string().default('game').describe("WS endpoint name. Default: 'game'."),
  cleanup: CleanupConfigSchema.default({
    completedTtl: 4 * 60 * 60 * 1000,
    abandonedTtl: 60 * 60 * 1000,
    lobbyIdleTtl: 30 * 60 * 1000,
    sweepInterval: 5 * 60 * 1000,
    archive: false,
  }).describe('Cleanup configuration for completed/abandoned sessions.'),
  disconnect: DisconnectConfigSchema.default({
    gracePeriodMs: 60_000,
    maxDisconnects: 5,
    pauseOnDisconnect: 'never',
    turnBehavior: 'skip',
  }).describe('Default disconnect configuration.'),
  wsRateLimit: WsRateLimitConfigSchema.default({
    windowMs: 1_000,
    maxMessages: 30,
    onExceeded: 'drop',
  }).describe('WS rate-limiting configuration (per-socket, rolling window).'),
  heartbeat: HeartbeatConfigSchema.default({
    intervalMs: 30_000,
    timeoutMs: 10_000,
  }).describe('WS heartbeat configuration.'),
  recovery: RecoveryConfigSchema.default({
    windowMs: 120_000,
    maxCount: 200,
    ttlSeconds: 3600,
  }).describe('WS message persistence and recovery configuration.'),
  disableRoutes: z
    .array(z.string())
    .default([])
    .describe('Routes to disable. Keys are entityName.operationOrAction strings.'),
});

/** Input type accepted by `createGameEnginePlugin()`. */
export type GameEnginePluginConfigInput = z.input<typeof GameEnginePluginConfigSchema>;

/** Resolved config after Zod parsing and defaults. */
export type ResolvedGameEnginePluginConfig = z.output<typeof GameEnginePluginConfigSchema>;
